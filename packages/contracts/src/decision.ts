import type { CanonicalAction } from "./action.js";
import type { ActionId, DecisionId } from "./ids.js";
import type { PolicyMatch } from "./policy.js";
import type {
  Confidence,
  DecisionEffect,
  DurationMs,
  FailureMode,
  IsoTimestamp,
  ReflexMode,
  RiskScore,
} from "./primitives.js";
import type { SemanticAssessment } from "./semantic.js";

/** Open for extension: consumers ignore codes they do not know (ADR-009). */
export const REASON_CODES = [
  "explicit_allow",
  "explicit_ask",
  "explicit_deny",
  "off_task",
  "destructive",
  "irreversible",
  "external_side_effect",
  "privilege_escalation",
  "secret_access",
  "sensitive_data",
  "financial_action",
  "production_mutation",
  "unusual_scope",
  "untrusted_input",
  "policy_violation",
  "low_confidence",
  "provider_unavailable",
  "decision_timeout",
  "unsupported_action",
  "unknown_risk",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** Open for extension: consumers ignore reasons they do not know (ADR-009). */
export const FALLBACK_REASONS = [
  "timeout",
  "provider-error",
  "gateway-error",
  "invalid-input",
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

export interface DecisionRequest {
  action: CanonicalAction;
  mode: ReflexMode;
  /**
   * A requested ceiling on leniency, not an instruction (ADR-003). The engine
   * applies the stricter of this, the configured mode and the floor of the
   * action's class, so a client can ask to be treated more strictly and never
   * less.
   */
  failureMode: FailureMode;
  policySetHash?: string;
  deadlineMs?: DurationMs;
}

export interface DecisionFallback {
  used: boolean;
  reason?: FallbackReason;
  configuredMode?: FailureMode;
}

export interface DecisionLatency {
  totalMs: DurationMs;
  policyMs: DurationMs;
  contextMs?: DurationMs;
  semanticMs?: DurationMs;
  aggregationMs?: DurationMs;
}

export interface ReflexDecision {
  id: DecisionId;
  actionId: ActionId;

  /** The canonical REFLEX decision. */
  effect: DecisionEffect;
  /** What the adapter enforces under `mode`. */
  effectiveEffect: DecisionEffect;
  mode: ReflexMode;

  risk: RiskScore;
  confidence: Confidence;

  reasonCodes: readonly ReasonCode[];
  policyMatches: readonly PolicyMatch[];

  semanticAssessment?: SemanticAssessment;

  policySetHash?: string;

  cached: boolean;
  cacheKey?: string;

  fallback?: DecisionFallback;

  latency: DecisionLatency;

  decidedAt: IsoTimestamp;
}

export interface DecisionEngine {
  decide(
    request: DecisionRequest,
    signal?: AbortSignal,
  ): Promise<ReflexDecision>;
}
