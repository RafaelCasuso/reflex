import { createHash } from "node:crypto";

import type {
  EnvironmentKind,
  PolicyCondition,
  PolicyRule,
  PolicyUnresolvedDefault,
} from "@reflex-control/contracts";

import type { PolicySource } from "./precedence.js";

/**
 * RFX-016 — one canonical form and one hash for a policy set.
 *
 * Every decision records the hash of the policy set that made it, which is
 * what makes a decision replayable. So the hash has to depend on what the
 * policies mean and on nothing else: not on comments, quoting, key order or
 * indentation, and not on the order of rules, of conditions, of `any_of`
 * branches or of `in` values either, because none of them changes a decision
 * (ADR-004: rule order never matters).
 *
 * The canonical form is also the payload a signed snapshot carries
 * (RFX-083, `snapshot.ts`): plain JSON, keys sorted, no whitespace. Signing
 * is added around it without changing it.
 *
 * RFX-084: an `environment` source names the environment it applies to.
 * The key is written only when present, so every set without one hashes as
 * it did before.
 */
export const POLICY_SET_FORMAT = 1;

export interface CanonicalSource {
  readonly source: PolicySource;
  readonly trusted: boolean;
  readonly policyId?: string;
  readonly unresolved?: PolicyUnresolvedDefault;
  /** Only on an `environment` source. */
  readonly environment?: EnvironmentKind;
  readonly rules: readonly PolicyRule[];
}

type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

/** JSON with sorted keys and no whitespace. */
function stringify(value: Json): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly Json[]).map(stringify).join(",")}]`;
  }
  const object = value as Readonly<Record<string, Json>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stringify(object[key] ?? null)}`)
    .join(",")}}`;
}

/** Sorted by canonical text, so that order never reaches the hash. */
const sorted = (values: readonly Json[]): Json[] =>
  [...values].sort((a, b) => {
    const [x, y] = [stringify(a), stringify(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  });

function canonicalCondition(condition: PolicyCondition): Json {
  if ("not" in condition) {
    return { not: canonicalCondition(condition.not) };
  }
  if ("any_of" in condition) {
    return { any_of: sorted(condition.any_of.map(canonicalCondition)) };
  }
  const value = condition.value as Json | undefined;
  return {
    field: condition.field,
    operator: condition.operator,
    ...(value === undefined
      ? {}
      : {
          value: Array.isArray(value)
            ? sorted(value as readonly Json[])
            : value,
        }),
  };
}

function canonicalRule(rule: PolicyRule): Json {
  return {
    id: rule.id,
    name: rule.name,
    effect: rule.effect,
    // Absent and `false` mean the same, so they are the same.
    mandatory: rule.mandatory === true,
    conditions: sorted(rule.conditions.map(canonicalCondition)),
  };
}

export interface CanonicalPolicySet {
  /** The canonical JSON. What a snapshot carries and what is hashed. */
  readonly payload: string;
  /** `sha256:` and 64 hexadecimal digits. */
  readonly hash: string;
}

export function canonicalizePolicySet(
  sources: readonly CanonicalSource[],
): CanonicalPolicySet {
  const payload = stringify({
    format: POLICY_SET_FORMAT,
    sources: sorted(
      sources.map((entry) => ({
        source: entry.source,
        trusted: entry.trusted,
        policyId: entry.policyId ?? null,
        unresolved: entry.unresolved ?? null,
        ...(entry.environment === undefined
          ? {}
          : { environment: entry.environment }),
        rules: sorted(entry.rules.map(canonicalRule)),
      })),
    ),
  });
  return {
    payload,
    hash: `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`,
  };
}
