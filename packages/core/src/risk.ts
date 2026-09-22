import type { ReasonCode, RiskScore, SideEffectClass } from "@reflex/contracts";

/**
 * ADR-002 §3 — `risk` when no model was involved.
 *
 * It describes the action, not the verdict: an allowed `destructive` action is
 * still risky, and a denied read is not. `unknown` sits in the middle on
 * purpose: unknown is never safe, and it is not known to be dangerous either.
 */
export const DETERMINISTIC_RISK: Readonly<Record<SideEffectClass, RiskScore>> =
  {
    none: 0,
    "local-read": 5,
    "external-read": 15,
    "local-write": 25,
    unknown: 50,
    "external-write": 60,
    privilege: 80,
    credential: 85,
    destructive: 90,
    financial: 90,
  };

export function riskOf(sideEffectClass: SideEffectClass): RiskScore {
  return DETERMINISTIC_RISK[sideEffectClass];
}

/**
 * The reason code that explains a deterministic risk. It says what kind of
 * action this is, next to the code that says why it was decided as it was.
 * A read or a local write explains itself.
 */
export function reasonForClass(
  sideEffectClass: SideEffectClass,
): ReasonCode | undefined {
  switch (sideEffectClass) {
    case "none":
    case "local-read":
    case "local-write":
      return undefined;
    case "external-read":
    case "external-write":
      return "external_side_effect";
    case "unknown":
      return "unknown_risk";
    case "privilege":
      return "privilege_escalation";
    case "credential":
      return "secret_access";
    case "destructive":
      return "destructive";
    case "financial":
      return "financial_action";
  }
}
