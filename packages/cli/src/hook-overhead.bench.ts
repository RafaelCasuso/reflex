import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * RFX-088 — what one governed tool call costs, as the host experiences it.
 *
 * The host starts a new process per hook call, so the honest number is wall
 * clock from "spawn" to "exit", with a real payload on stdin: process start,
 * module loading, payload parse, translation, record, exit.
 *
 * Run with `pnpm --filter @reflex/cli bench`. Not part of `pnpm test`: timing
 * does not belong on shared CI runners. The single assertion is a loose
 * tripwire (an accidental heavy import on the hook path), not a target.
 * Baseline numbers and their reading against the budgets in `CLAUDE.md` are in
 * docs/claude-code-hook.md.
 */
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const FIXTURES = fileURLToPath(
  new URL(
    "../../adapter-claude-code/fixtures/claude-code-2.1/",
    import.meta.url,
  ),
);
const RUNS = 60;
const WARMUP = 5;

function once(
  args: readonly string[],
  stdin: string,
  home: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, [...args], {
      env: { ...process.env, REFLEX_HOME: home },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("close", () => {
      resolve(Number(process.hrtime.bigint() - started) / 1e6);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}

async function measure(
  args: readonly string[],
  stdin: string,
  home: string,
): Promise<{ p50: number; p95: number; min: number }> {
  const samples: number[] = [];
  for (let run = 0; run < WARMUP + RUNS; run += 1) {
    const elapsed = await once(args, stdin, home);
    if (run >= WARMUP) {
      samples.push(elapsed);
    }
  }
  samples.sort((a, b) => a - b);
  const at = (fraction: number): number =>
    samples[
      Math.min(samples.length - 1, Math.ceil(fraction * samples.length) - 1)
    ] ?? 0;
  return { p50: at(0.5), p95: at(0.95), min: samples[0] ?? 0 };
}

const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.json`), "utf8");

describe("hook overhead, end to end", () => {
  let home: string;
  const rows: string[] = [];

  beforeAll(async () => {
    if (!existsSync(BIN)) {
      throw new Error(`${BIN} does not exist. Run "pnpm build" first.`);
    }
    home = await mkdtemp(join(tmpdir(), "reflex-bench-"));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
    const cpu = cpus()[0]?.model ?? "unknown CPU";
    process.stdout.write(
      [
        "",
        `machine: ${cpu}, ${platform()} ${release()} ${arch()}, node ${process.version}`,
        `runs: ${String(RUNS)} per case after ${String(WARMUP)} warm-up, sequential`,
        ...rows,
        "",
      ].join("\n"),
    );
  });

  const CASES = [
    {
      name: "floor: an empty Node process",
      args: ["-e", "0"],
      stdin: "",
      budgetMs: 1_000,
    },
    {
      name: "hook: PreToolUse (translate, shape, record)",
      args: [BIN, "hook", "claude-code"],
      stdin: fixture("pre-tool-use.bash"),
      budgetMs: 1_000,
    },
    {
      name: "hook: PostToolUse (signal, record)",
      args: [BIN, "hook", "claude-code"],
      stdin: fixture("post-tool-use.bash"),
      budgetMs: 1_000,
    },
    {
      name: "hook: an event it ignores",
      args: [BIN, "hook", "claude-code"],
      stdin: '{"hook_event_name":"SessionStart"}',
      budgetMs: 1_000,
    },
  ] as const;

  test.for(CASES)(
    "$name",
    { timeout: 120_000 },
    async ({ name, args, stdin, budgetMs }) => {
      const result = await measure(args, stdin, home);
      rows.push(
        `${name.padEnd(46)} min ${result.min.toFixed(1).padStart(6)} ms   p50 ${result.p50.toFixed(1).padStart(6)} ms   p95 ${result.p95.toFixed(1).padStart(6)} ms`,
      );
      expect(result.p95).toBeLessThan(budgetMs);
    },
  );
});
