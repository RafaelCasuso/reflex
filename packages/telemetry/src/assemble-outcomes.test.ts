import {
  parseActionOutcome,
  type ActionId,
  type SessionId,
} from "@reflex/contracts";
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

  it("leaves executed unknown when the host only reports a failure", () => {
    expect(assembleOutcomes([action(), signal("failed")])).toMatchObject([
      { prompted: "no", humanResponse: "none", executed: "unknown" },
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
