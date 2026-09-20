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
  /** v1.2 (RFX-097): the path is inside this directory, after normalization. */
  "path_within",
] as const;
export type PolicyOperator = (typeof POLICY_OPERATORS)[number];

export interface PolicyFieldCondition {
  field: string;
  operator: PolicyOperator;
  value?: unknown;
}

/** v1.2 (RFX-097): true when at least one of the conditions is. */
export interface PolicyAnyOfCondition {
  any_of: readonly PolicyCondition[];
}

/** v1.2 (RFX-097): true when the condition is not. */
export interface PolicyNotCondition {
  not: PolicyCondition;
}

/**
 * The conditions of a rule all have to hold. Inside them, `any_of` and `not`
 * compose (RFX-097).
 */
export type PolicyCondition =
  PolicyFieldCondition | PolicyAnyOfCondition | PolicyNotCondition;

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
  /**
   * Optional on purpose (ADR-004 §6). A source that declares no default is not
   * a source that declares `ask`: across sources the most restrictive declared
   * value applies, and a filled-in default would be counted as a declaration.
   */
  defaults?: PolicyDefaults;
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
