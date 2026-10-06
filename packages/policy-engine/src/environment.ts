import {
  ENVIRONMENT_KINDS,
  type EnvironmentKind,
} from "@reflex-control/contracts";

import { compilePattern, type CompiledPattern } from "./pattern.js";

/**
 * RFX-084 — how a project says which environment an action is in (ADR-018).
 *
 * `.reflex/policy.yaml` may carry an `environments` mapping: for each
 * environment, the branches and the remotes that mean it. The daemon reads
 * the branch and the remote of the action's repository and resolves the
 * environment here, before policy is asked; a host that already says the
 * environment is believed and the mapping is not consulted.
 *
 * Pure. The git facts come from the caller.
 */
export const MAPPABLE_ENVIRONMENTS = ENVIRONMENT_KINDS.filter(
  (kind): kind is Exclude<EnvironmentKind, "unknown"> => kind !== "unknown",
);
export type MappableEnvironment = (typeof MAPPABLE_ENVIRONMENTS)[number];

export interface EnvironmentMatchers {
  /** Patterns (RFX-100 §9), each matched against the whole checked-out branch. */
  readonly branches?: readonly string[];
  /** Patterns, each matched against the whole `host/owner/repo` of the `origin` remote. */
  readonly remotes?: readonly string[];
}

/**
 * A matcher is anchored: `main` means the branch `main`, not every branch
 * with those letters in it. `release/.*` is how a prefix is written.
 */
export function anchoredPattern(source: string): string {
  return `^(?:${source})$`;
}

export type EnvironmentMapping = Readonly<
  Partial<Record<MappableEnvironment, EnvironmentMatchers>>
>;

export interface RepositoryFacts {
  readonly branch?: string;
  /** `github.com/acme/api`, without a scheme, a user or `.git`. */
  readonly remote?: string;
}

/** Riskier first: the first environment whose matchers hold wins. */
const BY_RISK: readonly MappableEnvironment[] = [
  "production",
  "staging",
  "test",
  "development",
  "local",
];

/** The environments an untrusted mapping may claim: risk can be raised, never lowered. */
const UNTRUSTED_MAY_CLAIM: ReadonlySet<EnvironmentKind> = new Set([
  "production",
  "staging",
]);

const compiledPatterns = new Map<string, CompiledPattern | null>();

function patternOf(source: string): CompiledPattern | undefined {
  const known = compiledPatterns.get(source);
  if (known !== undefined) {
    return known ?? undefined;
  }
  const compiled = compilePattern(anchoredPattern(source));
  compiledPatterns.set(source, compiled.ok ? compiled.pattern : null);
  if (compiledPatterns.size > 1_000) {
    compiledPatterns.clear();
  }
  return compiled.ok ? compiled.pattern : undefined;
}

function anyMatches(
  patterns: readonly string[] | undefined,
  text: string | undefined,
): boolean {
  if (patterns === undefined || text === undefined) {
    return false;
  }
  return patterns.some((source) => patternOf(source)?.test(text) === true);
}

export interface ResolvedEnvironment {
  readonly environment: EnvironmentKind;
  /** What decided: the host, the mapping (and which entry), or nothing. */
  readonly by: "host" | "mapping" | "none";
  readonly matched?: MappableEnvironment;
}

/**
 * Resolves the environment of an action from what the host said, else from
 * the project's mapping against the repository's facts. An untrusted mapping
 * (ADR-012) may only raise the environment to `staging` or `production`: a
 * hostile repository can make REFLEX stricter and never looser.
 */
export function resolveMappedEnvironment(options: {
  readonly fromHost: EnvironmentKind;
  readonly mapping: EnvironmentMapping | undefined;
  readonly mappingTrusted: boolean;
  readonly facts: RepositoryFacts | undefined;
}): ResolvedEnvironment {
  if (options.fromHost !== "unknown") {
    return { environment: options.fromHost, by: "host" };
  }
  if (options.mapping === undefined || options.facts === undefined) {
    return { environment: "unknown", by: "none" };
  }
  for (const environment of BY_RISK) {
    const matchers = options.mapping[environment];
    if (matchers === undefined) {
      continue;
    }
    if (
      anyMatches(matchers.branches, options.facts.branch) ||
      anyMatches(matchers.remotes, options.facts.remote)
    ) {
      if (!options.mappingTrusted && !UNTRUSTED_MAY_CLAIM.has(environment)) {
        continue;
      }
      return { environment, by: "mapping", matched: environment };
    }
  }
  return { environment: "unknown", by: "none" };
}
