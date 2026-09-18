import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import type { decisionFeedbackSchema } from "./internal/feedback.schema.js";
import {
  loadFixture,
  summarize,
  valueOf,
  withValue,
  without,
} from "./fixtures.test-support.js";
import {
  DECISION_FEEDBACK_VALUES,
  parseDecisionFeedback,
  type DecisionFeedback,
  type DecisionFeedbackValue,
} from "./index.js";

const minimal = () => loadFixture("decision-feedback.minimal.json");
const full = () => loadFixture("decision-feedback.full.json");

/** RFX-010 — all four feedback values supported; timestamp and ID validated. */
describe("RFX-010 DecisionFeedback", () => {
  it("is type-identical to the hand-written contract", () => {
    expectTypeOf<
      z.output<typeof decisionFeedbackSchema>
    >().toEqualTypeOf<DecisionFeedback>();
  });

  it("supports exactly the four feedback values", () => {
    expectTypeOf<DecisionFeedbackValue>().toEqualTypeOf<
      "correct" | "should-allow" | "should-ask" | "should-deny"
    >();
    expect(DECISION_FEEDBACK_VALUES).toEqual([
      "correct",
      "should-allow",
      "should-ask",
      "should-deny",
    ]);
  });

  it.each(DECISION_FEEDBACK_VALUES)("accepts the value %s", (value) => {
    expect(
      valueOf(parseDecisionFeedback(withValue(minimal(), ["value"], value)))
        .value,
    ).toBe(value);
  });

  it("round-trips minimal and full feedback unchanged", () => {
    for (const wire of [minimal(), full()]) {
      const parsed = valueOf(parseDecisionFeedback(wire));
      expect(parsed).toStrictEqual(wire);
      expect(JSON.parse(JSON.stringify(parsed))).toStrictEqual(wire);
    }
  });

  it.each([["decisionId"], ["value"], ["createdAt"]])(
    "requires %s",
    (field) => {
      expect(
        summarize(parseDecisionFeedback(without(full(), [field]))),
      ).toEqual([`missing_field:${field}`]);
    },
  );

  it.each([
    ["an action ID", "act_01J8ZC2N6Q4T7V9X3B5D8F0H2K"],
    ["an unprefixed ID", "01J8ZC2P0R3S5U7W9Y1A3C5E7G"],
    ["an ID carrying a newline", "dec_abc\ndec_forged"],
    ["an ID with path traversal", "dec_../../decisions"],
    ["an empty ID", ""],
    ["a numeric ID", 42],
  ])("validates the decision ID: rejects %s", (_label, decisionId) => {
    expect(
      summarize(
        parseDecisionFeedback(withValue(full(), ["decisionId"], decisionId)),
      ),
    ).toEqual(["invalid_format:decisionId"]);
  });

  it.each([
    ["a local offset", "2026-09-18T13:02:45+02:00", "invalid_format"],
    ["no zone", "2026-09-18T11:02:45", "invalid_format"],
    ["an impossible date", "2026-02-30T11:02:45Z", "invalid_format"],
    ["a date only", "2026-09-18", "invalid_format"],
    ["epoch milliseconds", 1_789_729_365_120, "invalid_type"],
  ])("validates the timestamp: rejects %s", (_label, createdAt, code) => {
    expect(
      summarize(
        parseDecisionFeedback(withValue(full(), ["createdAt"], createdAt)),
      ),
    ).toEqual([`${code}:createdAt`]);
  });

  // Adversarial: feedback feeds Approval Learning. A value outside the four,
  // or an extra field, must not be able to nudge a suggestion toward "allow".
  it.each([
    ["snake case", "should_allow"],
    ["a bare effect", "allow"],
    ["a synonym", "approve"],
    ["upper case", "CORRECT"],
    ["padded", "correct "],
    ["empty", ""],
    ["a boolean", true],
    ["an array of values", ["correct", "should-allow"]],
  ])("rejects a %s feedback value", (_label, value) => {
    expect(
      summarize(parseDecisionFeedback(withValue(full(), ["value"], value))),
    ).toHaveLength(1);
  });

  it.each(["weight", "applyImmediately", "effect", "policyPatch", "trusted"])(
    "rejects the unknown field %s instead of ignoring it",
    (key) => {
      expect(
        summarize(parseDecisionFeedback({ ...full(), [key]: 100 })),
      ).toEqual([`unrecognized_field:${key}`]);
    },
  );

  it("bounds the note and the actor ID", () => {
    expect(
      summarize(
        parseDecisionFeedback(withValue(full(), ["note"], "x".repeat(8_193))),
      ),
    ).toEqual(["out_of_range:note"]);
    expect(
      summarize(
        parseDecisionFeedback(withValue(full(), ["actorId"], "user\n4821")),
      ),
    ).toEqual(["invalid_format:actorId"]);
  });
});
