import { afterAll, describe, expect, test } from "vitest";

import { loadFixture } from "./fixtures.test-support.js";
import {
  CONTRACT_LIMITS,
  parseCanonicalAction,
  parseDecisionRequest,
  parseReflexDecision,
  parseSemanticAssessment,
} from "./index.js";

/**
 * Hot-path benchmark (CLAUDE.md: "for hot-path code, benchmark before/after").
 *
 * `parseDecisionRequest` runs in front of every decision. The deterministic
 * path has a p95 budget of 10 ms end to end, so validation has to stay far
 * below that for ordinary requests and bounded for hostile ones.
 *
 * Run with `pnpm --filter @reflex-control/contracts bench`. It is not part of
 * `pnpm test`: timing assertions do not belong on shared CI runners. The
 * budgets below are deliberately loose tripwires against an algorithmic
 * regression (an accidental quadratic, a recursive validator), not
 * performance targets. Baseline numbers live in packages/contracts/README.md.
 */
const minimalRequest = loadFixture("decision-request.minimal.json");
const fullRequest = loadFixture("decision-request.full.json");
const fullAction = loadFixture("canonical-action.full.json");
const fullDecision = loadFixture("reflex-decision.full.json");
const assessment = loadFixture("semantic-assessment.json");

function requestWithArguments(args: Record<string, unknown>) {
  return {
    ...minimalRequest,
    action: {
      ...(minimalRequest.action as Record<string, unknown>),
      arguments: args,
    },
  };
}

/** ~50 KB of arguments: a realistic upper end, for example a file write. */
const largeRequest = requestWithArguments({
  path: "src/generated/schema.ts",
  content: "x".repeat(40_000),
  edits: Array.from({ length: 500 }, (_, index) => ({
    line: index,
    text: `const value${String(index)} = ${String(index)};`,
  })),
});

/** The most expensive input the contract still accepts. */
const widestRequest = requestWithArguments({
  items: Array.from({ length: CONTRACT_LIMITS.jsonNodes - 10 }, () => 0),
});

/** Hostile: far over the node limit. Must be rejected early, not walked. */
const oversizedRequest = requestWithArguments({
  items: Array.from({ length: 2_000_000 }, () => 0),
});

const invalidRequest = {
  ...fullRequest,
  mode: "bypass",
  action: { ...fullAction, sideEffectClass: "safe", tool: {} },
};

interface Case {
  readonly name: string;
  readonly run: () => unknown;
  /** Loose p99 tripwire in milliseconds. */
  readonly budgetMs: number;
}

const CASES: readonly Case[] = [
  {
    name: "decision request, minimal",
    run: () => parseDecisionRequest(minimalRequest),
    budgetMs: 1,
  },
  {
    name: "decision request, every field",
    run: () => parseDecisionRequest(fullRequest),
    budgetMs: 1,
  },
  {
    name: "decision request, ~50 KB of arguments",
    run: () => parseDecisionRequest(largeRequest),
    budgetMs: 2,
  },
  {
    name: "decision request, at the JSON node limit",
    run: () => parseDecisionRequest(widestRequest),
    budgetMs: 10,
  },
  {
    name: "decision request, 20x over the node limit (rejected)",
    run: () => parseDecisionRequest(oversizedRequest),
    budgetMs: 10,
  },
  {
    name: "decision request, invalid (issues built)",
    run: () => parseDecisionRequest(invalidRequest),
    budgetMs: 1,
  },
  {
    name: "canonical action, every field",
    run: () => parseCanonicalAction(fullAction),
    budgetMs: 1,
  },
  {
    name: "semantic assessment",
    run: () => parseSemanticAssessment(assessment),
    budgetMs: 1,
  },
  {
    name: "reflex decision, every field (adapter side)",
    run: () => parseReflexDecision(fullDecision),
    budgetMs: 1,
  },
];

interface Row {
  readonly name: string;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly samples: number;
}

describe("contract validation latency", () => {
  const rows: Row[] = [];

  // `test.for` (unlike `test.each`) passes the test context, which is where
  // Vitest exposes the `bench` fixture.
  test.for(CASES)("$name", async ({ name, run, budgetMs }, { bench }) => {
    const { latency } = await bench(name, run).run();
    rows.push({
      name,
      meanMs: latency.mean,
      p50Ms: latency.p50,
      p99Ms: latency.p99,
      samples: latency.samplesCount,
    });
    expect(latency.p99, `p99 was ${latency.p99.toFixed(4)} ms`).toBeLessThan(
      budgetMs,
    );
  });

  // The default reporter prints no statistics without a TTY, so the numbers
  // would be invisible in CI logs and in scripted runs.
  afterAll(() => {
    const width = Math.max(...rows.map((row) => row.name.length));
    const lines = rows.map(
      (row) =>
        `${row.name.padEnd(width)}  mean ${row.meanMs.toFixed(4)} ms  ` +
        `p50 ${row.p50Ms.toFixed(4)} ms  p99 ${row.p99Ms.toFixed(4)} ms  ` +
        `(${String(row.samples)} samples)`,
    );
    process.stdout.write(`\n${lines.join("\n")}\n`);
  });
});
