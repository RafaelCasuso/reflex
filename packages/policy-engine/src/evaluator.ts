import type {
  CanonicalAction,
  DecisionEffect,
  PolicyCondition,
  PolicyDocument,
  PolicyEvaluation,
  PolicyId,
  PolicyUnresolvedDefault,
  SideEffectClass,
} from "@reflex/contracts";

import { canonicalizePolicySet } from "./canonical.js";
import { ruleMatches, type MatchContext } from "./matcher.js";
import { builtInPolicy } from "./packs/built-in.js";
import type { PathContext } from "./paths.js";
import { compilePattern, type CompiledPattern } from "./pattern.js";
import {
  combine,
  resolve,
  type PolicySource,
  type SourcedRule,
} from "./precedence.js";
import { subjectsOf } from "./subjects.js";

/**
 * RFX-015 — the policy evaluator.
 *
 * Pure: a compiled set, an action and where it happens in; a resolution out.
 * No I/O, no clock in the result's meaning, no provider. If this resolves an
 * action, nothing after it runs (ADR-002).
 */
export interface PolicySourceDocument {
  readonly source: PolicySource;
  /** Whether the user trusts this content. Only ever false for `project`. */
  readonly trusted: boolean;
  readonly policyId?: PolicyId;
  readonly document: PolicyDocument;
}

export interface CompiledPolicySet {
  readonly rules: readonly SourcedRule[];
  /** ADR-004 §6: the most restrictive default any source declares, or `ask`. */
  readonly unresolved: PolicyUnresolvedDefault;
  readonly patterns: ReadonlyMap<string, CompiledPattern>;
  /**
   * RFX-016: depends on what the policies mean and on nothing else. Recorded
   * with every decision as `policySetHash`.
   */
  readonly hash: string;
  /** The canonical form that was hashed: the payload of a snapshot (RFX-083). */
  readonly canonical: string;
}

export type CompileResult =
  | { readonly ok: true; readonly set: CompiledPolicySet }
  | { readonly ok: false; readonly problems: readonly string[] };

const UNRESOLVED_STRICTNESS: Readonly<Record<PolicyUnresolvedDefault, number>> =
  { semantic: 0, ask: 1, deny: 2 };

function patternsIn(condition: PolicyCondition, found: Set<string>): void {
  if ("not" in condition) {
    patternsIn(condition.not, found);
  } else if ("any_of" in condition) {
    for (const inner of condition.any_of) {
      patternsIn(inner, found);
    }
  } else if (
    condition.operator === "matches" &&
    typeof condition.value === "string"
  ) {
    found.add(condition.value);
  }
}

/**
 * Everything that can be done once is done here, not per evaluation.
 *
 * REFLEX's own rules (RFX-103) are part of every set. They are added here and
 * nowhere else, so that no caller can leave them out and no policy source can
 * take their place.
 */
export function compilePolicySet(
  given: readonly PolicySourceDocument[],
): CompileResult {
  const problems: string[] = [];
  if (given.some((entry) => entry.source === "built-in")) {
    problems.push("built-in is REFLEX's own source and cannot be supplied");
  }
  const sources: readonly PolicySourceDocument[] = [
    { source: "built-in", trusted: true, document: builtInPolicy() },
    ...given.filter((entry) => entry.source !== "built-in"),
  ];
  const rules: SourcedRule[] = [];
  const sources_ = new Set<string>();
  let unresolved: PolicyUnresolvedDefault | undefined;

  for (const entry of sources) {
    // ADR-012: trust is a question about what a repository ships. Every other
    // source is the user's own or arrives authenticated.
    const trusted = entry.source === "project" ? entry.trusted : true;
    const declared = entry.document.defaults?.unresolved;
    if (
      declared !== undefined &&
      (unresolved === undefined ||
        UNRESOLVED_STRICTNESS[declared] > UNRESOLVED_STRICTNESS[unresolved])
    ) {
      unresolved = declared;
    }
    for (const rule of entry.document.rules) {
      // The parser refuses this. A document built in code must not get past it.
      if (rule.effect === "allow" && rule.mandatory === true) {
        problems.push(`${entry.source}: rule ${rule.id} is a mandatory allow`);
        continue;
      }
      if (rule.conditions.length === 0) {
        problems.push(`${entry.source}: rule ${rule.id} has no conditions`);
        continue;
      }
      const key = JSON.stringify([
        entry.source,
        entry.policyId ?? null,
        rule.id,
      ]);
      if (sources_.has(key)) {
        problems.push(`${entry.source}: rule id ${rule.id} is used twice`);
        continue;
      }
      sources_.add(key);
      rules.push({
        source: entry.source,
        trusted,
        ...(entry.policyId === undefined ? {} : { policyId: entry.policyId }),
        rule,
      });
    }
  }

  const sourcesOfPatterns = new Set<string>();
  for (const { rule } of rules) {
    for (const condition of rule.conditions) {
      patternsIn(condition, sourcesOfPatterns);
    }
  }
  const patterns = new Map<string, CompiledPattern>();
  for (const source of sourcesOfPatterns) {
    const compiled = compilePattern(source);
    if (compiled.ok) {
      patterns.set(source, compiled.pattern);
    } else {
      problems.push(`a pattern does not compile: ${compiled.message}`);
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  const { hash, payload } = canonicalizePolicySet(
    sources.map((entry) => ({
      source: entry.source,
      trusted: entry.source === "project" ? entry.trusted : true,
      ...(entry.policyId === undefined ? {} : { policyId: entry.policyId }),
      ...(entry.document.defaults === undefined
        ? {}
        : { unresolved: entry.document.defaults.unresolved }),
      rules: entry.document.rules,
    })),
  );
  return {
    ok: true,
    set: {
      rules,
      unresolved: unresolved ?? "ask",
      patterns,
      hash,
      canonical: payload,
    },
  };
}

export interface PolicyEvaluationResult {
  /** The contract's shape, ready to go into a decision. */
  readonly evaluation: PolicyEvaluation;
  /** What applies when `evaluation.resolved` is false. */
  readonly unresolved: PolicyUnresolvedDefault;
  /**
   * Only when unresolved: whatever decides next may not go under this. It
   * comes from a rule of an untrusted source, which may tighten a decision and
   * never make one (ADR-012).
   */
  readonly floor?: DecisionEffect;
  /** After classification: raised, never lowered (ADR-011). */
  readonly sideEffectClass: SideEffectClass;
  /** False when no allow rule could have matched, whatever the policy says. */
  readonly understood: boolean;
  /** The contract's `latencyMs` is whole milliseconds, which reads as 0 here. */
  readonly elapsedMs: number;
}

export function evaluatePolicy(
  set: CompiledPolicySet,
  action: CanonicalAction,
  context: PathContext = {},
): PolicyEvaluationResult {
  const started = performance.now();
  const { subjects, sideEffectClass, understood } = subjectsOf(action, context);
  const matchContext: MatchContext = {
    ...context,
    ...(context.cwd === undefined && action.cwd !== undefined
      ? { cwd: action.cwd }
      : {}),
    ...(context.projectRoot === undefined &&
    (action.repository?.root ?? action.cwd) !== undefined
      ? { projectRoot: action.repository?.root ?? action.cwd }
      : {}),
    pattern: (source) => set.patterns.get(source),
  };

  const { effect, floor, matches } = combine(
    subjects.map((subject) =>
      resolve(
        set.rules.filter((sourced) =>
          ruleMatches(sourced.rule, subject, matchContext),
        ),
      ),
    ),
  );

  const elapsedMs = performance.now() - started;
  return {
    evaluation: {
      resolved: effect !== undefined,
      ...(effect === undefined ? {} : { effect }),
      matches,
      latencyMs: Math.round(elapsedMs),
    },
    unresolved: set.unresolved,
    ...(floor === undefined ? {} : { floor }),
    sideEffectClass,
    understood,
    elapsedMs,
  };
}
