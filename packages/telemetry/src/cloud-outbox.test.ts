import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DecisionSummary,
  IngestEntry,
  ProjectId,
} from "@reflex-control/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CloudOutbox } from "./cloud-outbox.js";

/**
 * ADR-019 §4 — the outbox is in order, bounded, survives a cut line and a
 * restart, and never moves its cursor on its own.
 */
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "reflex-outbox-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const PROJECT: ProjectId = "prj_00112233445566778899aabbccddeeff";

function summary(index: number): DecisionSummary {
  return {
    decisionId: `dec_${String(index).padStart(6, "0")}`,
    actionId: `act_${String(index).padStart(6, "0")}`,
    agentId: "agt_0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    projectId: PROJECT,
    decidedAt: "2026-10-10T10:00:00.000Z",
    action: {
      host: "claude-code",
      toolName: "Bash",
      sideEffectClass: "local-read",
      environment: "unknown",
    },
    effect: "allow",
    effectiveEffect: "allow",
    mode: "autopilot",
    risk: 5,
    confidence: 1,
    reasonCodes: ["explicit_allow"],
    matchedRuleIds: ["allow-reads"],
    cached: false,
    latency: { totalMs: 1, policyMs: 1 },
  };
}

const entry = (index: number): IngestEntry => ({
  kind: "decision",
  summary: summary(index),
});

const ids = (batch: { entries: readonly IngestEntry[] }): string[] =>
  batch.entries.map((item) =>
    item.kind === "decision" ? item.summary.decisionId : item.kind,
  );

describe("ADR-019 cloud outbox", () => {
  it("hands back what was appended, in order, and only after the cursor", async () => {
    const outbox = new CloudOutbox({ directory });
    for (const index of [1, 2, 3]) {
      expect(await outbox.append(entry(index))).toEqual({ ok: true });
    }
    const first = await outbox.peek(2);
    expect(ids(first)).toEqual(["dec_000001", "dec_000002"]);
    expect(await outbox.pending()).toBe(3);

    // Peeking again without acknowledging hands back the same entries.
    expect(ids(await outbox.peek(2))).toEqual(["dec_000001", "dec_000002"]);

    await outbox.acknowledge(first.cursor);
    expect(ids(await outbox.peek(10))).toEqual(["dec_000003"]);
    expect(await outbox.pending()).toBe(1);
  });

  it("keeps the cursor across a restart", async () => {
    const first = new CloudOutbox({ directory });
    await first.append(entry(1));
    await first.append(entry(2));
    await first.acknowledge((await first.peek(1)).cursor);

    const second = new CloudOutbox({ directory });
    expect(ids(await second.peek(10))).toEqual(["dec_000002"]);
  });

  it("never moves the cursor back", async () => {
    const outbox = new CloudOutbox({ directory });
    await outbox.append(entry(1));
    await outbox.append(entry(2));
    const both = await outbox.peek(2);
    await outbox.acknowledge(both.cursor);
    await outbox.acknowledge(0);
    expect(ids(await outbox.peek(10))).toEqual([]);
  });

  it("skips a line that is not an entry and a line cut short by a crash", async () => {
    const outbox = new CloudOutbox({ directory });
    await outbox.append(entry(1));
    await appendFile(outbox.file, "not json\n");
    await appendFile(
      outbox.file,
      '{"kind":"decision","summary":{"decisionId":"dec_x"}}\n',
    );
    await appendFile(outbox.file, '{"kind":"decision","sum');
    // Mid-line: the cut line is not handed back, and is not skipped yet.
    expect(ids(await outbox.peek(10))).toEqual(["dec_000001"]);
    // The next append terminates it, so that the new entry is not swallowed.
    await outbox.append(entry(2));
    const batch = await outbox.peek(10);
    expect(ids(batch)).toEqual(["dec_000001", "dec_000002"]);
    await outbox.acknowledge(batch.cursor);
    expect(await outbox.pending()).toBe(0);
  });

  it("is bounded: the oldest unsent entries are dropped and counted", async () => {
    const lineBytes = Buffer.byteLength(`${JSON.stringify(entry(1))}\n`);
    const outbox = new CloudOutbox({ directory, maxBytes: lineBytes * 3 });
    for (const index of [1, 2, 3, 4, 5]) {
      await outbox.append(entry(index));
    }
    expect(outbox.dropped).toBe(2);
    expect(ids(await outbox.peek(10))).toEqual([
      "dec_000003",
      "dec_000004",
      "dec_000005",
    ]);
    expect((await stat(outbox.file)).size).toBeLessThanOrEqual(lineBytes * 3);
  });

  it("counts acknowledged entries as room, not as backlog", async () => {
    const lineBytes = Buffer.byteLength(`${JSON.stringify(entry(1))}\n`);
    const outbox = new CloudOutbox({ directory, maxBytes: lineBytes * 2 });
    await outbox.append(entry(1));
    await outbox.append(entry(2));
    await outbox.acknowledge((await outbox.peek(2)).cursor);
    await outbox.append(entry(3));
    await outbox.append(entry(4));
    expect(outbox.dropped).toBe(0);
    expect(ids(await outbox.peek(10))).toEqual(["dec_000003", "dec_000004"]);
  });

  it("reclaims acknowledged bytes once they are worth reclaiming", async () => {
    const outbox = new CloudOutbox({ directory });
    const big: IngestEntry = {
      kind: "decision",
      summary: { ...summary(1), matchedRuleIds: ["r".repeat(200)] },
    };
    // Past the compaction threshold: the file as a long run of appends would
    // leave it, written at once so that the test costs milliseconds.
    await mkdir(directory, { recursive: true });
    await writeFile(outbox.file, `${JSON.stringify(big)}\n`.repeat(6_000), {
      mode: 0o600,
    });
    const before = (await stat(outbox.file)).size;
    expect(before).toBeGreaterThan(1024 * 1024);
    let batch = await outbox.peek(1_000);
    while (batch.entries.length > 0) {
      await outbox.acknowledge(batch.cursor);
      batch = await outbox.peek(1_000);
    }
    expect((await stat(outbox.file)).size).toBe(0);
    expect(JSON.parse(await readFile(outbox.cursorFile, "utf8"))).toEqual({
      version: 1,
      offset: 0,
    });
    await outbox.append(entry(7));
    expect(ids(await outbox.peek(10))).toEqual(["dec_000007"]);
  });

  it("appends the line it was given and nothing else", async () => {
    const outbox = new CloudOutbox({ directory });
    await outbox.append(entry(1));
    const text = await readFile(outbox.file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text.trim())).toEqual(entry(1));
    expect((await stat(outbox.file)).mode & 0o777).toBe(0o600);
  });
});
