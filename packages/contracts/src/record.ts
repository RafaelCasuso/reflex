import type { DecisionFallback, ReasonCode } from "./decision.js";
import type { DecisionFeedback } from "./feedback.js";
import type { ActionId, DecisionId } from "./ids.js";
import type { ActionOutcome } from "./outcome.js";
import type { PolicyMatch } from "./policy.js";
import type {
  Confidence,
  DecisionEffect,
  DurationMs,
  IsoTimestamp,
  ReflexMode,
  RiskScore,
} from "./primitives.js";
import type {
  SemanticAssessment,
  SemanticDecisionRequest,
} from "./semantic.js";

/**
 * The decision record (ADR-016 §4, v1.3): the unit of training data and the
 * one record that joins what was sent, what each model answered, what
 * REFLEX decided, and what the human and the host then did.
 *
 * Every label names its source, from a closed vocabulary; a label without
 * one does not parse. Labels of different sources are never merged into
 * one. The request is the redacted `SemanticDecisionRequest` that was sent
 * (ADR-006), never the raw action; it is absent when no provider saw one.
 * An outcome and feedback are appended later, joined by `actionId` and
 * `decisionId`, and a record refuses ones that name another action or
 * decision.
 */
export const LABEL_SOURCES = [
  /** A rule or a policy default resolved it. */
  "deterministic_rule",
  /** A generator's rule (RFX-146). */
  "synthetic_rule",
  "llm_teacher",
  /** An outcome's `humanResponse`, or feedback. */
  "human",
  /** What the host did. */
  "production_outcome",
] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];

export const EVALUATION_ROLES = ["primary", "shadow"] as const;
export type EvaluationRole = (typeof EVALUATION_ROLES)[number];

/** ADR-005 §2: how a provider fails. Shared with `@reflex-control/semantic-provider`. */
export const PROVIDER_ERROR_KINDS = [
  "timeout",
  "aborted",
  "unavailable",
  "rate-limited",
  "rejected-request",
  "invalid-response",
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/** The taxonomy (ADR-016 §6): the eleven dimensions of an assessment. */
export const ASSESSMENT_DIMENSIONS = [
  "objectiveAlignment",
  "destructiveRisk",
  "reversibility",
  "externalSideEffect",
  "privilegeEscalation",
  "secretAccess",
  "sensitiveDataExposure",
  "financialConsequence",
  "productionMutation",
  "unusualScope",
  "untrustedInput",
] as const;
export type AssessmentDimension = (typeof ASSESSMENT_DIMENSIONS)[number];

export interface EffectLabel {
  kind: "effect";
  value: DecisionEffect;
  source: LabelSource;
  at: IsoTimestamp;
}

export interface DimensionLabel {
  kind: "dimension";
  dimension: AssessmentDimension;
  /** A score for a scored dimension; a boolean for `externalSideEffect`. */
  value: number | boolean;
  source: LabelSource;
  at: IsoTimestamp;
}

export type DecisionLabel = EffectLabel | DimensionLabel;

export interface RecordedEvaluationBase {
  provider: string;
  /** Pinned, never an alias (ADR-016 §1). */
  model?: string;
  role: EvaluationRole;
  /** For a shadow: which kind of action it was sampled on. */
  sampledOn?: "unresolved" | "resolved";
  latencyMs: DurationMs;
}

export interface AssessedEvaluation extends RecordedEvaluationBase {
  assessment: SemanticAssessment;
}

export interface FailedEvaluation extends RecordedEvaluationBase {
  error: { kind: ProviderErrorKind; retryable: boolean };
}

/** Exactly one of `assessment` and `error`. */
export type RecordedEvaluation = AssessedEvaluation | FailedEvaluation;

/** What REFLEX decided, without the ids, the cache and the clock. */
export interface RecordedDecision {
  effect: DecisionEffect;
  effectiveEffect: DecisionEffect;
  mode: ReflexMode;
  risk: RiskScore;
  confidence: Confidence;
  reasonCodes: readonly ReasonCode[];
  policyMatches: readonly PolicyMatch[];
  policySetHash?: string;
  fallback?: DecisionFallback;
}

export interface DecisionRecord {
  decisionId: DecisionId;
  actionId: ActionId;
  recordedAt: IsoTimestamp;
  /** `MAJOR.MINOR` of the contracts that wrote it. */
  contractVersion: string;
  request?: SemanticDecisionRequest;
  evaluations: readonly RecordedEvaluation[];
  decision: RecordedDecision;
  labels: readonly DecisionLabel[];
  outcome?: ActionOutcome;
  feedback?: readonly DecisionFeedback[];
}
