import type {
  CanonicalAction,
  Confidence,
  DecisionEffect,
  DurationMs,
  PolicyMatch,
  ReasonCode,
  RiskScore,
  SemanticAssessment,
  SemanticDecisionProvider,
  SemanticDecisionRequest,
  SideEffectClass,
} from "@reflex/contracts";

/**
 * The seams of the semantic stage (`docs/architecture.md` §3). The engine
 * orders them and owns the decision; it implements none of them.
 *
 * - `ContextCompiler` is G5 (`packages/context-compiler`). Redaction happens
 *   inside it (ADR-006): the engine hands it the raw action and sends the
 *   provider only what it returns. There is no default compiler on purpose,
 *   so that the engine can never send an argument value anywhere by itself.
 * - `SemanticDecisionProvider` is G4. Until RFX-025 moves it and gives it a
 *   typed result, it is the contract's interface: a rejected promise is a
 *   provider failure and is handled as `provider-error`, or as `timeout` when
 *   the deadline had passed (ADR-005 §2).
 * - `RiskAggregator` is G6. The assessment is evidence; the aggregator turns
 *   it into an effect, a risk and a confidence. The engine then applies what
 *   the aggregator may not go under: the floor an untrusted policy set
 *   (ADR-012), and `deny > ask > allow`.
 */
export interface ContextBudget {
  readonly maxInputTokens: number;
  readonly deadlineMs: DurationMs;
}

export interface ContextCompiler {
  compile(
    action: CanonicalAction,
    budget: ContextBudget,
  ): SemanticDecisionRequest;
}

export interface AggregationPolicyInput {
  readonly matches: readonly PolicyMatch[];
  /** ADR-012: an untrusted `ask` that left the action unresolved. */
  readonly floor: DecisionEffect | undefined;
  readonly sideEffectClass: SideEffectClass;
}

export interface AggregationInput {
  readonly action: CanonicalAction;
  readonly assessment: SemanticAssessment;
  readonly policy: AggregationPolicyInput;
}

export interface Aggregation {
  readonly effect: DecisionEffect;
  readonly risk: RiskScore;
  readonly confidence: Confidence;
  readonly reasonCodes: readonly ReasonCode[];
}

export interface RiskAggregator {
  aggregate(input: AggregationInput): Aggregation;
}

export interface SemanticStage {
  readonly provider: SemanticDecisionProvider;
  readonly compiler: ContextCompiler;
  readonly aggregator: RiskAggregator;
  /** CLAUDE.md principle 9: the median target is under 600 tokens. */
  readonly maxInputTokens: number;
}
