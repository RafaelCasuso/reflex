/**
 * REFLEX canonical contracts — the single source of truth.
 *
 * These contracts contain no host- or provider-specific types (ADR-001).
 *
 * The export list is explicit on purpose: it is the public surface, and
 * removing or renaming anything in it is a breaking change (ADR-009). The
 * validation library is an implementation detail and is not exported.
 */
export {
  ID_BODY_MAX_LENGTH,
  ID_PREFIXES,
  isOpaqueId,
  type ActionId,
  type AgentId,
  type DecisionId,
  type IdPrefix,
  type OpaqueId,
  type OrganizationId,
  type PolicyId,
  type ProjectId,
  type SessionId,
} from "./ids.js";

export {
  DECISION_EFFECTS,
  ENVIRONMENT_KINDS,
  FAILURE_MODES,
  HOST_KINDS,
  REFLEX_MODES,
  SIDE_EFFECT_CLASSES,
  type Confidence,
  type DecisionEffect,
  type DurationMs,
  type EnvironmentKind,
  type FailureMode,
  type HostKind,
  type IsoTimestamp,
  type ReflexMode,
  type RiskScore,
  type Score,
  type SideEffectClass,
} from "./primitives.js";

export { CONTRACT_LIMITS } from "./limits.js";

export {
  parseActionOutcome,
  parseCanonicalAction,
  parseDecisionFeedback,
  parseDecisionRequest,
  parseReflexDecision,
  parseSemanticAssessment,
} from "./parse.js";

export { CONTRACT_VERSION, type ContractVersion } from "./version.js";

export {
  MAX_VALIDATION_ISSUES,
  VALIDATION_ISSUE_CODES,
  type ValidationFailure,
  type ValidationIssue,
  type ValidationIssueCode,
  type ValidationResult,
  type ValidationSuccess,
} from "./validation.js";

export {
  resolveEnvironment,
  type ActionRepository,
  type ActionOperands,
  type ActionResource,
  type ActionTool,
  type AgentIdentity,
  type CanonicalAction,
  type CommandOperand,
  type PriorActionSummary,
} from "./action.js";

export {
  FALLBACK_REASONS,
  REASON_CODES,
  type DecisionEngine,
  type DecisionFallback,
  type DecisionLatency,
  type DecisionRequest,
  type FallbackReason,
  type ReasonCode,
  type ReflexDecision,
} from "./decision.js";

export type {
  SemanticAssessment,
  SemanticDecisionProvider,
  SemanticDecisionRequest,
  SemanticSignal,
} from "./semantic.js";

export {
  POLICY_OPERATORS,
  type PolicyAnyOfCondition,
  type PolicyCondition,
  type PolicyDefaults,
  type PolicyDocument,
  type PolicyFieldCondition,
  type PolicyEvaluation,
  type PolicyMatch,
  type PolicyNotCondition,
  type PolicyOperator,
  type PolicyRule,
  type PolicyUnresolvedDefault,
} from "./policy.js";

export {
  DECISION_FEEDBACK_VALUES,
  type DecisionFeedback,
  type DecisionFeedbackValue,
} from "./feedback.js";

export {
  HUMAN_RESPONSES,
  OBSERVATION_STATES,
  type ActionOutcome,
  type HumanResponse,
  type ObservationState,
} from "./outcome.js";
