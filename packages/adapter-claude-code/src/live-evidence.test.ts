import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assembleOutcomes,
  type ObservationRecord,
} from "@reflex-control/telemetry";
import { describe, expect, it } from "vitest";

import { readHookInput } from "./hook-input.js";
import { toObservationRecord } from "./observe.js";

/**
 * RFX-087 — what a live host did, replayed through the adapter.
 *
 * `live/verify-hook-failures.mjs` ran real headless sessions and recorded, per
 * case, whether the tool ran (a marker file on disk, not the model's word) and
 * the payloads the host sent. This suite runs offline on that record. It
 * proves two things the constructed fixtures cannot:
 *
 * 1. the failure table in `docs/claude-code-hook.md` is what the host does;
 * 2. the outcome REFLEX assembles from the host's real payloads agrees with
 *    what really happened, and never claims a blocked call ran.
 */
const RESULTS_DIR = fileURLToPath(new URL("../live/results/", import.meta.url));

type HookEventName =
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PermissionDenied"
  | "Stop";

/** The order in which the host fires them within one tool call. */
const HOST_ORDER: readonly HookEventName[] = [
  "PreToolUse",
  "PermissionRequest",
  "PermissionDenied",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
];

interface LiveCase {
  readonly id: string;
  readonly expectRan: boolean | null;
  readonly ran: boolean;
  /** `null` for a case run to find out, with no expectation set. */
  readonly matchesExpectation: boolean | null;
  readonly events: Partial<Record<HookEventName, number>>;
  readonly samples: Partial<Record<HookEventName, Record<string, unknown>>>;
}

interface LiveRecord {
  readonly ticket: string;
  readonly host: string;
  readonly results: readonly LiveCase[];
}

const recordFiles = readdirSync(RESULTS_DIR).filter((file) =>
  file.endsWith(".json"),
);

function load(file: string): { raw: string; record: LiveRecord } {
  const raw = readFileSync(join(RESULTS_DIR, file), "utf8");
  return { raw, record: JSON.parse(raw) as LiveRecord };
}

function caseOf(record: LiveRecord, id: string): LiveCase {
  const found = record.results.find((result) => result.id === id);
  if (found === undefined) {
    throw new Error(`the live record has no case "${id}"`);
  }
  return found;
}

let second = 0;
const context = {
  now: () => new Date(Date.UTC(2026, 8, 19, 10, 0, (second += 1))),
  hostVersion: "live",
};

/** The host's own payloads, through the same code the hook runs. */
function replay(live: LiveCase): ObservationRecord[] {
  return HOST_ORDER.flatMap((event) => {
    const payload = live.samples[event];
    if (payload === undefined) {
      return [];
    }
    const input = readHookInput(JSON.stringify(payload));
    expect(input.ok, `${live.id}: ${event} must be readable`).toBe(true);
    if (!input.ok) {
      return [];
    }
    const record = toObservationRecord(input.event, context);
    return record === undefined ? [] : [record];
  });
}

it("has at least one recorded host version", () => {
  expect(recordFiles.length).toBeGreaterThan(0);
});

describe.each(recordFiles)("RFX-087 live record %s", (file) => {
  const { raw, record } = load(file);

  it("was recorded for this ticket and met every expectation it set", () => {
    expect(record.ticket).toBe("RFX-087");
    expect(record.host).toMatch(/^\d+\.\d+\.\d+/);
    for (const live of record.results) {
      expect(live.matchesExpectation, live.id).toBe(
        live.expectRan === null ? null : true,
      );
    }
  });

  // The hook is in the execution path. When it breaks, the host carries on
  // without it: that is what makes Observe safe to install, and what makes a
  // broken enforcing hook an open door (ADR-010).
  it.each(["exit-1", "invalid-json", "timeout", "missing-command"])(
    "the host fails open when the hook fails: %s",
    (id) => {
      const live = caseOf(record, id);
      expect(live.ran).toBe(true);
      expect(live.events.PostToolUse).toBe(1);
    },
  );

  it("a silent hook that exits 0 changes nothing", () => {
    expect(caseOf(record, "silent-exit-0").ran).toBe(true);
  });

  it.each(["exit-2", "json-deny"])(
    "the host blocks the call, and reports no completion: %s",
    (id) => {
      const live = caseOf(record, id);
      expect(live.ran).toBe(false);
      expect(live.events.PostToolUse).toBeUndefined();
      expect(live.events.PostToolUseFailure).toBeUndefined();
      expect(live.events.PermissionDenied).toBeUndefined();
    },
  );

  it("disableAllHooks removes REFLEX from the path without a trace", () => {
    const live = caseOf(record, "hooks-disabled");
    expect(live.ran).toBe(true);
    expect(live.events).toEqual({});
  });

  it("a hook asking for approval where nobody can answer is a refusal", () => {
    const live = caseOf(record, "json-ask-headless");
    expect(live.ran).toBe(false);
    expect(live.events.PermissionRequest).toBeUndefined();
  });

  describe("the payloads the host really sends", () => {
    it("identifies the call everywhere except on the permission event", () => {
      const prompted = caseOf(record, "needs-permission-headless");
      expect(prompted.samples.PreToolUse).toHaveProperty("tool_use_id");
      expect(prompted.samples.PermissionRequest).toBeDefined();
      expect(prompted.samples.PermissionRequest).not.toHaveProperty(
        "tool_use_id",
      );
      expect(prompted.samples.PermissionRequest).toHaveProperty("session_id");
      expect(prompted.samples.PermissionRequest).toHaveProperty("tool_name");

      const executed = caseOf(record, "silent-exit-0");
      expect(executed.samples.PostToolUse).toHaveProperty("tool_use_id");
    });

    it("reports a failure for a command that ran and exited non-zero", () => {
      const live = caseOf(record, "failing-command");
      expect(live.ran).toBe(true);
      expect(live.events.PostToolUse).toBeUndefined();
      expect(live.samples.PostToolUseFailure).toMatchObject({
        is_interrupt: false,
      });
      expect(live.samples.PostToolUseFailure).toHaveProperty("tool_use_id");
      expect(live.samples.PostToolUseFailure).toHaveProperty("error");
    });
  });

  describe("the outcome REFLEX assembles from them", () => {
    it.each(record.results.map((live) => [live.id, live] as const))(
      "agrees with what the host did: %s",
      (_id, live) => {
        const outcomes = assembleOutcomes(replay(live));
        const sawTheCall = live.samples.PreToolUse !== undefined;
        expect(outcomes).toHaveLength(sawTheCall ? 1 : 0);

        for (const outcome of outcomes) {
          if (live.ran) {
            expect(outcome.executed).toBe("yes");
          } else {
            // Adversarial: a call the host blocked must never count as run.
            expect(outcome.executed).not.toBe("yes");
            expect(outcome.humanResponse).not.toBe("approved");
          }
        }
      },
    );

    it("sees a call that ran untouched as autonomous", () => {
      expect(
        assembleOutcomes(replay(caseOf(record, "silent-exit-0"))),
      ).toMatchObject([
        { prompted: "no", humanResponse: "none", executed: "yes" },
      ]);
    });

    it("sees a call that failed as one that ran", () => {
      expect(
        assembleOutcomes(replay(caseOf(record, "failing-command"))),
      ).toMatchObject([
        { prompted: "no", humanResponse: "none", executed: "yes" },
      ]);
    });

    it("sees the prompt, although the host did not say which call it was for", () => {
      expect(
        assembleOutcomes(replay(caseOf(record, "needs-permission-headless"))),
      ).toMatchObject([
        { prompted: "yes", humanResponse: "rejected", executed: "no" },
      ]);
    });

    // A call blocked by a hook leaves nothing behind: no completion, no
    // denial, no prompt. `unknown` is the only honest answer, and it is what
    // keeps a blocked call out of the autonomy rate.
    it.each(["exit-2", "json-deny", "json-ask-headless"])(
      "claims nothing about a call blocked by a hook: %s",
      (id) => {
        expect(assembleOutcomes(replay(caseOf(record, id)))).toMatchObject([
          {
            prompted: "unknown",
            humanResponse: "unknown",
            executed: "unknown",
          },
        ]);
      },
    );
  });

  // The record is checked in. It must hold nothing of the machine it ran on.
  it("holds no path, account or credential of the recording machine", () => {
    for (const forbidden of [
      /\/Users\//,
      /\/var\/folders\//,
      /\/private\//,
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/,
      /sk-ant-/,
      /Bearer\s/i,
    ]) {
      expect(raw, String(forbidden)).not.toMatch(forbidden);
    }
  });
});
