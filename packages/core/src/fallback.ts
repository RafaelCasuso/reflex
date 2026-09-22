import type {
  DecisionEffect,
  FailureMode,
  FallbackReason,
  ReasonCode,
  SideEffectClass,
} from "@reflex/contracts";

/**
 * RFX-020 — the failure-mode engine (ADR-003).
 *
 * Three things say how lenient a fallback may be, and the strictest wins:
 * what the client requested, what is configured, and the floor of the
 * action's class. A client can ask to be treated more strictly and never
 * less, so `fail-open` for a destructive action cannot be expressed.
 */
const STRICTNESS: Readonly<Record<FailureMode, number>> = {
  "fail-open": 0,
  "fail-ask": 1,
  "fail-closed": 2,
};

/** ADR-003 §1: with nothing configured. */
export const DEFAULT_FAILURE_MODE: FailureMode = "fail-ask";

/**
 * ADR-003 §2: the most lenient fallback each class may have. `external-read`
 * is on the strict side because a read that leaves the machine can carry data
 * out in its URL. `unknown` is never safe.
 */
export const FAILURE_MODE_CEILING: Readonly<
  Record<SideEffectClass, FailureMode>
> = {
  none: "fail-open",
  "local-read": "fail-open",
  "local-write": "fail-ask",
  "external-read": "fail-ask",
  "external-write": "fail-ask",
  destructive: "fail-ask",
  financial: "fail-ask",
  privilege: "fail-ask",
  credential: "fail-ask",
  unknown: "fail-ask",
};

export function strictestFailureMode(
  modes: readonly FailureMode[],
): FailureMode {
  let strictest: FailureMode = "fail-open";
  for (const mode of modes) {
    if (STRICTNESS[mode] > STRICTNESS[strictest]) {
      strictest = mode;
    }
  }
  return strictest;
}

export interface FailureModeInput {
  /** `DecisionRequest.failureMode`: a ceiling on leniency, not an instruction. */
  readonly requested: FailureMode;
  /** Resolved from configuration like policy: the most restrictive source wins. */
  readonly configured: FailureMode;
  /** After classification, so that a raised class raises the floor with it. */
  readonly sideEffectClass: SideEffectClass;
}

export function resolveFailureMode(input: FailureModeInput): FailureMode {
  return strictestFailureMode([
    input.requested,
    input.configured,
    FAILURE_MODE_CEILING[input.sideEffectClass],
  ]);
}

/**
 * What a fallback decides.
 *
 * `fail-open` is not an allow (ADR-003 §2): it means defer to the host, and
 * the adapter emits nothing so that REFLEX failing never makes the host more
 * permissive than it was. The effect it carries is `ask`, which is what "the
 * host's own flow decides" means (ADR-002), and the adapter tells the two
 * apart by `fallback.configuredMode`. A consumer that does not look can at
 * worst prompt.
 */
export function fallbackEffect(mode: FailureMode): DecisionEffect {
  switch (mode) {
    case "fail-open":
    case "fail-ask":
      return "ask";
    case "fail-closed":
      return "deny";
  }
}

/** ADR-003 §5: a fallback is never silent; this is the code it carries. */
export function fallbackReasonCode(reason: FallbackReason): ReasonCode {
  switch (reason) {
    case "timeout":
      return "decision_timeout";
    case "provider-error":
    case "gateway-error":
      return "provider_unavailable";
    case "invalid-input":
      return "unsupported_action";
  }
}
