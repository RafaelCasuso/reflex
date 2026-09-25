import {
  PROVIDER_ERROR_KINDS,
  type DurationMs,
  type FallbackReason,
  type ProviderErrorKind,
  type SemanticAssessment,
  type SemanticDecisionRequest,
} from "@reflex/contracts";

/**
 * RFX-025 — the provider interface (ADR-005).
 *
 * A provider assesses. It never decides, mutates or executes. One call in,
 * one result out, with a deadline and an `AbortSignal`; how many requests
 * an assessment takes, batching, connection reuse, the wording of questions
 * and the provider's own answer shapes stay inside the provider.
 *
 * `evaluate` never rejects for an expected outcome (CLAUDE.md: domain
 * outcomes return typed result objects). A provider that is down, slow,
 * rate-limited or wrong is an expected outcome. A thrown exception is a bug
 * in the provider; core treats it as `unavailable` and reports it.
 */
/**
 * The kinds, from the contracts (v1.3, where a decision record names them):
 * `timeout` (the provider's own deadline passed), `aborted` (the caller's
 * signal fired), `unavailable` (down, unreachable, overloaded, or a bug
 * that threw), `rate-limited`, `rejected-request` (authentication,
 * validation), `invalid-response` (partial, malformed, wrong model).
 */
export { PROVIDER_ERROR_KINDS, type ProviderErrorKind };

export interface ProviderError {
  readonly kind: ProviderErrorKind;
  readonly providerName: string;
  readonly latencyMs: DurationMs;
  /** Information for background callers. The decision path never retries. */
  readonly retryable: boolean;
}

export type ProviderResult =
  | { readonly ok: true; readonly assessment: SemanticAssessment }
  | { readonly ok: false; readonly error: ProviderError };

export interface SemanticDecisionProvider {
  readonly providerName: string;
  /** The versioned model this provider asks, pinned, never an alias. */
  readonly model?: string;
  /**
   * True when the provider runs on this machine and nothing it is given
   * leaves it (ADR-010). ADR-016 §3 lets only such a provider see, as a
   * shadow, the actions policy resolved. Absent reads as false.
   */
  readonly onMachine?: boolean;

  evaluate(
    request: SemanticDecisionRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult>;
}

/** ADR-005 §2: how a provider failure reaches the decision (ADR-003 §3). */
export function fallbackReasonOf(error: ProviderError): FallbackReason {
  switch (error.kind) {
    case "timeout":
    case "aborted":
      return "timeout";
    case "unavailable":
    case "rate-limited":
    case "rejected-request":
    case "invalid-response":
      return "provider-error";
  }
}

/** Whether a background caller may try again. Never on the decision path. */
export function isRetryable(kind: ProviderErrorKind): boolean {
  switch (kind) {
    case "unavailable":
    case "rate-limited":
    case "timeout":
      return true;
    case "aborted":
    case "rejected-request":
    case "invalid-response":
      return false;
  }
}

export function providerError(
  kind: ProviderErrorKind,
  providerName: string,
  latencyMs: number,
): ProviderError {
  return {
    kind,
    providerName,
    latencyMs: Math.max(0, Math.round(latencyMs)),
    retryable: isRetryable(kind),
  };
}
