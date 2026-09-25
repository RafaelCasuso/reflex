import { z } from "zod";

import { FALLBACK_REASONS, REASON_CODES } from "../decision.js";
import { CONTRACT_LIMITS } from "../limits.js";
import {
  DECISION_EFFECTS,
  FAILURE_MODES,
  REFLEX_MODES,
  SIDE_EFFECT_CLASSES,
} from "../primitives.js";
import {
  ASSESSMENT_DIMENSIONS,
  EVALUATION_ROLES,
  LABEL_SOURCES,
  PROVIDER_ERROR_KINDS,
  type RecordedEvaluation,
} from "../record.js";
import {
  actionRepositorySchema,
  actionResourceSchema,
  actionToolSchema,
  priorActionSummarySchema,
} from "./action.schema.js";
import { decisionFeedbackSchema } from "./feedback.schema.js";
import { actionOutcomeSchema } from "./outcome.schema.js";
import { policyMatchSchema } from "./policy.schema.js";
import {
  confidenceSchema,
  durationMsSchema,
  hashSchema,
  jsonObjectSchema,
  nameSchema,
  opaqueIdSchema,
  scoreSchema,
  textSchema,
  timestampSchema,
} from "./schemas.js";
import { semanticAssessmentSchema } from "./semantic.schema.js";

/**
 * Strict at every level: a record is training data and an audit trail, and
 * what it does not understand it refuses rather than keeps.
 */
const CONTRACT_VERSION_FORM = /^\d+\.\d+$/;

/** The request as it was sent: the fields a provider is given, nothing else. */
export const semanticDecisionRequestSchema = z.strictObject({
  action: z.strictObject({
    userObjective: textSchema.exactOptional(),
    taskSummary: textSchema.exactOptional(),
    tool: actionToolSchema,
    operation: nameSchema.exactOptional(),
    arguments: jsonObjectSchema,
    resource: actionResourceSchema.exactOptional(),
    sideEffectClass: z.enum(SIDE_EFFECT_CLASSES),
    repository: actionRepositorySchema.exactOptional(),
    priorActions: z
      .array(priorActionSummarySchema)
      .max(CONTRACT_LIMITS.priorActions)
      .readonly()
      .exactOptional(),
  }),
  policyHints: z
    .array(textSchema)
    .max(CONTRACT_LIMITS.policyMatches)
    .readonly()
    .exactOptional(),
  maxInputTokens: z.int().min(1),
  deadlineMs: z.int().min(1),
});

const labelBase = {
  source: z.enum(LABEL_SOURCES),
  at: timestampSchema,
};

export const decisionLabelSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("effect"),
    value: z.enum(DECISION_EFFECTS),
    ...labelBase,
  }),
  z
    .strictObject({
      kind: z.literal("dimension"),
      dimension: z.enum(ASSESSMENT_DIMENSIONS),
      value: z.union([scoreSchema, z.boolean()]),
      ...labelBase,
    })
    .check((context) => {
      const { dimension, value } = context.value;
      const flag = dimension === "externalSideEffect";
      if (flag !== (typeof value === "boolean")) {
        context.issues.push({
          code: "custom",
          input: context.value,
          path: ["value"],
          params: {
            reflexCode: "invalid_type",
            expected: flag
              ? "a boolean for externalSideEffect"
              : "a score for a scored dimension",
          },
        });
      }
    }),
]);

export const recordedEvaluationSchema = z
  .strictObject({
    provider: nameSchema,
    model: nameSchema.exactOptional(),
    role: z.enum(EVALUATION_ROLES),
    sampledOn: z.enum(["unresolved", "resolved"]).exactOptional(),
    latencyMs: durationMsSchema,
    assessment: semanticAssessmentSchema.exactOptional(),
    error: z
      .strictObject({
        kind: z.enum(PROVIDER_ERROR_KINDS),
        retryable: z.boolean(),
      })
      .exactOptional(),
  })
  .check((context) => {
    const { assessment, error } = context.value;
    if ((assessment === undefined) === (error === undefined)) {
      context.issues.push({
        code: "custom",
        input: context.value,
        path: [assessment === undefined ? "assessment" : "error"],
        params: {
          reflexCode:
            assessment === undefined ? "missing_field" : "invalid_value",
          expected: "exactly one of assessment or error",
        },
      });
    }
  })
  // Exactly one is present past the check; the type says so too. Keys keep
  // their declaration order, so a serialized record stays stable to hash.
  .transform((value): RecordedEvaluation => {
    const base = {
      provider: value.provider,
      ...(value.model === undefined ? {} : { model: value.model }),
      role: value.role,
      ...(value.sampledOn === undefined ? {} : { sampledOn: value.sampledOn }),
      latencyMs: value.latencyMs,
    };
    return value.assessment !== undefined
      ? { ...base, assessment: value.assessment }
      : {
          ...base,
          error: value.error ?? { kind: "unavailable", retryable: true },
        };
  });

const recordedDecisionSchema = z.strictObject({
  effect: z.enum(DECISION_EFFECTS),
  effectiveEffect: z.enum(DECISION_EFFECTS),
  mode: z.enum(REFLEX_MODES),
  risk: scoreSchema,
  confidence: confidenceSchema,
  reasonCodes: z
    .array(z.enum(REASON_CODES))
    .max(CONTRACT_LIMITS.reasonCodes)
    .readonly(),
  policyMatches: z
    .array(policyMatchSchema)
    .max(CONTRACT_LIMITS.policyMatches)
    .readonly(),
  policySetHash: hashSchema.exactOptional(),
  fallback: z
    .strictObject({
      used: z.boolean(),
      reason: z.enum(FALLBACK_REASONS).exactOptional(),
      configuredMode: z.enum(FAILURE_MODES).exactOptional(),
    })
    .exactOptional(),
});

export const decisionRecordSchema = z
  .strictObject({
    decisionId: opaqueIdSchema("dec"),
    actionId: opaqueIdSchema("act"),
    recordedAt: timestampSchema,
    contractVersion: z.string().max(16).regex(CONTRACT_VERSION_FORM),
    request: semanticDecisionRequestSchema.exactOptional(),
    evaluations: z
      .array(recordedEvaluationSchema)
      .max(CONTRACT_LIMITS.recordEvaluations)
      .readonly(),
    decision: recordedDecisionSchema,
    labels: z
      .array(decisionLabelSchema)
      .max(CONTRACT_LIMITS.recordLabels)
      .readonly(),
    outcome: actionOutcomeSchema.exactOptional(),
    feedback: z
      .array(decisionFeedbackSchema)
      .max(CONTRACT_LIMITS.recordFeedback)
      .readonly()
      .exactOptional(),
  })
  .check((context) => {
    // Joined by id: an outcome of another action or feedback on another
    // decision is not this record's and is refused, never kept.
    const { actionId, decisionId, outcome, feedback } = context.value;
    if (outcome !== undefined && outcome.actionId !== actionId) {
      context.issues.push({
        code: "custom",
        input: context.value,
        path: ["outcome", "actionId"],
        params: {
          reflexCode: "invalid_value",
          expected: "the record's own actionId",
        },
      });
    }
    for (const [index, entry] of (feedback ?? []).entries()) {
      if (entry.decisionId !== decisionId) {
        context.issues.push({
          code: "custom",
          input: context.value,
          path: ["feedback", index, "decisionId"],
          params: {
            reflexCode: "invalid_value",
            expected: "the record's own decisionId",
          },
        });
      }
    }
  });
