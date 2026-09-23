import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SEED_CORPUS_DIRECTORY, readCorpusDirectory } from "@reflex/evals";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { describe, expect, it } from "vitest";

import { createContextCompiler } from "./compile.js";
import { createRedactor } from "./redact.js";
import { estimateTokens, stateOf } from "./token-budget.js";

/**
 * RFX-033, RFX-034 — the median compiled context stays under the budget,
 * measured with a named tokenizer.
 *
 * The named tokenizer is `gpt-tokenizer`'s o200k_base. The provider counts
 * with its own: on the request RFX-107 recorded, TypeSafe reported 1,669
 * input tokens where o200k counts 1,148, a ratio of 1.45. Both numbers are
 * reported, and the budget is held on the stricter one.
 *
 * The corpus is the deterministic seed corpus of `packages/evals`: 79
 * canonical actions, 58 of them dangerous, the actions the engine is held
 * against. Every one goes through the compiler with an empty history and
 * no hints, which is what the daemon has today.
 */
const BUDGET = 600;
const TYPESAFE_PER_O200K = 1.45;

const RECORD = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../provider-jev/live/results/jev-1.13.0.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as {
  sample: { request: { state: unknown; questions: unknown } };
  variants: { id: string; inputTokensPerAction: number }[];
};

function corpusActions() {
  const loaded = readCorpusDirectory(SEED_CORPUS_DIRECTORY);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join("\n"));
  }
  return loaded.cases.map((entry) => entry.action);
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

describe("the token budget against the seed corpus", () => {
  const compiler = createContextCompiler({
    redactor: createRedactor({ key: Buffer.alloc(32, 1) }),
    clock: () => new Date("2026-09-23T12:00:00.000Z"),
  });
  const actions = corpusActions();
  const measured = actions.map((action) => {
    const report = compiler.compileWithReport(action, {
      maxInputTokens: BUDGET,
      deadlineMs: 500,
    });
    const state = JSON.stringify(stateOf(report.request));
    return {
      o200k: countTokens(state),
      estimate: estimateTokens(stateOf(report.request)),
      truncated: report.truncated.length > 0,
    };
  });

  it("has the corpus it says it has", () => {
    expect(actions.length).toBeGreaterThanOrEqual(79);
  });

  it("keeps the median under the budget with the named tokenizer, and with the provider's count", () => {
    const o200k = median(measured.map((entry) => entry.o200k));
    expect(o200k).toBeLessThan(BUDGET);
    expect(Math.ceil(o200k * TYPESAFE_PER_O200K)).toBeLessThan(BUDGET);
  });

  it("keeps every case under the budget as estimated, truncating the few that need it", () => {
    for (const entry of measured) {
      expect(entry.estimate).toBeLessThanOrEqual(BUDGET);
    }
    // The seed corpus is commands and file edits: little to cut.
    expect(
      measured.filter((entry) => entry.truncated).length,
    ).toBeLessThanOrEqual(3);
  });

  it("estimates conservatively: never under the named tokenizer by more than a tenth, never over by more than half", () => {
    for (const entry of measured) {
      expect(entry.estimate).toBeGreaterThanOrEqual(entry.o200k * 0.9);
      expect(entry.estimate).toBeLessThanOrEqual(entry.o200k * 1.5 + 4);
    }
  });

  it("is calibrated against what the provider counted on the recorded request", () => {
    const whole = countTokens(JSON.stringify(RECORD.sample.request));
    const oneCall = RECORD.variants.find(
      (variant) => variant.id === "one-call",
    );
    expect(oneCall).toBeDefined();
    const ratio = (oneCall?.inputTokensPerAction ?? 0) / whole;
    expect(ratio).toBeGreaterThan(1.3);
    expect(ratio).toBeLessThan(TYPESAFE_PER_O200K + 0.05);
    // The state the probe sent, which is what the budget governs.
    expect(
      countTokens(JSON.stringify(RECORD.sample.request.state)),
    ).toBeLessThan(BUDGET);
  });

  it("reports the numbers the document quotes", () => {
    const o200k = measured.map((entry) => entry.o200k).sort((a, b) => a - b);
    const p95 =
      o200k[Math.min(o200k.length - 1, Math.ceil(0.95 * o200k.length) - 1)] ??
      0;
    process.stdout.write(
      `\nseed corpus, ${String(actions.length)} actions: median ${String(median(o200k))} o200k tokens (about ${String(Math.ceil(median(o200k) * TYPESAFE_PER_O200K))} as the provider counts), p95 ${String(p95)}, max ${String(o200k[o200k.length - 1] ?? 0)}\n`,
    );
    expect(o200k.length).toBe(actions.length);
  });
});
