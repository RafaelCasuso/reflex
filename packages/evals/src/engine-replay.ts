import type {
  CanonicalAction,
  DecisionRequest,
  ReflexDecision,
  SemanticAssessment,
  SemanticDecisionRequest,
} from "@reflex/contracts";
import {
  createContextCompiler,
  createRedactor,
} from "@reflex/context-compiler";
import {
  createDecisionEngine,
  createRiskAggregator,
  type AggregatorConfig,
  type ReflexDecisionEngine,
} from "@reflex/core";
import {
  compilePolicySet,
  parsePolicy,
  type CompiledPolicySet,
  type PolicySourceDocument,
} from "@reflex/policy-engine";
import {
  assessmentForClass,
  createFakeProvider,
  type SemanticDecisionProvider,
} from "@reflex/semantic-provider";

import {
  ASSESSMENT_LEVELS,
  SCORED_ASSESSMENT_DIMENSIONS,
  type AssessmentLevel,
  type CorpusCase,
  type ExpectedAssessment,
} from "./corpus.js";
import type { Evaluate } from "./replay.js";

/**
 * RFX-039 — the replay runner against the whole engine.
 *
 * The seed replay (RFX-105) handed the runner the policy engine alone. This
 * builds the full pipeline the daemon will run (RFX-141): policy, the
 * context compiler with its redactor, a provider, the aggregator, the
 * fallback; and hands the runner a function from an action to a decision.
 *
 * Two providers matter for a corpus that says what a right assessment is:
 * the **oracle**, which answers every case with levels the case accepts,
 * and shows what the pipeline does with a provider that is right; and the
 * **adversary**, which answers that everything is safe and is sure of it,
 * and shows what the pipeline does with a provider that is wrong in the
 * one direction that matters. Neither may produce a dangerous allow.
 */
export interface EnginePipelineOptions {
  /** Policy sources; REFLEX's own rules are always added. */
  readonly policy?: readonly PolicySourceDocument[] | string;
  readonly provider?: SemanticDecisionProvider;
  readonly aggregator?: AggregatorConfig;
  readonly mode?: DecisionRequest["mode"];
  readonly cache?: boolean;
}

export function policyFromYaml(yaml: string): PolicySourceDocument {
  const parsed = parsePolicy(yaml);
  if (!parsed.ok) {
    throw new Error(
      parsed.issues
        .map((issue) => `${String(issue.line)}: ${issue.message}`)
        .join("\n"),
    );
  }
  return { source: "local", trusted: true, document: parsed.document };
}

function compiled(sources: readonly PolicySourceDocument[]): CompiledPolicySet {
  const result = compilePolicySet(sources);
  if (!result.ok) {
    throw new Error(result.problems.join("\n"));
  }
  return result.set;
}

export const CORPUS_CONTEXT = { home: "/home/dev" } as const;

/** The whole pipeline, offline. */
export function createEnginePipeline(
  options: EnginePipelineOptions = {},
): ReflexDecisionEngine {
  const sources =
    typeof options.policy === "string"
      ? [policyFromYaml(options.policy)]
      : (options.policy ?? []);
  const set = compiled(sources);
  const redactor = createRedactor({ key: Buffer.alloc(32, 42) });
  const compiler = createContextCompiler({
    redactor,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  return createDecisionEngine({
    policy: () => set,
    ...(options.provider === undefined
      ? {}
      : {
          semantic: {
            provider: options.provider,
            compiler,
            aggregator: createRiskAggregator(options.aggregator),
            maxInputTokens: 600,
          },
        }),
    failureMode: "fail-ask",
    deadline: { defaultMs: 2_000, maxMs: 5_000 },
    paths: CORPUS_CONTEXT,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    fingerprintKey: Buffer.alloc(32, 7),
  });
}

/** What the runner needs from a decision. */
export function evaluateWith(
  engine: ReflexDecisionEngine,
  mode: DecisionRequest["mode"] = "autopilot",
): Evaluate {
  return async (action: CanonicalAction) => {
    const decision = await engine.decide({
      action,
      mode,
      failureMode: "fail-ask",
    });
    return {
      effect: decision.effect,
      resolved: decision.policyMatches.length > 0,
    };
  };
}

/** The decisions themselves, for the reports that need more than an effect. */
export async function decideAll(
  engine: ReflexDecisionEngine,
  cases: readonly CorpusCase[],
  mode: DecisionRequest["mode"] = "autopilot",
): Promise<ReadonlyMap<string, ReflexDecision>> {
  const decisions = new Map<string, ReflexDecision>();
  for (const testCase of cases) {
    decisions.set(
      testCase.id,
      await engine.decide({
        action: testCase.action,
        mode,
        failureMode: "fail-ask",
      }),
    );
  }
  return decisions;
}

const surest = 0.95;

function levelFor(
  expected: ExpectedAssessment,
  dimension: (typeof SCORED_ASSESSMENT_DIMENSIONS)[number],
  fallback: number,
): number {
  const accepted = expected[dimension];
  // The first level the case lists, so that a case written "67 or 100"
  // is answered with 67: the least alarming answer the case calls right.
  return accepted?.[0] ?? fallback;
}

/** Answers every case with levels the case accepts; sure of every one. */
/** What tells one case's request from another's: the arguments and the words around them. */
export function requestKey(action: {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly userObjective?: string;
  readonly taskSummary?: string;
}): string {
  return JSON.stringify([
    action.arguments,
    action.userObjective ?? null,
    action.taskSummary ?? null,
  ]);
}

export function oracleProvider(
  cases: readonly CorpusCase[],
): SemanticDecisionProvider {
  const byRequest = new Map<string, CorpusCase>();
  for (const testCase of cases) {
    if (testCase.expectedAssessment !== undefined) {
      byRequest.set(requestKey(testCase.action), testCase);
    }
  }
  return createFakeProvider({
    assess: (request: SemanticDecisionRequest): SemanticAssessment => {
      const base = assessmentForClass(request.action.sideEffectClass);
      const testCase = byRequest.get(requestKey(request.action));
      const expected = testCase?.expectedAssessment;
      if (expected === undefined) {
        return base;
      }
      const assessment: Record<string, unknown> = { ...base };
      for (const dimension of SCORED_ASSESSMENT_DIMENSIONS) {
        assessment[dimension] = {
          value: levelFor(expected, dimension, base[dimension].value),
          confidence: surest,
        };
      }
      assessment.externalSideEffect = {
        value: expected.externalSideEffect ?? base.externalSideEffect.value,
        confidence: surest,
      };
      return assessment as unknown as SemanticAssessment;
    },
  });
}

/** Answers that everything is safe, on task, reversible and local, and is sure. */
export function adversaryProvider(): SemanticDecisionProvider {
  return createFakeProvider({
    assess: (request: SemanticDecisionRequest): SemanticAssessment => {
      const base = assessmentForClass(request.action.sideEffectClass);
      const assessment: Record<string, unknown> = { ...base };
      for (const dimension of SCORED_ASSESSMENT_DIMENSIONS) {
        const safest: AssessmentLevel =
          dimension === "objectiveAlignment" || dimension === "reversibility"
            ? ASSESSMENT_LEVELS[3]
            : ASSESSMENT_LEVELS[0];
        assessment[dimension] = { value: safest, confidence: surest };
      }
      assessment.externalSideEffect = { value: false, confidence: surest };
      return assessment as unknown as SemanticAssessment;
    },
  });
}
