import type {
  DecisionEffect,
  PolicyId,
  PolicyMatch,
  PolicyRule,
} from "@reflex/contracts";

/**
 * RFX-014 — policy precedence (ADR-004).
 *
 * Defaults cascade down and mandates hold from above:
 *
 * 1. **Trust.** An allow rule from a source that is not trusted is dropped.
 *    Its deny and ask rules stay, as a floor and nothing else: they never take
 *    part in the cascade, where a more specific default overrides a more
 *    general one. Otherwise a repository could ship an `ask` to override an
 *    organization's default `deny`. Untrusted can only tighten (ADR-012).
 * 2. **Floor.** The most restrictive effect among the mandatory matches.
 * 3. **Cascade.** The most specific source that has a non-mandatory match
 *    decides among the defaults, by its own most restrictive effect.
 * 4. **Final effect:** the more restrictive of floor and cascade. With neither
 *    the action is unresolved.
 *
 * The theorem this exists for (`CLAUDE.md` principle 6): no rule, from any
 * source, brings the final effect under a mandatory match.
 *
 * Rule order never matters, so reordering a policy is always safe.
 */
export const POLICY_SOURCES = [
  "built-in",
  "organization",
  "environment",
  "project",
  "local",
] as const;
export type PolicySource = (typeof POLICY_SOURCES)[number];

export interface SourcedRule {
  readonly source: PolicySource;
  /** Only a `project` source can be untrusted (ADR-012). */
  readonly trusted: boolean;
  readonly policyId?: PolicyId;
  readonly rule: PolicyRule;
}

export interface Resolution {
  /** `undefined` when nothing resolved the action. */
  readonly effect: DecisionEffect | undefined;
  /**
   * Set only while `effect` is `undefined`: whatever decides later may not go
   * under this. It comes from an untrusted `ask`, which must not resolve an
   * action by itself, because whatever would have decided might have denied.
   */
  readonly floor?: DecisionEffect;
  /** The deciding match first, then the others by precedence. */
  readonly matches: readonly PolicyMatch[];
}

const RESTRICTIVENESS: Readonly<Record<DecisionEffect, number>> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/** From the most general to the most specific. */
const SPECIFICITY: Readonly<Record<PolicySource, number>> = {
  "built-in": 1,
  organization: 2,
  environment: 3,
  project: 4,
  local: 5,
};

/**
 * ADR-004 §5. Every mandatory match outranks every default; among mandates
 * the more general source is stronger, among defaults the more specific one.
 */
export function precedenceOf(source: PolicySource, mandatory: boolean): number {
  const specificity = SPECIFICITY[source];
  return mandatory ? 160 - specificity * 10 : specificity * 10;
}

export function mostRestrictive(
  effects: readonly DecisionEffect[],
): DecisionEffect | undefined {
  let strictest: DecisionEffect | undefined;
  for (const effect of effects) {
    if (
      strictest === undefined ||
      RESTRICTIVENESS[effect] > RESTRICTIVENESS[strictest]
    ) {
      strictest = effect;
    }
  }
  return strictest;
}

function toMatch(sourced: SourcedRule): PolicyMatch {
  const mandatory = sourced.rule.mandatory === true;
  return {
    ...(sourced.policyId === undefined ? {} : { policyId: sourced.policyId }),
    ruleId: sourced.rule.id,
    ruleName: sourced.rule.name,
    effect: sourced.rule.effect,
    mandatory,
    precedence: precedenceOf(sourced.source, mandatory),
  };
}

/** Code-point order, so that a policy explains itself the same way everywhere. */
const byRuleId = (a: PolicyMatch, b: PolicyMatch): number =>
  a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;

/** Resolves the rules that matched one subject. */
export function resolve(matched: readonly SourcedRule[]): Resolution {
  // 1. Trust.
  const trusted = matched.filter((sourced) => sourced.trusted);
  const untrusted = matched.filter(
    (sourced) => !sourced.trusted && sourced.rule.effect !== "allow",
  );
  const untrustedFloor = mostRestrictive(
    untrusted.map((sourced) => sourced.rule.effect),
  );

  // 2. Floor.
  const mandated = mostRestrictive(
    trusted
      .filter((sourced) => sourced.rule.mandatory === true)
      .map((sourced) => sourced.rule.effect),
  );

  // 3. Cascade.
  const defaults = trusted.filter((sourced) => sourced.rule.mandatory !== true);
  const mostSpecific = Math.max(
    0,
    ...defaults.map((sourced) => SPECIFICITY[sourced.source]),
  );
  const cascade = mostRestrictive(
    defaults
      .filter((sourced) => SPECIFICITY[sourced.source] === mostSpecific)
      .map((sourced) => sourced.rule.effect),
  );

  // 4. Final effect. An untrusted deny is final, since nothing is stricter. An
  //    untrusted ask tightens what the user's own rules resolved, and
  //    otherwise only leaves a floor behind.
  const own = mostRestrictive(
    [mandated, cascade].filter(
      (candidate): candidate is DecisionEffect => candidate !== undefined,
    ),
  );
  const effect =
    own === undefined
      ? untrustedFloor === "deny"
        ? "deny"
        : undefined
      : mostRestrictive(
          untrustedFloor === undefined ? [own] : [own, untrustedFloor],
        );

  const matches = [...trusted, ...untrusted]
    .map(toMatch)
    .sort((a, b) => b.precedence - a.precedence || byRuleId(a, b));
  const deciding = matches.findIndex((match) => match.effect === effect);
  if (deciding > 0) {
    const [match] = matches.splice(deciding, 1);
    if (match !== undefined) {
      matches.unshift(match);
    }
  }
  return {
    effect,
    ...(effect === undefined && untrustedFloor !== undefined
      ? { floor: untrustedFloor }
      : {}),
    matches,
  };
}

/**
 * An action is several subjects when it is a compound shell command. Each is
 * resolved alone, and then: one deny denies, one ask asks, one segment nothing
 * resolved leaves the action unresolved, and only if every segment is allowed
 * is the action allowed.
 */
export function combine(resolutions: readonly Resolution[]): Resolution {
  const effects = resolutions.map((resolution) => resolution.effect);
  let effect: DecisionEffect | undefined;
  if (effects.includes("deny")) {
    effect = "deny";
  } else if (effects.includes("ask")) {
    effect = "ask";
  } else if (effects.length > 0 && effects.every((one) => one === "allow")) {
    effect = "allow";
  }

  // The matches of the subject that decided come first.
  const deciding =
    effect === undefined
      ? -1
      : resolutions.findIndex((resolution) => resolution.effect === effect);
  const sequence =
    deciding === -1
      ? resolutions
      : [
          ...resolutions.slice(deciding, deciding + 1),
          ...resolutions.filter((_resolution, index) => index !== deciding),
        ];

  const seen = new Set<string>();
  const ordered: PolicyMatch[] = [];
  for (const resolution of sequence) {
    for (const match of resolution.matches) {
      const key = JSON.stringify([
        match.policyId ?? null,
        match.ruleId,
        match.precedence,
      ]);
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(match);
      }
    }
  }
  const floor =
    effect === undefined
      ? mostRestrictive(
          resolutions.flatMap((resolution) =>
            resolution.floor === undefined ? [] : [resolution.floor],
          ),
        )
      : undefined;
  return {
    effect,
    ...(floor === undefined ? {} : { floor }),
    matches: ordered,
  };
}
