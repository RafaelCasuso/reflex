import type {
  ActionId,
  CanonicalAction,
  Confidence,
  DecisionEffect,
  DecisionId,
  DurationMs,
  PolicyMatch,
  ReasonCode,
  ReflexDecision,
  RiskScore,
  SemanticAssessment,
  SemanticDecisionRequest,
  SideEffectClass,
} from "@reflex/contracts";
import type { SubjectSummary } from "@reflex/policy-engine";
import type {
  ProviderResult,
  SemanticDecisionProvider,
} from "@reflex/semantic-provider";

/**
 * The seams of the semantic stage (`docs/architecture.md` §3). The engine
 * orders them and owns the decision; it implements none of them.
 *
 * - `ContextCompiler` is G5 (`packages/context-compiler`). Redaction happens
 *   inside it (ADR-006): the engine hands it the raw action and sends the
 *   provider only what it returns. There is no default compiler on purpose,
 *   so that the engine can never send an argument value anywhere by itself.
 * - `SemanticDecisionProvider` is `@reflex/semantic-provider` (RFX-025): one
 *   call in, a typed result out. A provider that is down or slow is an
 *   expected outcome and comes back as a `ProviderError`; a provider that
 *   throws is a bug and is handled as `unavailable` (ADR-005 §2).
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
  /**
   * RFX-148: what the classifier saw, one entry per subject, and what the
   * project root was, straight from the policy evaluation. Absent when the
   * caller has no evaluation; the aggregator then keeps every floor.
   */
  readonly subjects?: readonly SubjectSummary[];
  readonly projectRoot?: string;
}

export interface AggregationInput {
  readonly action: CanonicalAction;
  /** What the provider was actually given: redacted, bounded (ADR-006). */
  readonly request: SemanticDecisionRequest;
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
  /** RFX-142: evaluated alongside the primary, recorded, never used. */
  readonly shadow?: readonly ShadowProvider[];
}

/**
 * RFX-142 — shadow evaluation (ADR-016 §3).
 *
 * A shadow receives the same request as the primary, concurrently, under
 * its own deadline; the decision returns when the primary is done, and
 * nothing a shadow returns or fails to return changes any field of it.
 * `unresolved` runs it where the primary runs; `all` runs it on the
 * actions policy resolved as well, which hands a model free labels and is
 * allowed only for a provider that runs on this machine (ADR-010).
 */
export type ShadowSample = "unresolved" | "all";

export interface ShadowProvider {
  readonly provider: SemanticDecisionProvider;
  /** Its own deadline, whole milliseconds. The decision never waits for it. */
  readonly deadlineMs: DurationMs;
  readonly sample: ShadowSample;
}

/** What a shadow evaluation came to, given to the observer when it settles. */
export interface ShadowObservation {
  readonly decisionId: DecisionId;
  readonly actionId: ActionId;
  readonly role: "shadow";
  readonly provider: string;
  readonly model?: string;
  /** Which kind of action it was sampled on. */
  readonly sampledOn: "unresolved" | "resolved";
  /** What it was given: the same redacted request as the primary. */
  readonly request: SemanticDecisionRequest;
  readonly result: ProviderResult;
  readonly latencyMs: DurationMs;
}

export type ShadowObserver = (observation: ShadowObservation) => void;

/**
 * RFX-143 — what a decision was made of, for the record (ADR-016 §4).
 * Given to the observer off the decision path, after the answer; the
 * shadows are promises that settle on their own deadlines and never
 * reject.
 */
export interface PrimaryEvaluation {
  readonly provider: string;
  readonly model?: string;
  readonly result: ProviderResult;
  readonly latencyMs: DurationMs;
}

export interface DecisionObservation {
  readonly decision: ReflexDecision;
  /** The request the primary was given, when one was compiled. */
  readonly request?: SemanticDecisionRequest;
  /** The primary's answer or failure, when it was asked. */
  readonly primary?: PrimaryEvaluation;
  readonly shadows: readonly Promise<ShadowObservation>[];
  /** A rule or a policy default decided: the effect is a deterministic label. */
  readonly resolvedByPolicy: boolean;
  /** RFX-125: a human overrode a deny; the effect is the human's label. */
  readonly humanOverride: boolean;
}

export type DecisionObserver = (observation: DecisionObservation) => void;
