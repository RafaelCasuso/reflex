import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import {
  issuesOf,
  loadFixture,
  summarize,
  valueOf,
  withValue,
  without,
} from "./fixtures.test-support.js";
import {
  parseSemanticAssessment,
  type DecisionEffect,
  type SemanticAssessment,
  type SemanticSignal,
} from "./index.js";
import type {
  semanticAssessmentSchema,
  semanticAssessmentSummarySchema,
} from "./internal/semantic.schema.js";

const assessment = () => loadFixture("semantic-assessment.json");

const SCORE_DIMENSIONS = [
  "objectiveAlignment",
  "destructiveRisk",
  "reversibility",
  "privilegeEscalation",
  "secretAccess",
  "sensitiveDataExposure",
  "financialConsequence",
  "productionMutation",
  "unusualScope",
  "untrustedInput",
] as const;
const DIMENSIONS = [...SCORE_DIMENSIONS, "externalSideEffect"] as const;

/** RFX-009 — no provider-specific fields leak into the contract. */
describe("RFX-009 SemanticAssessment: shape", () => {
  it("is type-identical to the hand-written contract in both reading modes", () => {
    expectTypeOf<
      z.output<typeof semanticAssessmentSchema>
    >().toEqualTypeOf<SemanticAssessment>();
    expectTypeOf<
      z.output<typeof semanticAssessmentSummarySchema>
    >().toEqualTypeOf<SemanticAssessment>();
  });

  it("is evidence: it has no field that could carry a verdict", () => {
    type VerdictCarriers = {
      [Key in keyof SemanticAssessment]-?: SemanticAssessment[Key] extends
        DecisionEffect | SemanticSignal<DecisionEffect>
        ? Key
        : never;
    }[keyof SemanticAssessment];

    expectTypeOf<VerdictCarriers>().toBeNever();
    expectTypeOf<SemanticAssessment>().not.toHaveProperty("effect");
    expectTypeOf<SemanticAssessment>().not.toHaveProperty("risk");
    expectTypeOf<SemanticAssessment>().not.toHaveProperty("decision");
  });

  it("covers the dimensions of docs/architecture.md §6, each with its own confidence", () => {
    const parsed = valueOf(parseSemanticAssessment(assessment()));
    expect(parsed).toStrictEqual(assessment());
    for (const dimension of DIMENSIONS) {
      expect(parsed[dimension]).toHaveProperty("confidence");
    }
    expect(DIMENSIONS).toHaveLength(11);
  });
});

describe("RFX-009 SemanticAssessment: nothing provider-specific gets in", () => {
  it.each([
    "jevScore",
    "rawResponse",
    "prompt",
    "promptTokens",
    "completionTokens",
    "reasoning",
    "requestId",
    "temperature",
  ])("rejects the provider-specific field %s", (key) => {
    expect(
      summarize(parseSemanticAssessment({ ...assessment(), [key]: "x" })),
    ).toEqual([`unrecognized_field:${key}`]);
  });

  it("rejects provider-specific fields inside a signal", () => {
    const input = withValue(assessment(), ["destructiveRisk"], {
      value: 5,
      confidence: 0.95,
      rationale: "model said so",
      logprob: -0.01,
    });
    expect(summarize(parseSemanticAssessment(input))).toEqual([
      "unrecognized_field:destructiveRisk.logprob",
      "unrecognized_field:destructiveRisk.rationale",
    ]);
  });

  // Adversarial: "a semantic provider must never directly decide". A provider
  // (or whatever it was prompted with) trying to hand back a verdict is
  // rejected outright instead of being quietly ignored.
  it.each([
    ["effect", "allow"],
    ["decision", "allow"],
    ["safe", true],
    ["overallRisk", 0],
    ["recommendation", "auto-approve"],
  ])("rejects an attempt to return a verdict via %s", (key, value) => {
    expect(
      summarize(parseSemanticAssessment({ ...assessment(), [key]: value })),
    ).toEqual([`unrecognized_field:${key}`]);
  });
});

describe("RFX-009 SemanticAssessment: partial or malformed output is never accepted", () => {
  it.each(DIMENSIONS)("rejects an assessment without %s", (dimension) => {
    expect(
      summarize(parseSemanticAssessment(without(assessment(), [dimension]))),
    ).toEqual([`missing_field:${dimension}`]);
  });

  it.each(DIMENSIONS)("rejects %s without its own confidence", (dimension) => {
    expect(
      summarize(
        parseSemanticAssessment(
          without(assessment(), [dimension, "confidence"]),
        ),
      ),
    ).toEqual([`missing_field:${dimension}.confidence`]);
  });

  it("rejects an empty provider response", () => {
    expect(issuesOf(parseSemanticAssessment({})).length).toBeGreaterThanOrEqual(
      DIMENSIONS.length,
    );
  });

  it.each([
    ["a score above range", ["destructiveRisk", "value"], 101, "out_of_range"],
    ["a negative score", ["secretAccess", "value"], -1, "out_of_range"],
    ["a fractional score", ["unusualScope", "value"], 12.5, "invalid_type"],
    [
      "a score as a string",
      ["productionMutation", "value"],
      "4",
      "invalid_type",
    ],
    ["a null score", ["privilegeEscalation", "value"], null, "invalid_type"],
    ["a NaN score", ["untrustedInput", "value"], Number.NaN, "invalid_type"],
    [
      "a confidence above 1",
      ["reversibility", "confidence"],
      1.5,
      "out_of_range",
    ],
    [
      "a percentage confidence",
      ["objectiveAlignment", "confidence"],
      90,
      "out_of_range",
    ],
    [
      "a negative confidence",
      ["financialConsequence", "confidence"],
      -0.1,
      "out_of_range",
    ],
    [
      "a stringly boolean",
      ["externalSideEffect", "value"],
      "false",
      "invalid_type",
    ],
    ["a numeric boolean", ["externalSideEffect", "value"], 0, "invalid_type"],
    [
      "a bare number instead of a signal",
      ["destructiveRisk"],
      5,
      "invalid_type",
    ],
    ["an empty provider name", ["provider"], "", "out_of_range"],
    ["a negative latency", ["latencyMs"], -5, "out_of_range"],
  ])("rejects %s", (_label, path, value, code) => {
    expect(
      summarize(parseSemanticAssessment(withValue(assessment(), path, value))),
    ).toEqual([`${code}:${path.join(".")}`]);
  });
});
