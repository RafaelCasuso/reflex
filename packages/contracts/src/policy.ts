import type { PolicyId } from "./ids.js";
import type { DecisionEffect, DurationMs } from "./primitives.js";

/**
 * Policy contracts.
 *
 * The policy document types are carried over unchanged from the initial
 * proposal. Their runtime schema and YAML parser belong to Gate G2 (RFX-012);
 * only `PolicyMatch` is validated here, because it is part of a decision.
 */
export const POLICY_OPERATORS = [
  "equals",
  "not_equals",
  "starts_with",
  "matches",
  "in",
  "exists",
] as const;
export type PolicyOperator = (typeof POLICY_OPERATORS)[number];

export interface PolicyCondition {
  field: string;
  operator: PolicyOperator;
  value?: unknown;
}

export interface PolicyRule {
  id: string;
  name: string;
  effect: DecisionEffect;
  mandatory?: boolean;
  conditions: readonly PolicyCondition[];
}

export type PolicyUnresolvedDefault = "semantic" | "ask" | "deny";

export interface PolicyDefaults {
  unresolved: PolicyUnresolvedDefault;
}

export interface PolicyDocument {
  version: 1;
  defaults: PolicyDefaults;
  rules: readonly PolicyRule[];
}

/** One matched rule. Every policy resolution is explainable through these. */
export interface PolicyMatch {
  policyId?: PolicyId;
  ruleId: string;
  ruleName?: string;
  effect: DecisionEffect;
  mandatory: boolean;
  precedence: number;
}

export interface PolicyEvaluation {
  resolved: boolean;
  effect?: DecisionEffect;
  matches: readonly PolicyMatch[];
  latencyMs: DurationMs;
}
