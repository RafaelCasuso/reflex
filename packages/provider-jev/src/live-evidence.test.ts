import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SemanticAssessment } from "@reflex/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";

/**
 * RFX-107 — what the real provider answered and how long it took, held to
 * what `docs/jev-provider.md` says about it.
 *
 * `live/probe-latency.mjs` called the real TypeSafe API and recorded the
 * result. This suite runs offline on that record. It keeps three things true:
 *
 * 1. the numbers in the written result are the numbers that were measured;
 * 2. the answer shapes RFX-027 will map are the ones the provider really
 *    returns, including what is missing from them;
 * 3. nothing of the key or of the machine reached a checked-in file.
 *
 * The shapes below are Jev's and stay in this package (CLAUDE.md principle 3).
 */
const RESULTS_DIR = fileURLToPath(new URL("../live/results/", import.meta.url));
const WRITTEN_RESULT = fileURLToPath(
  new URL("../../../docs/jev-provider.md", import.meta.url),
);

/** Every assessed dimension of the contract, and nothing else. */
const CONTRACT_DIMENSIONS = [
  "objectiveAlignment",
  "destructiveRisk",
  "reversibility",
  "externalSideEffect",
  "privilegeEscalation",
  "secretAccess",
  "sensitiveDataExposure",
  "financialConsequence",
  "productionMutation",
  "unusualScope",
  "untrustedInput",
] as const satisfies readonly (keyof SemanticAssessment)[];

type Unassessed = Exclude<
  keyof SemanticAssessment,
  (typeof CONTRACT_DIMENSIONS)[number] | "provider" | "model" | "latencyMs"
>;

interface Summary {
  readonly min: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

interface Spread {
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly stddev: number;
}

interface VariantRecord {
  readonly id: string;
  readonly connection: "warm" | "cold";
  readonly requestsPerAction: number;
  readonly samples: number;
  readonly completeSamples: number;
  readonly statusCounts: Record<string, number>;
  readonly reusedSocketShare: number;
  readonly wallMs: Summary;
  readonly upstreamServiceMs?: Summary;
  readonly inputTokensPerAction: number;
  readonly usdPer1000Actions: number;
  readonly answers: Record<
    string,
    { readonly type: string; readonly value: Spread }
  >;
}

interface JevAnswer {
  readonly type: "score" | "noul" | "choice";
  readonly [field: string]: unknown;
}

interface ProbeRecord {
  readonly ticket: string;
  readonly requestedModel: string;
  readonly answeredModel: string | null;
  readonly usdPerMillionInputTokens: number;
  readonly samplesPerVariant: number;
  readonly dimensions: readonly string[];
  readonly variants: readonly VariantRecord[];
  readonly sample: {
    readonly response: {
      readonly model: string;
      readonly answers: Record<string, JevAnswer>;
      readonly usage: Record<string, number>;
    };
  };
}

const recordFiles = readdirSync(RESULTS_DIR).filter((file) =>
  file.endsWith(".json"),
);

function variantOf(record: ProbeRecord, id: string): VariantRecord {
  const found = record.variants.find((variant) => variant.id === id);
  if (found === undefined) {
    throw new Error(`the record has no variant "${id}"`);
  }
  return found;
}

it("assesses every dimension of the contract", () => {
  expectTypeOf<Unassessed>().toEqualTypeOf<never>();
  expect(recordFiles.length).toBeGreaterThan(0);
});

describe.each(recordFiles)("RFX-107 live record %s", (file) => {
  const raw = readFileSync(join(RESULTS_DIR, file), "utf8");
  const record = JSON.parse(raw) as ProbeRecord;
  const written = readFileSync(WRITTEN_RESULT, "utf8");

  it("measured a pinned model, and the provider says which one answered", () => {
    expect(record.ticket).toBe("RFX-107");
    // An alias moves; a threshold tuned against it would move with it.
    expect(record.requestedModel).not.toMatch(/latest|preview/);
    expect(record.answeredModel).toBe(record.requestedModel);
    expect(record.dimensions).toEqual(CONTRACT_DIMENSIONS);
  });

  it("has enough complete samples for a p95 to mean something", () => {
    expect(record.samplesPerVariant).toBeGreaterThanOrEqual(30);
    for (const variant of record.variants) {
      expect(variant.completeSamples, variant.id).toBe(variant.samples);
      expect(variant.statusCounts, variant.id).toEqual({
        "200": variant.samples * variant.requestsPerAction,
      });
      const { min, p50, p90, p95, max } = variant.wallMs;
      expect([min, p50, p90, p95, max], variant.id).toEqual(
        [min, p50, p90, p95, max].toSorted((a, b) => a - b),
      );
    }
  });

  it("really compared kept-open connections with new ones", () => {
    for (const variant of record.variants) {
      expect(variant.reusedSocketShare, variant.id).toBe(
        variant.connection === "warm" ? 1 : 0,
      );
    }
  });

  it("derives the cost from the tokens the provider billed", () => {
    for (const variant of record.variants) {
      expect(variant.usdPer1000Actions, variant.id).toBeCloseTo(
        (variant.inputTokensPerAction *
          1_000 *
          record.usdPerMillionInputTokens) /
          1_000_000,
        4,
      );
    }
  });

  // The written result is the ticket's deliverable. Its table is the record.
  it.each(record.variants.map((variant) => [variant.id, variant] as const))(
    "the written result reports what was measured: %s",
    (_id, variant) => {
      const cells = [
        `\`${variant.id}\``,
        String(variant.requestsPerAction),
        String(Math.round(variant.wallMs.p50)),
        String(Math.round(variant.wallMs.p95)),
        String(Math.round(variant.upstreamServiceMs?.p50 ?? Number.NaN)),
        String(Math.round(variant.upstreamServiceMs?.p95 ?? Number.NaN)),
        String(variant.inputTokensPerAction),
        `$${variant.usdPer1000Actions.toFixed(3)}`,
      ];
      const row = written
        .split("\n")
        .find((line) => line.startsWith(`| \`${variant.id}\` `));
      expect(row, `no table row for ${variant.id}`).toBeDefined();
      expect(
        row
          ?.split("|")
          .map((cell) => cell.trim())
          .filter((cell) => cell !== ""),
      ).toEqual(cells);
    },
  );

  describe("what the recommendation rests on", () => {
    it("one request is not slower at p95 than eleven, and costs a fraction", () => {
      const one = variantOf(record, "one-call");
      const eleven = variantOf(record, "parallel-11");
      expect(one.wallMs.p95).toBeLessThanOrEqual(eleven.wallMs.p95);
      expect(eleven.usdPer1000Actions).toBeGreaterThan(
        3 * one.usdPer1000Actions,
      );
    });

    // If a question were answered differently next to ten others, one request
    // would buy speed with accuracy. It is not: the difference stays inside
    // what the same request shows from one run to the next.
    it("a question gets the same answer alone as next to the other ten", () => {
      const together = variantOf(record, "one-call").answers;
      const alone = variantOf(record, "parallel-11").answers;
      for (const id of CONTRACT_DIMENSIONS) {
        const a = together[id]?.value;
        const b = alone[id]?.value;
        expect(a, id).toBeDefined();
        expect(b, id).toBeDefined();
        if (a === undefined || b === undefined) {
          continue;
        }
        const noise = 3 * Math.max(a.stddev, b.stddev) + 0.01;
        expect(Math.abs(a.mean - b.mean), id).toBeLessThanOrEqual(noise);
      }
    });

    it("a new connection per call costs more than the whole warm request", () => {
      const warm = variantOf(record, "one-call");
      const cold = variantOf(record, "one-call-cold");
      expect(cold.wallMs.p50).toBeGreaterThan(1.5 * warm.wallMs.p50);
    });

    // Replay against a golden corpus needs a provider that repeats itself.
    // It does, closely, and not exactly: thresholds need a margin.
    it("repeats its answers closely, and not bit for bit", () => {
      const spreads = Object.values(variantOf(record, "one-call").answers).map(
        (answer) => answer.value,
      );
      for (const value of spreads) {
        expect(value.stddev).toBeLessThan(0.05);
      }
      expect(spreads.some((value) => value.max > value.min)).toBe(true);
    });
  });

  describe("the answer shapes RFX-027 has to map", () => {
    const { answers, usage, model } = record.sample.response;

    it("answers every question under the id it was asked with", () => {
      expect(Object.keys(answers)).toEqual(CONTRACT_DIMENSIONS);
      expect(model).toBe(record.requestedModel);
      expect(usage.input_tokens).toBeGreaterThan(0);
    });

    it("a score carries a position, a distribution and a confidence", () => {
      const scores = Object.values(answers).filter(
        (answer) => answer.type === "score",
      );
      expect(scores).toHaveLength(10);
      for (const answer of scores) {
        expect(typeof answer.score).toBe("number");
        expect(typeof answer.confidence).toBe("number");
        const probabilities = answer.probabilities as Record<string, number>;
        expect(Object.keys(probabilities)).toEqual(
          Object.keys(answer.legend as Record<string, string>),
        );
        expect(
          Object.values(probabilities).reduce((sum, p) => sum + p, 0),
        ).toBeCloseTo(1, 1);
      }
    });

    // The contract requires a confidence for every dimension. The provider
    // gives none for a yes/no answer, so the mapping has to define one. It
    // must never be filled in silently with a constant.
    it("a noul carries a probability and no confidence at all", () => {
      const answer = answers.externalSideEffect;
      expect(answer).toMatchObject({ type: "noul" });
      expect(typeof answer?.noul).toBe("number");
      expect(answer).not.toHaveProperty("confidence");
    });
  });

  // The record is checked in. It must hold nothing of the key it was made
  // with, and nothing of the machine it ran on beyond platform and runtime.
  it("holds no credential, path or address", () => {
    for (const forbidden of [
      /apikey_/i,
      /Bearer\s/i,
      /authorization/i,
      /sk-[A-Za-z0-9]/,
      /\/Users\//,
      /\/home\//,
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/,
      /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
    ]) {
      expect(raw, String(forbidden)).not.toMatch(forbidden);
    }
  });
});
