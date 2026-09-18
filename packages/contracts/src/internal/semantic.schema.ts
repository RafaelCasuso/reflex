import { z } from "zod";

import type { Score } from "../primitives.js";
import type { SemanticSignal } from "../semantic.js";
import {
  confidenceSchema,
  durationMsSchema,
  nameSchema,
  scoreSchema,
} from "./schemas.js";

function signalShape<Value extends z.ZodType>(value: Value) {
  return { value, confidence: confidenceSchema };
}

/** One declaration of the dimensions, shared by both reading modes. */
function assessmentShape<
  ScoreSignal extends z.ZodType<SemanticSignal<Score>>,
  FlagSignal extends z.ZodType<SemanticSignal<boolean>>,
>(score: ScoreSignal, flag: FlagSignal) {
  return {
    objectiveAlignment: score,
    destructiveRisk: score,
    reversibility: score,
    externalSideEffect: flag,
    privilegeEscalation: score,
    secretAccess: score,
    sensitiveDataExposure: score,
    financialConsequence: score,
    productionMutation: score,
    unusualScope: score,
    untrustedInput: score,

    provider: nameSchema,
    model: nameSchema.exactOptional(),
    latencyMs: durationMsSchema,
  };
}

/**
 * Strict: this is how REFLEX reads what a provider returned, as an input to a
 * decision. A missing dimension, an out-of-range value or a provider-specific
 * extra field invalidates the whole assessment. It is never partially
 * accepted, because a partial assessment must not become an implicit allow.
 */
export const semanticAssessmentSchema = z.strictObject(
  assessmentShape(
    z.strictObject(signalShape(scoreSchema)),
    z.strictObject(signalShape(z.boolean())),
  ),
);

/**
 * Tolerant: the same assessment as read back out of a `ReflexDecision` by a
 * consumer that may be older than the gateway that wrote it (ADR-009).
 */
export const semanticAssessmentSummarySchema = z.object(
  assessmentShape(
    z.object(signalShape(scoreSchema)),
    z.object(signalShape(z.boolean())),
  ),
);
