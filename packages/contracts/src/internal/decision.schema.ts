import { z } from "zod";

import {
  FALLBACK_REASONS,
  REASON_CODES,
  type DecisionFallback,
  type ReasonCode,
} from "../decision.js";
import { CONTRACT_LIMITS } from "../limits.js";
import {
  DECISION_EFFECTS,
  FAILURE_MODES,
  REFLEX_MODES,
} from "../primitives.js";
import { canonicalActionSchema } from "./action.schema.js";
import { policyMatchSchema } from "./policy.schema.js";
import {
  confidenceSchema,
  durationMsSchema,
  hashSchema,
  opaqueIdSchema,
  scoreSchema,
  timestampSchema,
} from "./schemas.js";
import { semanticAssessmentSummarySchema } from "./semantic.schema.js";

/** Strict: a request is an input to a safety decision. */
export const decisionRequestSchema = z.strictObject({
  action: canonicalActionSchema,
  mode: z.enum(REFLEX_MODES),
  failureMode: z.enum(FAILURE_MODES),
  policySetHash: hashSchema.exactOptional(),
  deadlineMs: z.int().min(1).exactOptional(),
});

function isKnown<Member extends string>(
  members: readonly Member[],
  value: string,
): value is Member {
  return (members as readonly string[]).includes(value);
}

const decisionFallbackSchema = z
  .object({
    used: z.boolean(),
    reason: z.string().exactOptional(),
    configuredMode: z.enum(FAILURE_MODES).exactOptional(),
  })
  // Keys are re-emitted in declaration order: parsing must not reorder the
  // wire form, or a serialized decision stops being stable to hash or sign.
  .transform(({ used, reason, configuredMode }): DecisionFallback => ({
    used,
    ...(reason !== undefined && isKnown(FALLBACK_REASONS, reason)
      ? { reason }
      : {}),
    ...(configuredMode !== undefined ? { configuredMode } : {}),
  }));

const decisionLatencySchema = z.object({
  totalMs: durationMsSchema,
  policyMs: durationMsSchema,
  contextMs: durationMsSchema.exactOptional(),
  semanticMs: durationMsSchema.exactOptional(),
  aggregationMs: durationMsSchema.exactOptional(),
});

/**
 * Tolerant, within limits (ADR-009). A decision is read by consumers that are
 * often older than the gateway that wrote it, so:
 *
 * - unknown object keys are ignored
 * - unknown members of the two informational enums (`reasonCodes`,
 *   `fallback.reason`) are dropped
 *
 * The enforcement fields are closed. An `effect`, `effectiveEffect` or `mode`
 * this reader does not know invalidates the decision, and the adapter falls
 * back according to its failure mode. An unknown effect is never coerced.
 */
export const reflexDecisionSchema = z.object({
  id: opaqueIdSchema("dec"),
  actionId: opaqueIdSchema("act"),

  effect: z.enum(DECISION_EFFECTS),
  effectiveEffect: z.enum(DECISION_EFFECTS),
  mode: z.enum(REFLEX_MODES),

  risk: scoreSchema,
  confidence: confidenceSchema,

  reasonCodes: z
    .array(z.string())
    .max(CONTRACT_LIMITS.reasonCodes)
    .transform((codes): readonly ReasonCode[] =>
      codes.filter((code) => isKnown(REASON_CODES, code)),
    ),
  policyMatches: z
    .array(policyMatchSchema)
    .max(CONTRACT_LIMITS.policyMatches)
    .readonly(),

  semanticAssessment: semanticAssessmentSummarySchema.exactOptional(),

  policySetHash: hashSchema.exactOptional(),

  cached: z.boolean(),
  cacheKey: hashSchema.exactOptional(),

  fallback: decisionFallbackSchema.exactOptional(),

  latency: decisionLatencySchema,

  decidedAt: timestampSchema,
});
