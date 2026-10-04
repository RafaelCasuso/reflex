import type { CanonicalAction } from "@reflex-control/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HISTORY_LIMITS,
  SessionMemory,
  historyEntryOf,
  selectRelevantHistory,
  type HistoryEntry,
} from "./history.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const at = (minutesAgo: number): string =>
  new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const current: CanonicalAction = {
  id: "act_00000000000000000000000000000099",
  agent: { host: "claude-code" },
  tool: { name: "Edit" },
  arguments: { file_path: "/work/project/src/date.ts" },
  operands: { paths: ["/work/project/src/date.ts"] },
  sideEffectClass: "local-write",
  createdAt: NOW.toISOString(),
};

const entry = (
  toolName: string,
  minutesAgo: number,
  extra: Partial<HistoryEntry> = {},
): HistoryEntry => ({ toolName, occurredAt: at(minutesAgo), ...extra });

describe("RFX-032 relevant-history selector", () => {
  it("keeps the most recent items and the ones about the same tool or thing, newest last", () => {
    const history = [
      entry("Bash", 25, { operation: "pnpm install" }),
      entry("Edit", 20, { resource: "/work/project/src/other.ts" }),
      entry("Read", 15, { resource: "/work/project/src/date.ts" }),
      entry("Bash", 10, { operation: "pnpm test" }),
      entry("WebFetch", 5),
      entry("Bash", 2, { operation: "git status" }),
      entry("Grep", 1),
    ];
    const selected = selectRelevantHistory(history, current, NOW);
    expect(selected.map((item) => item.toolName)).toEqual([
      "Edit", // same tool
      "Read", // same file
      "WebFetch", // recent
      "Bash", // recent
      "Grep", // recent
    ]);
    const times = selected.map((item) => Date.parse(item.occurredAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("stays bounded however long the session is", () => {
    const history = Array.from({ length: 5_000 }, (_, index) =>
      entry(index % 2 === 0 ? "Edit" : "Bash", 5_000 - index > 30 ? 0.1 : 0),
    );
    const selected = selectRelevantHistory(history, current, NOW);
    expect(selected.length).toBeLessThanOrEqual(
      DEFAULT_HISTORY_LIMITS.maxItems,
    );
    expect(selected.length).toBe(DEFAULT_HISTORY_LIMITS.maxItems);
  });

  it("forgets what is older than the window, related or not", () => {
    const history = [entry("Edit", 120), entry("Edit", 60), entry("Edit", 1)];
    expect(selectRelevantHistory(history, current, NOW)).toHaveLength(1);
  });

  it("relates by MCP namespace as well", () => {
    const mcp: CanonicalAction = {
      ...current,
      tool: { name: "save_note", namespace: "notes" },
      arguments: {},
    };
    delete (mcp as { operands?: unknown }).operands;
    const history = [
      entry("list_notes", 20, { toolNamespace: "notes" }),
      entry("Bash", 19),
      entry("Bash", 18),
      entry("Bash", 17),
      entry("Bash", 16),
    ];
    expect(
      selectRelevantHistory(history, mcp, NOW).map((item) => item.toolName),
    ).toEqual(["list_notes", "Bash", "Bash", "Bash"]);
  });

  it("hands the provider summaries and nothing more: no resource, no namespace", () => {
    const [item] = selectRelevantHistory(
      [
        entry("Edit", 1, {
          resource: "/secret/place",
          toolNamespace: "x",
          operation: "op",
          effect: "allow",
        }),
      ],
      current,
      NOW,
    );
    expect(item).toEqual({
      toolName: "Edit",
      operation: "op",
      effect: "allow",
      occurredAt: at(1),
    });
  });

  it("builds an entry from a decided action", () => {
    expect(historyEntryOf(current, "allow")).toEqual({
      actionId: current.id,
      toolName: "Edit",
      effect: "allow",
      resource: "/work/project/src/date.ts",
      occurredAt: current.createdAt,
    });
  });
});

describe("RFX-032 session memory", () => {
  const session = "ses_00000000000000000000000000000001";

  it("remembers per session, bounded per session", () => {
    const memory = new SessionMemory({
      maxSessions: 10,
      maxPerSession: 3,
      sessionTtlMs: 1_000,
    });
    for (let index = 0; index < 10; index += 1) {
      memory.remember(
        session,
        entry("Bash", 0, { operation: String(index) }),
        index,
      );
    }
    expect(memory.recall(session, 10).map((item) => item.operation)).toEqual([
      "7",
      "8",
      "9",
    ]);
  });

  it("forgets a session after its TTL, and the oldest sessions when full", () => {
    const memory = new SessionMemory({
      maxSessions: 2,
      maxPerSession: 5,
      sessionTtlMs: 100,
    });
    memory.remember("ses_a", entry("Bash", 0), 0);
    memory.remember("ses_b", entry("Bash", 0), 1);
    memory.remember("ses_c", entry("Bash", 0), 2);
    expect(memory.sessions).toBe(2);
    expect(memory.recall("ses_a", 3)).toEqual([]);
    expect(memory.recall("ses_c", 3)).toHaveLength(1);
    expect(memory.recall("ses_c", 200)).toEqual([]);
  });

  it("refuses limits that keep nothing", () => {
    expect(
      () =>
        new SessionMemory({
          maxSessions: 0,
          maxPerSession: 1,
          sessionTtlMs: 1,
        }),
    ).toThrow(RangeError);
  });
});
