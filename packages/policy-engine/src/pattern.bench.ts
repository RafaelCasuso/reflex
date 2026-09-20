import { arch, cpus, platform, release } from "node:os";

import { afterAll, describe, expect, test } from "vitest";

import { PATTERN_LIMITS, compilePattern } from "./pattern.js";

/**
 * RFX-098 — what the worst pattern costs on the worst text.
 *
 * Run with `pnpm --filter @reflex/policy-engine bench`. Not part of
 * `pnpm test`: timing does not belong on shared CI runners. The numbers for
 * the named benchmark machine are recorded in docs/backlog.md under RFX-098.
 *
 * Every pattern here is catastrophic for a backtracking engine. The text is as
 * long as the budget covers (`budgetedTextLength`) and built to keep as many
 * states of the pattern alive as possible.
 */
const RUNS = 200;
const WARMUP = 20;
const DETERMINISTIC_BUDGET_MS = 10;

const longest = PATTERN_LIMITS.budgetedTextLength;
const CASES: readonly (readonly [string, string])[] = [
  ["(a+)+$", `${"a".repeat(longest - 1)}!`],
  ["(a|aa)+$", `${"a".repeat(longest - 1)}!`],
  ["(a|a?)+$", `${"a".repeat(longest - 1)}!`],
  ["(.*a){12}", `${"a".repeat(longest - 1)}!`],
  ["^(([a-z])+.)+[A-Z]([a-z])+$", `${"a".repeat(longest - 1)}!`],
  ["(\\w+\\s*)+$", `${"word ".repeat(longest / 5 - 1)}!`],
  // A realistic one, for scale: a token pattern on an ordinary command.
  [
    "\\bgh[pousr]_[A-Za-z0-9]{36}\\b",
    "curl -H 'Authorization: Bearer sk-live-5e8b1f0a9c3d' https://example.test/api",
  ],
];

describe("bounded patterns, worst case", () => {
  const rows: string[] = [];

  afterAll(() => {
    const cpu = cpus()[0]?.model ?? "unknown CPU";
    process.stdout.write(
      [
        "",
        `machine: ${cpu}, ${platform()} ${release()} ${arch()}, node ${process.version}`,
        `runs: ${String(RUNS)} per case after ${String(WARMUP)} warm-up; text of ${String(longest)} characters unless noted`,
        ...rows,
        "",
      ].join("\n"),
    );
  });

  test.for(CASES)("%s", ([source, text]) => {
    const compiled = compilePattern(source);
    if (!compiled.ok) {
      throw new Error(compiled.message);
    }
    const samples: number[] = [];
    for (let run = 0; run < WARMUP + RUNS; run += 1) {
      const started = performance.now();
      compiled.pattern.test(text);
      if (run >= WARMUP) {
        samples.push(performance.now() - started);
      }
    }
    samples.sort((a, b) => a - b);
    const at = (fraction: number): number =>
      samples[
        Math.min(samples.length - 1, Math.ceil(fraction * samples.length) - 1)
      ] ?? 0;
    rows.push(
      `${source.padEnd(34)} size ${String(compiled.pattern.programSize).padStart(3)}  text ${String(text.length).padStart(5)}  p50 ${at(0.5).toFixed(3)} ms  p95 ${at(0.95).toFixed(3)} ms  max ${at(1).toFixed(3)} ms`,
    );
    // A tripwire, not a target: one evaluation of the worst pattern on the
    // worst text the budget covers has to fit in the deterministic budget.
    expect(at(0.95)).toBeLessThan(DETERMINISTIC_BUDGET_MS);
  });
});
