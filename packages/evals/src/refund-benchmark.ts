import type {
  DecisionEffect,
  SemanticAssessment,
  SemanticDecisionRequest,
} from "@reflex/contracts";
import {
  createFakeProvider,
  type SemanticDecisionProvider,
} from "@reflex/semantic-provider";

import {
  ASSESSMENT_LEVELS,
  SCORED_ASSESSMENT_DIMENSIONS,
  loadCorpus,
  type CorpusCase,
  type ExpectedAssessment,
} from "./corpus.js";
import { createEnginePipeline, requestKey } from "./engine-replay.js";

/**
 * RFX-146 — the refund benchmark (ADR-016 §7).
 *
 * The generator (`rdm/`, private) writes cases without a label: the action,
 * the words around it, and the dimension vector its own rules give. The
 * labels are effects, and they are produced here, by running each case
 * through the real policy engine with the scenario's policy and a fixed
 * aggregator configuration, with a provider that answers the case's own
 * vector. Source: `deterministic_rule`. A counterfactual pair differs in
 * one variable and must flip the effect end to end; the generator declares
 * the pairs and this module holds them.
 *
 * What is committed under `corpus/refunds/v1/` is the labelled corpus, in
 * the corpus format, so that the RFX-040 gate replays it like any other; a
 * test recomputes the labels from the generated file and fails on a
 * difference, so a change in the engine that moves a refund is seen.
 */
export interface GeneratedRefundCase {
  readonly id: string;
  readonly title: string;
  readonly action: CorpusCase["action"] extends infer A
    ? Omit<A, "id" | "createdAt">
    : never;
  readonly provenance: "constructed";
  readonly tags: readonly string[];
  readonly why: string;
  readonly expectedAssessment: ExpectedAssessment;
  /** Which of the generated policies the case runs under. */
  readonly policy: string;
  readonly generatorProvenance: {
    readonly family: string;
    readonly template: string;
    readonly seed: number;
    readonly entities: readonly string[];
    readonly variables: Readonly<Record<string, unknown>>;
  };
}

export interface CounterfactualPair {
  readonly id: string;
  readonly variable: string;
  readonly a: string;
  readonly b: string;
  readonly expectedEffects: readonly [DecisionEffect, DecisionEffect];
}

export interface GeneratedRefundBenchmark {
  readonly family: string;
  readonly version: number;
  readonly policies: Readonly<Record<string, string>>;
  readonly cases: readonly GeneratedRefundCase[];
  readonly pairs: readonly CounterfactualPair[];
}

export interface BenchmarkLabel {
  readonly caseId: string;
  readonly policy: string;
  readonly effect: DecisionEffect;
  readonly source: "deterministic_rule";
  readonly resolvedByPolicy: boolean;
}

export interface LabelledRefundBenchmark {
  /** The corpus file, `{ cases }`, in the format every other corpus uses. */
  readonly corpus: { readonly cases: readonly Record<string, unknown>[] };
  readonly labels: readonly BenchmarkLabel[];
  readonly pairs: readonly CounterfactualPair[];
}

const surest = 0.95;

function isLevel(value: number): value is (typeof ASSESSMENT_LEVELS)[number] {
  return (ASSESSMENT_LEVELS as readonly number[]).includes(value);
}

/** Answers each case with its own vector: the generator's rules as a provider. */
export function vectorProvider(
  cases: readonly GeneratedRefundCase[],
): SemanticDecisionProvider {
  const byRequest = new Map<string, GeneratedRefundCase>();
  for (const testCase of cases) {
    byRequest.set(requestKey(testCase.action), testCase);
  }
  return createFakeProvider({
    assess: (request: SemanticDecisionRequest): SemanticAssessment => {
      const testCase = byRequest.get(requestKey(request.action));
      if (testCase === undefined) {
        throw new Error(
          "the vector provider was asked about a case it does not know",
        );
      }
      const expected = testCase.expectedAssessment;
      const signal = (value: number) => ({ value, confidence: surest });
      const scored = Object.fromEntries(
        SCORED_ASSESSMENT_DIMENSIONS.map((dimension) => {
          const level = expected[dimension]?.[0];
          if (level === undefined || !isLevel(level)) {
            throw new Error(`${testCase.id} gives no level for ${dimension}`);
          }
          return [dimension, signal(level)];
        }),
      ) as Record<
        (typeof SCORED_ASSESSMENT_DIMENSIONS)[number],
        { value: number; confidence: number }
      >;
      return {
        ...scored,
        externalSideEffect: {
          value: expected.externalSideEffect ?? false,
          confidence: surest,
        },
        provider: "vector",
        model: "generator-rules-1",
        latencyMs: 1,
      };
    },
  });
}

/** The generated file's cases as a corpus the standard loader accepts. */
function asCorpusCase(
  generated: GeneratedRefundCase,
  effect: DecisionEffect,
): Record<string, unknown> {
  return {
    id: generated.id,
    title: generated.title,
    action: generated.action,
    acceptableEffects: [effect],
    // Running a refund without a human when the rule said ask or deny is
    // the failure this benchmark exists to catch.
    dangerousIfAllowed: effect !== "allow",
    provenance: generated.provenance,
    tags: generated.tags,
    why: `${generated.why} Label: ${effect}, from the policy ${generated.policy} and the fixed aggregator (deterministic_rule).`,
    expectedAssessment: generated.expectedAssessment,
  };
}

/**
 * Runs every case through the real engine under its policy, with the
 * vector provider, and writes the effect down as the label.
 */
export async function labelRefundBenchmark(
  generated: GeneratedRefundBenchmark,
): Promise<LabelledRefundBenchmark> {
  const provider = vectorProvider(generated.cases);
  const engines = new Map(
    Object.entries(generated.policies).map(([id, yaml]) => [
      id,
      createEnginePipeline({ policy: yaml, provider }),
    ]),
  );
  const parsed = loadCorpus([
    {
      name: "generated.json",
      content: {
        cases: generated.cases.map((testCase) => asCorpusCase(testCase, "ask")),
      },
    },
  ]);
  if (!parsed.ok) {
    throw new Error(
      parsed.issues
        .map((issue) => `${issue.caseId ?? "?"}: ${issue.message}`)
        .join("\n"),
    );
  }
  const actions = new Map(
    parsed.cases.map((testCase) => [testCase.id, testCase.action]),
  );
  const labels: BenchmarkLabel[] = [];
  for (const testCase of generated.cases) {
    const engine = engines.get(testCase.policy);
    const action = actions.get(testCase.id);
    if (engine === undefined || action === undefined) {
      throw new Error(`${testCase.id}: unknown policy ${testCase.policy}`);
    }
    const decision = await engine.decide({
      action,
      mode: "autopilot",
      failureMode: "fail-ask",
    });
    if (decision.fallback?.used === true) {
      throw new Error(
        `${testCase.id}: the engine fell back; a label needs a decision`,
      );
    }
    labels.push({
      caseId: testCase.id,
      policy: testCase.policy,
      effect: decision.effect,
      source: "deterministic_rule",
      resolvedByPolicy: decision.semanticAssessment === undefined,
    });
  }
  const effectOf = new Map(labels.map((label) => [label.caseId, label.effect]));
  return {
    corpus: {
      cases: generated.cases.map((testCase) =>
        asCorpusCase(testCase, effectOf.get(testCase.id) ?? "ask"),
      ),
    },
    labels,
    pairs: generated.pairs,
  };
}

/** Every pair whose two effects are not the ones the generator declared. */
export function pairsThatDoNotFlip(
  labelled: LabelledRefundBenchmark,
): readonly {
  readonly pair: CounterfactualPair;
  readonly actual: readonly (DecisionEffect | undefined)[];
}[] {
  const effectOf = new Map(
    labelled.labels.map((label) => [label.caseId, label.effect]),
  );
  return labelled.pairs.flatMap((pair) => {
    const actual = [effectOf.get(pair.a), effectOf.get(pair.b)] as const;
    return actual[0] === pair.expectedEffects[0] &&
      actual[1] === pair.expectedEffects[1] &&
      actual[0] !== actual[1]
      ? []
      : [{ pair, actual }];
  });
}
