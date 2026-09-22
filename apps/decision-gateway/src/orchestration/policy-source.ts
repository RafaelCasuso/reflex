import { readFile } from "node:fs/promises";

import type { CanonicalAction, FailureMode } from "@reflex/contracts";
import {
  DecisionCache,
  createDecisionEngine,
  type ReflexDecisionEngine,
} from "@reflex/core";
import {
  compilePolicySet,
  parsePolicy,
  type CompiledPolicySet,
  type PolicySourceDocument,
} from "@reflex/policy-engine";

/**
 * The policy set the daemon serves, and how it changes.
 *
 * ADR-003 §3: a set that does not compile is reported and the last good one
 * stays in force. With no good set at all, REFLEX's own rules alone are in
 * force and everything else is unresolved, which the policy default reads as
 * `ask`. Serving one project's policy to that project (per `action`) is a
 * later gate's work; every action gets the same set here.
 */
export type PolicyLoadResult =
  | { readonly ok: true; readonly set: CompiledPolicySet }
  | { readonly ok: false; readonly problems: readonly string[] };

export interface PolicyState {
  readonly current: CompiledPolicySet;
  readonly lastProblems: readonly string[];
  readonly loadedAt: string | undefined;
}

export interface PolicyHolder {
  readonly state: () => PolicyState;
  /** Compiles the given sources; keeps the current set when they fail. */
  readonly replace: (
    sources: readonly PolicySourceDocument[],
    now: Date,
  ) => PolicyLoadResult;
  readonly setFor: (action: CanonicalAction) => CompiledPolicySet;
}

export function createPolicyHolder(): PolicyHolder {
  const builtInOnly = compilePolicySet([]);
  if (!builtInOnly.ok) {
    // REFLEX's own rules are tested; this cannot happen, and if it does the
    // daemon must not start with nothing.
    throw new Error(
      `built-in policy does not compile: ${builtInOnly.problems.join("; ")}`,
    );
  }
  let current = builtInOnly.set;
  let lastProblems: readonly string[] = [];
  let loadedAt: string | undefined;

  return {
    state: () => ({ current, lastProblems, loadedAt }),
    replace(sources, now) {
      const result = compilePolicySet(sources);
      if (result.ok) {
        current = result.set;
        lastProblems = [];
        loadedAt = now.toISOString();
        return { ok: true, set: result.set };
      }
      lastProblems = result.problems;
      return { ok: false, problems: result.problems };
    },
    setFor: () => current,
  };
}

/** Every file is the user's own local policy in G3. */
export async function readPolicyFiles(
  paths: readonly string[],
): Promise<
  | { readonly ok: true; readonly sources: readonly PolicySourceDocument[] }
  | { readonly ok: false; readonly problems: readonly string[] }
> {
  const sources: PolicySourceDocument[] = [];
  const problems: string[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      problems.push(`${path}: cannot be read`);
      continue;
    }
    const parsed = parsePolicy(text);
    if (!parsed.ok) {
      problems.push(
        ...parsed.issues.map(
          (issue) => `${path}:${String(issue.line)}: ${issue.message}`,
        ),
      );
      continue;
    }
    sources.push({ source: "local", trusted: true, document: parsed.document });
  }
  return problems.length === 0
    ? { ok: true, sources }
    : { ok: false, problems };
}

export interface EngineBuildOptions {
  readonly policies: PolicyHolder;
  readonly failureMode: FailureMode;
  readonly cache: boolean;
  readonly home: string | undefined;
  readonly deadline?: { readonly defaultMs: number; readonly maxMs: number };
}

export const DEFAULT_DEADLINE = { defaultMs: 2_000, maxMs: 10_000 } as const;

export function buildEngine(options: EngineBuildOptions): ReflexDecisionEngine {
  return createDecisionEngine({
    policy: options.policies.setFor,
    failureMode: options.failureMode,
    deadline: options.deadline ?? DEFAULT_DEADLINE,
    ...(options.home === undefined ? {} : { paths: { home: options.home } }),
    ...(options.cache ? { cache: new DecisionCache() } : {}),
  });
}
