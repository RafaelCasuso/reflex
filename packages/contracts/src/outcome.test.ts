import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import {
  fixtureFiles,
  loadFixture,
  summarize,
  valueOf,
  withValue,
  without,
} from "./fixtures.test-support.js";
import {
  HUMAN_RESPONSES,
  OBSERVATION_STATES,
  parseActionOutcome,
  type ActionOutcome,
  type CanonicalAction,
  type HumanResponse,
  type ObservationState,
  type ReflexDecision,
} from "./index.js";
import type { actionOutcomeSchema } from "./internal/outcome.schema.js";

const VERSION = "v1.1";
const outcome = (name: string) =>
  loadFixture(`action-outcome.${name}.json`, VERSION);

/** RFX-091 — the `ActionOutcome` contract (ADR-013). */
describe("RFX-091 ActionOutcome: shape", () => {
  it("is type-identical to the hand-written contract", () => {
    expectTypeOf<
      z.output<typeof actionOutcomeSchema>
    >().toEqualTypeOf<ActionOutcome>();
  });

  it("uses a closed, explicit vocabulary where unknown is a value", () => {
    expectTypeOf<ObservationState>().toEqualTypeOf<"yes" | "no" | "unknown">();
    expectTypeOf<HumanResponse>().toEqualTypeOf<
      "approved" | "rejected" | "none" | "unknown"
    >();
    expect(OBSERVATION_STATES).toContain("unknown");
    expect(HUMAN_RESPONSES).toContain("unknown");
  });

  it("is a separate record: neither the action nor the decision carries it", () => {
    // ADR-001 §2 keeps execution results out of the action, and a decision is
    // written before the outcome exists, by a different writer.
    for (const field of ["prompted", "humanResponse", "executed"] as const) {
      expectTypeOf<CanonicalAction>().not.toHaveProperty(field);
      expectTypeOf<ReflexDecision>().not.toHaveProperty(field);
    }
    expectTypeOf<ActionOutcome>().toHaveProperty("actionId");
  });

  it("carries no tool output and no argument values", () => {
    expectTypeOf<keyof ActionOutcome>().toEqualTypeOf<
      "actionId" | "prompted" | "humanResponse" | "executed" | "observedAt"
    >();
  });
});

describe("RFX-091 ActionOutcome: every observable case is representable", () => {
  const files = fixtureFiles(VERSION).filter((file) =>
    file.startsWith("action-outcome."),
  );

  it("has a frozen fixture for each case RFX-092 must capture", () => {
    expect(files).toEqual([
      "action-outcome.blocked-by-host.json",
      "action-outcome.executed-without-prompt.json",
      "action-outcome.no-signal.json",
      "action-outcome.prompted-approved.json",
      "action-outcome.prompted-rejected.json",
    ]);
  });

  it.each(files)("%s round-trips unchanged", (file) => {
    const wire = loadFixture(file, VERSION);
    const parsed = valueOf(parseActionOutcome(wire));
    expect(parsed).toStrictEqual(wire);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(wire));
  });

  it("represents a host that exposes no signal as unknown, not as no", () => {
    expect(valueOf(parseActionOutcome(outcome("no-signal")))).toMatchObject({
      prompted: "unknown",
      humanResponse: "unknown",
      executed: "unknown",
    });
  });

  it.each([
    ["approved but the tool then failed to run", "yes", "approved", "no"],
    ["approved, execution not observed", "yes", "approved", "unknown"],
    ["prompted, answer not observed", "yes", "unknown", "unknown"],
    ["prompted, answer not observed, but it ran", "yes", "unknown", "yes"],
    ["nothing known except that it ran", "unknown", "unknown", "yes"],
    ["not prompted, execution not observed", "no", "none", "unknown"],
  ])("accepts %s", (_label, prompted, humanResponse, executed) => {
    const input = {
      ...outcome("no-signal"),
      prompted,
      humanResponse,
      executed,
    };
    expect(parseActionOutcome(input).ok).toBe(true);
  });
});

describe("RFX-091 ActionOutcome: mandatory fields", () => {
  it.each([
    ["actionId"],
    ["prompted"],
    ["humanResponse"],
    ["executed"],
    ["observedAt"],
  ])("requires %s and never defaults it", (field) => {
    expect(
      summarize(
        parseActionOutcome(without(outcome("prompted-approved"), [field])),
      ),
    ).toEqual([`missing_field:${field}`]);
  });
});

/**
 * Adversarial. An outcome feeds the north-star metric and Approval Learning.
 * Each case tries to make an action count as something it was not.
 */
describe("RFX-091 ActionOutcome: adversarial input", () => {
  it.each([
    [
      "an answer without a question",
      { prompted: "no", humanResponse: "approved", executed: "yes" },
      "invalid_value:humanResponse",
    ],
    [
      "a rejection without a question",
      { prompted: "no", humanResponse: "rejected", executed: "no" },
      "invalid_value:humanResponse",
    ],
    [
      "a question with no possible answer",
      { prompted: "yes", humanResponse: "none", executed: "yes" },
      "invalid_value:humanResponse",
    ],
    [
      "a known answer to an unknown question",
      { prompted: "unknown", humanResponse: "approved", executed: "yes" },
      "invalid_value:humanResponse",
    ],
    [
      "an unknown question claimed as not asked",
      { prompted: "unknown", humanResponse: "none", executed: "yes" },
      "invalid_value:humanResponse",
    ],
    [
      "a rejected action that ran anyway",
      { prompted: "yes", humanResponse: "rejected", executed: "yes" },
      "invalid_value:executed",
    ],
  ])("rejects a self-contradicting record: %s", (_label, fields, expected) => {
    expect(
      summarize(parseActionOutcome({ ...outcome("no-signal"), ...fields })),
    ).toEqual([expected]);
  });

  // "unknown" must never be laundered into a definite state on the way in.
  it.each([
    ["prompted", null],
    ["prompted", false],
    ["prompted", "false"],
    ["prompted", ""],
    ["prompted", "NO"],
    ["prompted", "n/a"],
    ["executed", true],
    ["executed", 1],
    ["executed", "success"],
    ["humanResponse", "allow"],
    ["humanResponse", "approve"],
    ["humanResponse", "yes"],
    ["humanResponse", null],
  ])("does not coerce %s = %j into a known state", (field, value) => {
    const result = parseActionOutcome(
      withValue(outcome("no-signal"), [field], value),
    );
    expect(result.ok).toBe(false);
  });

  it.each([
    "toolOutput",
    "tool_response",
    "stdout",
    "arguments",
    "error",
    "effect",
    "safe",
    "mode",
    "durationMs",
  ])("rejects the undeclared field %s instead of storing it", (key) => {
    expect(
      summarize(
        parseActionOutcome({ ...outcome("prompted-approved"), [key]: "x" }),
      ),
    ).toEqual([`unrecognized_field:${key}`]);
  });

  it.each([
    ["a decision ID", "dec_01J8ZC2P0R3S5U7W9Y1A3C5E7G"],
    ["an unprefixed ID", "01J8ZC2N6Q4T7V9X3B5D8F0H2K"],
    ["an ID carrying a newline", "act_abc\nact_forged"],
    ["a host tool-use ID", "toolu_01ABC"],
  ])("keys only on a real action ID: rejects %s", (_label, actionId) => {
    expect(
      summarize(
        parseActionOutcome(
          withValue(outcome("prompted-approved"), ["actionId"], actionId),
        ),
      ),
    ).toEqual(["invalid_format:actionId"]);
  });

  it("rejects a local-time timestamp", () => {
    expect(
      summarize(
        parseActionOutcome(
          withValue(
            outcome("prompted-approved"),
            ["observedAt"],
            "2026-09-19T11:00:07+02:00",
          ),
        ),
      ),
    ).toEqual(["invalid_format:observedAt"]);
  });

  it("never echoes an input value in an issue", () => {
    const secret = "sk-live-7c1e9d2a4b6f";
    const result = parseActionOutcome({
      actionId: secret,
      prompted: secret,
      humanResponse: secret,
      executed: secret,
      observedAt: secret,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("7c1e9d2a4b6f");
  });
});
