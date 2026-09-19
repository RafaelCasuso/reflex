import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ObservationLog } from "./observation-log.js";
import { RECORD_VERSION, type ObservationRecord } from "./records.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-log-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function record(index: number, padding = 0): ObservationRecord {
  return {
    kind: "action",
    recordVersion: RECORD_VERSION,
    recordedAt: new Date(Date.UTC(2026, 8, 19, 9, 0, 0, index)).toISOString(),
    actionId: `act_${String(index).padStart(6, "0")}`,
    host: "claude-code",
    toolName: `Tool${"x".repeat(padding)}`,
    sideEffectClass: "unknown",
    createdAt: "2026-09-19T09:00:00Z",
    argumentShape: { type: "object", keys: {}, otherKeys: 0 },
  };
}

const ids = (records: readonly ObservationRecord[]): string[] =>
  records.map((entry) =>
    entry.kind === "turn-ended" ? "-" : (entry.actionId ?? "unattributed"),
  );

/** RFX-086 — a local, size-bounded log that can never hurt the host. */
describe("RFX-086 observation log", () => {
  it("appends one JSON object per line and reads them back in order", async () => {
    const log = new ObservationLog({ directory: join(root, "observe") });
    for (const index of [1, 2, 3]) {
      expect(await log.append(record(index))).toEqual({ ok: true });
    }

    const lines = (await readFile(log.activeFile, "utf8"))
      .trimEnd()
      .split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      record(1),
      record(2),
      record(3),
    ]);
    expect(ids(await log.readRecent(2))).toEqual(["act_000002", "act_000003"]);
  });

  it("keeps the log private to the user", async () => {
    const log = new ObservationLog({ directory: join(root, "observe") });
    await log.append(record(1));

    expect((await stat(log.activeFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "observe"))).mode & 0o777).toBe(0o700);
  });

  it("rotates at the size limit and keeps a bounded number of files", async () => {
    const directory = join(root, "observe");
    const log = new ObservationLog({
      directory,
      maxBytes: 2_000,
      keepFiles: 2,
    });
    for (let index = 0; index < 60; index += 1) {
      await log.append(record(index, 200));
    }

    const files = (await readdir(directory)).sort();
    expect(files).toEqual([
      "observations.1.jsonl",
      "observations.2.jsonl",
      "observations.jsonl",
    ]);

    let total = 0;
    for (const file of files) {
      total += (await stat(join(directory, file))).size;
    }
    // Three files of at most the limit plus one record each.
    expect(total).toBeLessThan(3 * (2_000 + 600));

    // The newest records survive, the oldest are gone, order is preserved.
    const recent = ids(await log.readRecent(1_000));
    expect(recent.at(-1)).toBe("act_000059");
    expect(recent).not.toContain("act_000000");
    expect([...recent].sort()).toEqual(recent);
  });

  // Hosts run tool calls in parallel, so hook processes append concurrently.
  it("keeps every record whole under concurrent appends", async () => {
    const directory = join(root, "observe");
    // One log instance per append, like one hook process per tool call.
    await Promise.all(
      Array.from({ length: 400 }, (_, index) =>
        new ObservationLog({ directory }).append(record(index, 300)),
      ),
    );

    const lines = (
      await readFile(join(directory, "observations.jsonl"), "utf8")
    )
      .trimEnd()
      .split("\n");
    expect(lines).toHaveLength(400);
    // Every line parses: no record was interleaved with another.
    const seen = new Set(
      lines.map((line) => (JSON.parse(line) as { actionId: string }).actionId),
    );
    expect(seen.size).toBe(400);
  });

  // Adversarial: the caller is a hook inside someone's tool call.
  it("reports failure instead of throwing when it cannot write", async () => {
    const blocker = join(root, "not-a-directory");
    await writeFile(blocker, "a file where the directory should be");
    const log = new ObservationLog({ directory: join(blocker, "observe") });

    await expect(log.append(record(1))).resolves.toEqual({
      ok: false,
      reason: "write-failed",
    });
  });

  it("skips lines it cannot read instead of failing the whole read", async () => {
    const directory = join(root, "observe");
    const log = new ObservationLog({ directory });
    await log.append(record(1));
    await writeFile(
      log.activeFile,
      `${await readFile(log.activeFile, "utf8")}{"kind":"action","truncated by a cra\n\nnot json at all\n{"unrelated":true}\n`,
    );
    await log.append(record(2));

    expect(ids(await log.readRecent(10))).toEqual(["act_000001", "act_000002"]);
  });

  it("reads an empty history when nothing was ever recorded", async () => {
    const log = new ObservationLog({ directory: join(root, "never-created") });
    expect(await log.readRecent(10)).toEqual([]);
  });
});
