import { arch, cpus, platform, release } from "node:os";

import { afterAll, describe, expect, test } from "vitest";

import { classifyCommand } from "./classify.js";

/**
 * RFX-096 — what parsing and classifying a command costs.
 *
 * Run with `pnpm --filter @reflex/command-classifier bench`. Not part of
 * `pnpm test`: timing does not belong on shared CI runners. The assertion is a
 * loose tripwire against an accidental quadratic, not a target; the numbers
 * for the named benchmark machine are recorded in docs/backlog.md.
 *
 * This runs once per governed shell command, inside the deterministic budget
 * of 10 ms that the whole policy evaluation has to fit in.
 */
const RUNS = 2_000;
const WARMUP = 200;

const CASES: readonly (readonly [string, string])[] = [
  ["typical", "git status --short"],
  ["pipeline", "pnpm test --filter web 2>&1 | tail -20"],
  [
    "compound",
    "cd packages/web && rm -rf dist coverage && pnpm build && git add -A && git commit -m 'build: refresh'",
  ],
  [
    "nested",
    `sudo env FOO=1 bash -c "find . -name '*.log' -exec rm {} + && echo $(date) >> cleanup.log"`,
  ],
  [
    "here-document, 200 lines",
    `cat > notes.md <<'EOF'\n${Array.from({ length: 200 }, (_, index) => `line ${String(index)}: rm -rf ~ is only text here`).join("\n")}\nEOF`,
  ],
  [
    "long chain, 200 commands",
    Array.from(
      { length: 200 },
      (_, index) => `echo "step ${String(index)}"`,
    ).join(" && "),
  ],
];

describe("parse and classify", () => {
  const rows: string[] = [];

  afterAll(() => {
    const cpu = cpus()[0]?.model ?? "unknown CPU";
    process.stdout.write(
      [
        "",
        `machine: ${cpu}, ${platform()} ${release()} ${arch()}, node ${process.version}`,
        `runs: ${String(RUNS)} per case after ${String(WARMUP)} warm-up`,
        ...rows,
        "",
      ].join("\n"),
    );
  });

  test.for(CASES)("%s", ([label, command]) => {
    const samples: number[] = [];
    for (let run = 0; run < WARMUP + RUNS; run += 1) {
      const started = performance.now();
      classifyCommand(command);
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
      `${label.padEnd(28)} ${String(command.length).padStart(6)} chars  p50 ${at(0.5).toFixed(4)} ms  p95 ${at(0.95).toFixed(4)} ms  max ${at(1).toFixed(3)} ms`,
    );
    expect(at(0.95)).toBeLessThan(5);
  });
});
