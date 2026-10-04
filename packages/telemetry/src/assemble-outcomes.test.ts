import {
  parseActionOutcome,
  type ActionId,
  type SessionId,
} from "@reflex-control/contracts";
import { describe, expect, it } from "vitest";

import { assembleOutcomes } from "./assemble-outcomes.js";
import {
  OUTCOME_SIGNALS,
  RECORD_VERSION,
  type ObservationRecord,
  type OutcomeSignal,
} from "./records.js";

const SESSION: SessionId = "ses_a1b2c3";
const ACTION: ActionId = "act_0001";

let clock = 0;
const tick = (): string =>
  new Date(Date.UTC(2026, 8, 19, 9, 0, (clock += 1))).toISOString();

function action(
  actionId: ActionId = ACTION,
  sessionId = SESSION,
): ObservationRecord {
  return {
    kind: "action",
    recordVersion: RECORD_VERSION,
    recordedAt: tick(),
    actionId,
    sessionId,
    host: "claude-code",
    toolName: "Bash",
    sideEffectClass: "unknown",
    createdAt: "2026-09-19T09:00:00Z",
    argumentShape: { type: "object", keys: {}, otherKeys: 0 },
  };
}

function signal(
  name: OutcomeSignal,
  actionId: ActionId = ACTION,
): ObservationRecord {
  return {
    kind: "signal",
    recordVersion: RECORD_VERSION,
    recordedAt: tick(),
    actionId,
    sessionId: SESSION,
    signal: name,
  };
}

function turnEnded(sessionId: SessionId = SESSION): ObservationRecord {
  return {
    kind: "turn-ended",
    recordVersion: RECORD_VERSION,
    recordedAt: tick(),
    sessionId,
  };
}

/** RFX-092 — the four cases the ticket names, plus the honest unknowns. */
describe("RFX-092 outcome assembly", () => {
  it("executed without a prompt", () => {
    expect(assembleOutcomes([action(), signal("executed")])).toMatchObject([
      {
        actionId: ACTION,
        prompted: "no",
        humanResponse: "none",
        executed: "yes",
      },
    ]);
  });

  it("prompted and approved", () => {
    expect(
      assembleOutcomes([
        action(),
        signal("permission-requested"),
        signal("executed"),
      ]),
    ).toMatchObject([
      { prompted: "yes", humanResponse: "approved", executed: "yes" },
    ]);
  });

  it("prompted and rejected", () => {
    expect(
      assembleOutcomes([action(), signal("permission-requested"), turnEnded()]),
    ).toMatchObject([
      { prompted: "yes", humanResponse: "rejected", executed: "no" },
    ]);
  });

  it("blocked by the host, without asking the human", () => {
    expect(
      assembleOutcomes([action(), signal("denied-by-host")]),
    ).toMatchObject([
      { prompted: "no", humanResponse: "none", executed: "no" },
    ]);
  });

  it("says unknown when the action is all that was seen", () => {
    expect(assembleOutcomes([action()])).toMatchObject([
      { prompted: "unknown", humanResponse: "unknown", executed: "unknown" },
    ]);
  });

  it("does not turn a pending prompt into a rejection", () => {
    // The turn has not ended: the human may still be reading the prompt.
    expect(
      assembleOutcomes([action(), signal("permission-requested")]),
    ).toMatchObject([
      { prompted: "yes", humanResponse: "unknown", executed: "unknown" },
    ]);
  });

  it("does not read a turn that ended as 'did not run' unless a prompt was pending", () => {
    // No prompt and no completion signal: the hook may simply have missed it.
    expect(assembleOutcomes([action(), turnEnded()])).toMatchObject([
      { prompted: "unknown", humanResponse: "unknown", executed: "unknown" },
    ]);
  });

  // Verified live (RFX-087): the host reports a failure for a command that
  // ran and exited non-zero, and for no refused call. Its side effects may
  // have happened, so the dangerous reading is the true one.
  it("reads a reported failure as a call that ran", () => {
    expect(assembleOutcomes([action(), signal("failed")])).toMatchObject([
      { prompted: "no", humanResponse: "none", executed: "yes" },
    ]);
    expect(
      assembleOutcomes([
        action(),
        signal("permission-requested"),
        signal("failed"),
      ]),
    ).toMatchObject([
      { prompted: "yes", humanResponse: "approved", executed: "yes" },
    ]);
  });

  it("stamps the outcome with the last contributing signal", () => {
    const records = [
      action(),
      signal("permission-requested"),
      signal("executed"),
    ];
    const [outcome] = assembleOutcomes(records);
    expect(outcome?.observedAt).toBe(records[2]?.recordedAt);
  });

  // Adversarial: signals must not bleed between actions or sessions.
  it("keeps the signals of different actions apart", () => {
    const other: ActionId = "act_0002";
    const outcomes = assembleOutcomes([
      action(ACTION),
      action(other),
      signal("permission-requested", other),
      signal("executed", ACTION),
      turnEnded(),
    ]);
    expect(outcomes).toMatchObject([
      {
        actionId: ACTION,
        prompted: "no",
        humanResponse: "none",
        executed: "yes",
      },
      {
        actionId: other,
        prompted: "yes",
        humanResponse: "rejected",
        executed: "no",
      },
    ]);
  });

  it("ignores the end of a turn in another session", () => {
    expect(
      assembleOutcomes([
        action(),
        signal("permission-requested"),
        turnEnded("ses_another"),
      ]),
    ).toMatchObject([{ humanResponse: "unknown", executed: "unknown" }]);
  });

  it("ignores signals recorded before the action they name", () => {
    expect(assembleOutcomes([signal("executed"), action()])).toMatchObject([
      { prompted: "unknown", executed: "unknown" },
    ]);
  });

  it("never reads a turn end without a session as belonging to anyone", () => {
    const anonymous: ObservationRecord = {
      kind: "turn-ended",
      recordVersion: RECORD_VERSION,
      recordedAt: tick(),
    };
    expect(
      assembleOutcomes([action(), signal("permission-requested"), anonymous]),
    ).toMatchObject([{ humanResponse: "unknown" }]);
  });

  /**
   * Verified live (RFX-087): the host's permission event names no call. The
   * signal then carries the session and the tool, and is attributed by order.
   */
  describe("a signal that names no action", () => {
    interface Unattributed {
      readonly toolName?: string;
      readonly toolNamespace?: string;
      /** `null` is a signal from a host that named no session. */
      readonly sessionId?: SessionId | null;
    }

    const unattributed = (
      name: OutcomeSignal,
      {
        toolName = "Bash",
        toolNamespace,
        sessionId = SESSION,
      }: Unattributed = {},
    ): ObservationRecord => ({
      kind: "signal",
      recordVersion: RECORD_VERSION,
      recordedAt: tick(),
      ...(sessionId === null ? {} : { sessionId }),
      toolName,
      ...(toolNamespace === undefined ? {} : { toolNamespace }),
      signal: name,
    });

    it("goes to the latest unresolved action of that session and tool", () => {
      expect(
        assembleOutcomes([
          action(),
          unattributed("permission-requested"),
          signal("executed"),
        ]),
      ).toMatchObject([
        { prompted: "yes", humanResponse: "approved", executed: "yes" },
      ]);
    });

    it("records a refusal: the prompt, then nothing, then the end of the turn", () => {
      expect(
        assembleOutcomes([
          action(),
          unattributed("permission-requested"),
          turnEnded(),
        ]),
      ).toMatchObject([
        { prompted: "yes", humanResponse: "rejected", executed: "no" },
      ]);
    });

    it("keeps repeated identical calls apart when they run one after another", () => {
      const second: ActionId = "act_0002";
      expect(
        assembleOutcomes([
          action(ACTION),
          signal("executed", ACTION),
          action(second),
          unattributed("permission-requested"),
          signal("executed", second),
        ]),
      ).toMatchObject([
        { actionId: ACTION, prompted: "no", executed: "yes" },
        { actionId: second, prompted: "yes", humanResponse: "approved" },
      ]);
    });

    // Adversarial: a prompt must never land on an action it cannot belong to.
    it.each<[string, Unattributed]>([
      ["another session", { sessionId: "ses_other" }],
      ["another tool", { toolName: "Write" }],
      ["the same tool name from an MCP server", { toolNamespace: "evil" }],
      ["no session at all", { sessionId: null }],
    ])("is dropped when it comes from %s", (_label, from) => {
      expect(
        assembleOutcomes([
          action(),
          unattributed("permission-requested", from),
        ]),
      ).toMatchObject([
        { prompted: "unknown", humanResponse: "unknown", executed: "unknown" },
      ]);
    });

    it("never lands on an action that already completed", () => {
      expect(
        assembleOutcomes([
          action(),
          signal("executed"),
          unattributed("permission-requested"),
        ]),
      ).toMatchObject([
        { prompted: "no", humanResponse: "none", executed: "yes" },
      ]);
    });

    it("never lands on an action whose turn already ended", () => {
      expect(
        assembleOutcomes([
          action(),
          turnEnded(),
          unattributed("permission-requested"),
        ]),
      ).toMatchObject([{ prompted: "unknown" }]);
    });

    it("never lands on an action recorded after it", () => {
      expect(
        assembleOutcomes([unattributed("permission-requested"), action()]),
      ).toMatchObject([{ prompted: "unknown" }]);
    });

    it("marks one action per prompt, not every candidate", () => {
      const second: ActionId = "act_0002";
      const outcomes = assembleOutcomes([
        action(ACTION),
        action(second),
        unattributed("permission-requested"),
      ]);
      expect(
        outcomes.filter((outcome) => outcome.prompted === "yes"),
      ).toHaveLength(1);
      expect(outcomes[1]).toMatchObject({ actionId: second, prompted: "yes" });
    });
  });

  // Every combination of signals, with and without the turn ending: whatever
  // was observed, the result must be a record the contract accepts. The
  // contract rejects self-contradiction, so this is the consistency proof.
  it("produces a contract-valid outcome for every combination of signals", () => {
    const subsets = Array.from(
      { length: 2 ** OUTCOME_SIGNALS.length },
      (_, mask) =>
        OUTCOME_SIGNALS.filter((_signal, bit) => (mask & (1 << bit)) !== 0),
    );

    let checked = 0;
    for (const subset of subsets) {
      for (const ended of [false, true]) {
        const records = [
          action(),
          ...subset.map((name) => signal(name)),
          ...(ended ? [turnEnded()] : []),
        ];
        const [outcome] = assembleOutcomes(records);
        const parsed = parseActionOutcome(outcome);
        expect(
          parsed.ok,
          `${subset.join("+") || "nothing"}${ended ? " + turn ended" : ""}: ${JSON.stringify(parsed)}`,
        ).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBe(32);
  });
});
