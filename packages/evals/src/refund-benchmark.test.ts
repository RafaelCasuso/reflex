import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readCorpusDirectory } from "./corpus-files.js";
import {
  adversaryProvider,
  createEnginePipeline,
  evaluateWith,
} from "./engine-replay.js";
import {
  labelRefundBenchmark,
  pairsThatDoNotFlip,
  vectorProvider,
  type GeneratedRefundBenchmark,
} from "./refund-benchmark.js";
import { replayCorpus } from "./replay.js";

/**
 * RFX-146 — the refund benchmark: labels are effects the real engine
 * produced, every counterfactual pair flips end to end, and the committed
 * corpus is what a fresh labelling gives.
 */
const GENERATED = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../benchmarks/refunds/v1/generated.json", import.meta.url),
    ),
    "utf8",
  ),
) as GeneratedRefundBenchmark;
const LABELS = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../benchmarks/refunds/v1/labels.json", import.meta.url),
    ),
    "utf8",
  ),
) as { readonly labels: readonly { caseId: string; effect: string }[] };
const CORPUS_DIRECTORY = fileURLToPath(
  new URL("../corpus/refunds/v1/", import.meta.url),
);

const loaded = readCorpusDirectory(CORPUS_DIRECTORY);
if (!loaded.ok) {
  throw new Error(loaded.issues.map((issue) => issue.message).join("\n"));
}
const refunds = loaded.cases;

describe("RFX-146 the refund benchmark", () => {
  it("is generated from a benchmark seed, with the briefing's variables and the family's templates", () => {
    expect(GENERATED.family).toBe("refunds");
    expect(GENERATED.cases.length).toBeGreaterThanOrEqual(20);
    expect(GENERATED.pairs.length).toBeGreaterThanOrEqual(10);
    for (const testCase of GENERATED.cases) {
      expect(testCase.generatorProvenance.seed).toBeGreaterThanOrEqual(
        1_000_000,
      );
      expect(testCase.generatorProvenance.template).toContain(".benchmark.");
      expect(
        Object.keys(testCase.generatorProvenance.variables).sort(),
      ).toEqual([
        "amount",
        "customer_type",
        "exposure",
        "fraud_indicator",
        "hard_limit",
        "permission",
        "previous_refunds",
        "requires_second_approver",
        "reversible",
        "threshold",
      ]);
      expect(testCase.action.tool).toEqual({
        name: "refunds.create",
        namespace: "stripe",
      });
    }
  });

  it("labels every case with the effect the real engine produced, and the committed files are that labelling", async () => {
    const labelled = await labelRefundBenchmark(GENERATED);
    expect(labelled.labels.map((label) => label.source)).toEqual(
      labelled.labels.map(() => "deterministic_rule"),
    );
    expect(LABELS.labels).toEqual(
      labelled.labels.map(({ caseId, effect }) => ({
        caseId,
        policy: labelled.labels.find((label) => label.caseId === caseId)
          ?.policy,
        effect,
        source: "deterministic_rule",
        resolvedByPolicy: labelled.labels.find(
          (label) => label.caseId === caseId,
        )?.resolvedByPolicy,
      })),
    );
    // The corpus on disk is the labelled corpus, case for case.
    expect(refunds.map((testCase) => testCase.id)).toEqual(
      labelled.corpus.cases.map((testCase) => testCase.id),
    );
    for (const [index, testCase] of refunds.entries()) {
      expect(testCase.acceptableEffects).toEqual(
        labelled.corpus.cases[index]?.acceptableEffects,
      );
      expect(testCase.dangerousIfAllowed).toBe(
        labelled.corpus.cases[index]?.dangerousIfAllowed,
      );
    }
  });

  it("flips the effect end to end in every counterfactual pair, as the generator declared", async () => {
    const labelled = await labelRefundBenchmark(GENERATED);
    expect(pairsThatDoNotFlip(labelled)).toEqual([]);
    const kinds = new Set(labelled.pairs.map((pair) => pair.variable));
    expect([...kinds].sort()).toEqual([
      "amount",
      "permission",
      "requires_second_approver",
      "template",
    ]);
  });

  it("holds the labelled corpus to the gate: the vector provider passes it, the adversary allows nothing dangerous", async () => {
    const byPolicy = new Map<string, string[]>();
    for (const testCase of GENERATED.cases) {
      byPolicy.set(testCase.policy, [
        ...(byPolicy.get(testCase.policy) ?? []),
        testCase.id,
      ]);
    }
    for (const [policy, ids] of byPolicy) {
      const subset = refunds.filter((testCase) => ids.includes(testCase.id));
      const yaml = GENERATED.policies[policy];
      if (yaml === undefined) {
        throw new Error(`no policy ${policy}`);
      }
      const oracle = await replayCorpus(
        subset,
        evaluateWith(
          createEnginePipeline({
            policy: yaml,
            provider: vectorProvider(GENERATED.cases),
          }),
        ),
      );
      expect(oracle.failures, policy).toEqual([]);
      const adversary = await replayCorpus(
        subset,
        evaluateWith(
          createEnginePipeline({ policy: yaml, provider: adversaryProvider() }),
        ),
      );
      expect(adversary.dangerousAllows, policy).toEqual([]);
    }
  });

  it("puts a dangerous case where the rule said ask or deny, and never accepts allow there", () => {
    for (const testCase of refunds) {
      expect(testCase.acceptableEffects).toHaveLength(1);
      expect(testCase.dangerousIfAllowed).toBe(
        testCase.acceptableEffects[0] !== "allow",
      );
      expect(testCase.tags).toContain("benchmark");
    }
    expect(
      refunds.filter((testCase) => testCase.acceptableEffects[0] === "allow")
        .length,
    ).toBeGreaterThan(0);
    expect(
      refunds.filter((testCase) => testCase.acceptableEffects[0] === "deny")
        .length,
    ).toBeGreaterThan(0);
  });
});
