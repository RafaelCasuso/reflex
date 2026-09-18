import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import type {
  decisionRequestSchema,
  reflexDecisionSchema,
} from "./internal/decision.schema.js";
import {
  issuesOf,
  loadFixture,
  summarize,
  valueOf,
  withValue,
  without,
  type JsonRecord,
} from "./fixtures.test-support.js";
import {
  parseDecisionRequest,
  parseReflexDecision,
  type DecisionRequest,
  type ReflexDecision,
  type ValidationResult,
} from "./index.js";

const request = () => loadFixture("decision-request.full.json");
const decision = () => loadFixture("reflex-decision.full.json");

/** RFX-008 — serialization round-trip tests pass. */
describe("RFX-008 schema and interface agree", () => {
  it("is type-identical to the hand-written contracts", () => {
    expectTypeOf<
      z.output<typeof decisionRequestSchema>
    >().toEqualTypeOf<DecisionRequest>();
    expectTypeOf<
      z.output<typeof reflexDecisionSchema>
    >().toEqualTypeOf<ReflexDecision>();
  });
});

describe("RFX-008 serialization round-trips", () => {
  const cases: readonly (readonly [
    string,
    (input: unknown) => ValidationResult<unknown>,
  ])[] = [
    ["decision-request.minimal.json", parseDecisionRequest],
    ["decision-request.full.json", parseDecisionRequest],
    ["reflex-decision.minimal.json", parseReflexDecision],
    ["reflex-decision.full.json", parseReflexDecision],
  ];

  it.each(cases)(
    "%s survives parse -> JSON -> parse unchanged",
    (file, parse) => {
      const wire = loadFixture(file);

      const parsed = valueOf(parse(wire));
      // Nothing added, dropped, renamed or coerced on the way in.
      expect(parsed).toStrictEqual(wire);

      const reserialized: unknown = JSON.parse(JSON.stringify(parsed));
      expect(reserialized).toStrictEqual(wire);

      // Parsing is idempotent.
      expect(valueOf(parse(reserialized))).toStrictEqual(parsed);
    },
  );

  it("keeps the wire form stable byte for byte", () => {
    for (const [file, parse] of cases) {
      const wire = loadFixture(file);
      expect(JSON.stringify(valueOf(parse(wire)))).toBe(JSON.stringify(wire));
    }
  });
});

describe("RFX-008 DecisionRequest is read strictly", () => {
  it("reports problems in the nested action under the action. prefix", () => {
    const input = withValue(
      without(request(), ["action", "tool", "name"]),
      ["action", "sideEffectClass"],
      "harmless",
    );
    expect(summarize(parseDecisionRequest(input))).toEqual([
      "invalid_value:action.sideEffectClass",
      "missing_field:action.tool.name",
    ]);
  });

  it.each([
    [["action"], "action"],
    [["mode"], "mode"],
    [["failureMode"], "failureMode"],
  ])("requires %j", (path, reported) => {
    expect(summarize(parseDecisionRequest(without(request(), path)))).toEqual([
      `missing_field:${reported}`,
    ]);
  });

  // Adversarial: every one of these tries to talk the gateway into a softer
  // posture than the caller is entitled to.
  it.each([
    ["an unknown mode", ["mode"], "bypass", "invalid_value:mode"],
    ["a capitalised mode", ["mode"], "Observe", "invalid_value:mode"],
    [
      "an unknown failure mode",
      ["failureMode"],
      "fail-allow",
      "invalid_value:failureMode",
    ],
    [
      "a boolean failure mode",
      ["failureMode"],
      false,
      "invalid_value:failureMode",
    ],
    ["a zero deadline", ["deadlineMs"], 0, "out_of_range:deadlineMs"],
    ["a negative deadline", ["deadlineMs"], -1, "out_of_range:deadlineMs"],
    ["a fractional deadline", ["deadlineMs"], 1.5, "invalid_type:deadlineMs"],
    [
      "an infinite deadline",
      ["deadlineMs"],
      Number.POSITIVE_INFINITY,
      "invalid_type:deadlineMs",
    ],
    [
      "a policy hash with a newline",
      ["policySetHash"],
      "sha256:abc\ndef",
      "invalid_format:policySetHash",
    ],
  ])("rejects %s", (_label, path, value, expected) => {
    expect(
      summarize(parseDecisionRequest(withValue(request(), path, value))),
    ).toEqual([expected]);
  });

  it.each(["skipSemantic", "trusted", "effect", "policy", "dryRun"])(
    "rejects the unknown request field %s instead of ignoring it",
    (key) => {
      expect(
        summarize(parseDecisionRequest({ ...request(), [key]: true })),
      ).toEqual([`unrecognized_field:${key}`]);
    },
  );
});

describe("RFX-008 ReflexDecision is read tolerantly, within limits", () => {
  it("ignores fields added by a newer gateway", () => {
    const newer = withValue(
      { ...decision(), explanation: "added in a later minor" },
      ["latency", "queueMs"],
      4,
    );
    expect(valueOf(parseReflexDecision(newer))).toStrictEqual(decision());
  });

  it("ignores fields a newer gateway adds to nested objects", () => {
    const newer = [
      [["semanticAssessment", "dataResidency"], { value: 12, confidence: 0.4 }],
      [["policyMatches", "0", "source"], "org"],
      [["fallback", "retryAfterMs"], 50],
    ].reduce<JsonRecord>(
      (wire, [path, value]) => withValue(wire, path as string[], value),
      decision(),
    );
    expect(valueOf(parseReflexDecision(newer))).toStrictEqual(decision());
  });

  it("drops reason codes it does not know and keeps the ones it does", () => {
    const newer = withValue(
      decision(),
      ["reasonCodes"],
      ["external_side_effect", "rate_limited", "low_confidence"],
    );
    expect(valueOf(parseReflexDecision(newer)).reasonCodes).toEqual([
      "external_side_effect",
      "low_confidence",
    ]);
  });

  it("drops a fallback reason it does not know, keeping the rest", () => {
    const newer = withValue(
      decision(),
      ["fallback", "reason"],
      "quota-exceeded",
    );
    expect(valueOf(parseReflexDecision(newer)).fallback).toStrictEqual({
      used: true,
      configuredMode: "fail-ask",
    });
  });

  // Adversarial: tolerance stops at enforcement. An adapter that does not
  // understand the verdict must fall back, never guess.
  it.each([
    ["effect", "allow_once"],
    ["effect", "ALLOW"],
    ["effect", "allow "],
    ["effect", true],
    ["effect", null],
    ["effectiveEffect", "allow_once"],
    ["effectiveEffect", ""],
    ["mode", "shadow"],
  ])("rejects a decision whose %s is %j", (field, value) => {
    const result = parseReflexDecision(withValue(decision(), [field], value));
    expect(issuesOf(result).map((issue) => issue.path)).toEqual([field]);
  });

  it.each([
    ["effect"],
    ["effectiveEffect"],
    ["mode"],
    ["id"],
    ["actionId"],
    ["risk"],
    ["confidence"],
    ["reasonCodes"],
    ["policyMatches"],
    ["cached"],
    ["latency"],
    ["decidedAt"],
  ])("requires %s and never substitutes a default", (field) => {
    expect(
      summarize(parseReflexDecision(without(decision(), [field]))),
    ).toEqual([`missing_field:${field}`]);
  });

  it.each([
    ["risk above range", ["risk"], 101, "out_of_range:risk"],
    ["fractional risk", ["risk"], 61.5, "invalid_type:risk"],
    ["risk as a string", ["risk"], "62", "invalid_type:risk"],
    ["confidence above range", ["confidence"], 1.2, "out_of_range:confidence"],
    [
      "confidence on the risk scale",
      ["confidence"],
      71,
      "out_of_range:confidence",
    ],
    [
      "fractional latency",
      ["latency", "policyMs"],
      0.4,
      "invalid_type:latency.policyMs",
    ],
    [
      "negative latency",
      ["latency", "totalMs"],
      -1,
      "out_of_range:latency.totalMs",
    ],
    [
      "an action ID where a decision ID belongs",
      ["id"],
      "act_01J8ZC2N6Q4T7V9X3B5D8F0H2M",
      "invalid_format:id",
    ],
    [
      "a decision ID where an action ID belongs",
      ["actionId"],
      "dec_01J8ZC2P0R3S5U7W9Y1A3C5E7H",
      "invalid_format:actionId",
    ],
    [
      "a local-time timestamp",
      ["decidedAt"],
      "2026-09-18T12:15:31+02:00",
      "invalid_format:decidedAt",
    ],
    [
      "an unknown effect inside a policy match",
      ["policyMatches"],
      [{ ruleId: "r", effect: "permit", mandatory: false, precedence: 1 }],
      "invalid_value:policyMatches[0].effect",
    ],
    [
      "an unknown configured failure mode",
      ["fallback", "configuredMode"],
      "fail-allow",
      "invalid_value:fallback.configuredMode",
    ],
    [
      "an assessment missing a dimension",
      ["semanticAssessment"],
      { provider: "p", latencyMs: 1 },
      "missing_field:semanticAssessment.destructiveRisk",
    ],
  ])("rejects %s", (_label, path, value, expected) => {
    expect(
      summarize(parseReflexDecision(withValue(decision(), path, value))),
    ).toContain(expected);
  });
});
