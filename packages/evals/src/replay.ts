import type { CanonicalAction, DecisionEffect } from "@reflex/contracts";

import type { CorpusCase } from "./corpus.js";

/**
 * RFX-105 — replays the corpus against whatever decides.
 *
 * The runner knows nothing about policies or providers. It is handed a
 * function from an action to an effect, so the same corpus serves the
 * deterministic engine today and the whole pipeline later (RFX-039).
 */
export interface EvaluatedEffect {
  readonly effect: DecisionEffect;
  /** False when nothing matched and a default decided. */
  readonly resolved: boolean;
}

export type Evaluate = (
  action: CanonicalAction,
) => EvaluatedEffect | Promise<EvaluatedEffect>;

export type CaseVerdict =
  /** The effect is one the case accepts. */
  | "pass"
  /** A case that is dangerous to allow was allowed. The one that must never happen. */
  | "dangerous-allow"
  /** Any other effect the case does not accept: usually a needless block. */
  | "unacceptable-effect"
  /** The evaluator threw. Never a pass: an engine that crashes decides nothing. */
  | "evaluator-error";

export interface CaseResult {
  readonly caseId: string;
  readonly verdict: CaseVerdict;
  readonly effect: DecisionEffect | undefined;
  readonly resolved: boolean;
  readonly acceptableEffects: readonly DecisionEffect[];
}

export interface ReplayReport {
  /** True when every case passed. */
  readonly ok: boolean;
  readonly total: number;
  readonly results: readonly CaseResult[];
  readonly failures: readonly CaseResult[];
  /** A subset of `failures`, reported apart because it is the safety metric. */
  readonly dangerousAllows: readonly CaseResult[];
  /**
   * The product metric, on this corpus: of the cases that may be allowed, how
   * many were. Raising it is the point; raising it by weakening safety shows
   * up in `dangerousAllows`.
   */
  readonly autonomy: {
    readonly eligible: number;
    readonly allowed: number;
    readonly rate: number;
  };
  readonly resolvedDeterministically: number;
}

function verdictOf(testCase: CorpusCase, effect: DecisionEffect): CaseVerdict {
  if (testCase.acceptableEffects.includes(effect)) {
    return "pass";
  }
  return testCase.dangerousIfAllowed && effect === "allow"
    ? "dangerous-allow"
    : "unacceptable-effect";
}

/** Never throws, whatever the evaluator does. Cases run one after another. */
export async function replayCorpus(
  cases: readonly CorpusCase[],
  evaluate: Evaluate,
): Promise<ReplayReport> {
  const results: CaseResult[] = [];

  for (const testCase of cases) {
    const base = {
      caseId: testCase.id,
      acceptableEffects: testCase.acceptableEffects,
    };
    try {
      const { effect, resolved } = await evaluate(testCase.action);
      results.push({
        ...base,
        verdict: verdictOf(testCase, effect),
        effect,
        resolved,
      });
    } catch {
      results.push({
        ...base,
        verdict: "evaluator-error",
        effect: undefined,
        resolved: false,
      });
    }
  }

  const failures = results.filter((result) => result.verdict !== "pass");
  const eligible = cases.filter((testCase) =>
    testCase.acceptableEffects.includes("allow"),
  );
  const eligibleIds = new Set(eligible.map((testCase) => testCase.id));
  const allowed = results.filter(
    (result) => result.effect === "allow" && eligibleIds.has(result.caseId),
  ).length;

  return {
    ok: failures.length === 0,
    total: results.length,
    results,
    failures,
    dangerousAllows: failures.filter(
      (result) => result.verdict === "dangerous-allow",
    ),
    autonomy: {
      eligible: eligible.length,
      allowed,
      rate: eligible.length === 0 ? 0 : allowed / eligible.length,
    },
    resolvedDeterministically: results.filter((result) => result.resolved)
      .length,
  };
}

/** One line per failure, for a test message or a terminal. No argument values. */
export function describeFailures(report: ReplayReport): string {
  return report.failures
    .map(
      (failure) =>
        `${failure.verdict}: ${failure.caseId} got ${failure.effect ?? "no effect"}, accepts ${failure.acceptableEffects.join(" or ")}`,
    )
    .join("\n");
}
