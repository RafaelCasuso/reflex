import type { CanonicalAction } from "./action.js";
import type { Confidence, DurationMs, RiskScore, Score } from "./primitives.js";

/**
 * Semantic assessment contracts.
 *
 * An assessment is evidence. It never carries an effect: the aggregator owns
 * the decision (CLAUDE.md). Every dimension is independent and carries its own
 * confidence, so that no provider can compress the judgment into a single
 * "is this safe?" answer.
 */
export interface SemanticSignal<T> {
  value: T;
  confidence: Confidence;
}

export interface SemanticAssessment {
  /** `0..100`, higher is better aligned with the user objective. */
  objectiveAlignment: SemanticSignal<Score>;
  destructiveRisk: SemanticSignal<RiskScore>;
  /** `0..100`, higher is easier to reverse. */
  reversibility: SemanticSignal<Score>;
  externalSideEffect: SemanticSignal<boolean>;
  privilegeEscalation: SemanticSignal<RiskScore>;
  secretAccess: SemanticSignal<RiskScore>;
  sensitiveDataExposure: SemanticSignal<RiskScore>;
  financialConsequence: SemanticSignal<RiskScore>;
  productionMutation: SemanticSignal<RiskScore>;
  unusualScope: SemanticSignal<RiskScore>;
  untrustedInput: SemanticSignal<RiskScore>;

  /** Which provider produced this. A name, never a provider-shaped payload. */
  provider: string;
  model?: string;
  latencyMs: DurationMs;
}

/**
 * What a provider is given. Fields are selected by name: identity, tenancy,
 * working directory and `adapterMetadata` are deliberately absent
 * (ADR-001 §3, CLAUDE.md principle 9).
 */
export interface SemanticDecisionRequest {
  action: Pick<
    CanonicalAction,
    | "userObjective"
    | "taskSummary"
    | "tool"
    | "operation"
    | "arguments"
    | "resource"
    | "sideEffectClass"
    | "repository"
    | "priorActions"
  >;
  policyHints?: readonly string[];
  maxInputTokens: number;
  deadlineMs: DurationMs;
}

/**
 * A provider assesses. It never decides, mutates or executes.
 *
 * Whether this interface ultimately lives here or in
 * `packages/semantic-provider` is for ADR-005 to settle before Gate G4.
 */
export interface SemanticDecisionProvider {
  readonly providerName: string;

  evaluate(
    request: SemanticDecisionRequest,
    signal?: AbortSignal,
  ): Promise<SemanticAssessment>;
}
