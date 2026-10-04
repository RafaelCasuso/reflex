import {
  SIDE_EFFECT_CLASSES,
  type SemanticAssessment,
} from "@reflex-control/contracts";
import { assessmentForClass } from "@reflex-control/semantic-provider";
import { describe, expect, it } from "vitest";

import { classed, shell } from "./engine.test-support.js";
import {
  DEFAULT_AGGREGATOR_CONFIG,
  REASON_BY_DIMENSION,
  RISK_DIMENSIONS,
  SAFETY_DIMENSIONS,
  createRiskAggregator,
  type AggregatorConfig,
} from "./risk-aggregator.js";
import type { AggregationInput } from "./semantic-stage.js";

const sure = (value: number) => ({ value, confidence: 0.95 });

/** Every dimension safe and sure. */
function calm(overrides: Partial<SemanticAssessment> = {}): SemanticAssessment {
  return {
    objectiveAlignment: sure(100),
    destructiveRisk: sure(0),
    reversibility: sure(100),
    externalSideEffect: { value: false, confidence: 0.95 },
    privilegeEscalation: sure(0),
    secretAccess: sure(0),
    sensitiveDataExposure: sure(0),
    financialConsequence: sure(0),
    productionMutation: sure(0),
    unusualScope: sure(0),
    untrustedInput: sure(0),
    provider: "fake",
    model: "fake-1",
    latencyMs: 1,
    ...overrides,
  };
}

function input(
  assessment: SemanticAssessment,
  sideEffectClass: AggregationInput["policy"]["sideEffectClass"] = "local-read",
  environment?: "production" | "local",
  args: Readonly<Record<string, unknown>> = { command: "ls" },
): AggregationInput {
  const action = classed(shell("ls"), sideEffectClass);
  return {
    action:
      environment === undefined
        ? action
        : { ...action, resource: { environment } },
    request: {
      action: { tool: action.tool, arguments: args, sideEffectClass },
      maxInputTokens: 600,
      deadlineMs: 500,
    },
    assessment,
    policy: { matches: [], floor: undefined, sideEffectClass },
  };
}

const aggregate = createRiskAggregator();

describe("RFX-036 risk aggregator v1", () => {
  it("allows what every dimension calls safe, with the least sure confidence and the class's risk", () => {
    const result = aggregate.aggregate(input(calm()));
    expect(result).toEqual({
      effect: "allow",
      risk: 5,
      confidence: 0.95,
      reasonCodes: [],
    });
  });

  it.each(RISK_DIMENSIONS)(
    "%s at the middle level asks and at the high level denies when its band says so",
    (dimension) => {
      const band = DEFAULT_AGGREGATOR_CONFIG.risk[dimension];
      const asks = aggregate.aggregate(
        input(calm({ [dimension]: sure(band.ask) })),
      );
      expect(asks.effect).toBe("ask");
      expect(asks.reasonCodes).toEqual([REASON_BY_DIMENSION[dimension]]);
      expect(asks.risk).toBeGreaterThanOrEqual(band.ask);

      const high = aggregate.aggregate(input(calm({ [dimension]: sure(100) })));
      expect(high.effect).toBe(band.deny === undefined ? "ask" : "deny");
      expect(high.risk).toBe(100);

      const below = aggregate.aggregate(
        input(calm({ [dimension]: sure(band.ask - 1) })),
      );
      expect(below.effect).toBe("allow");
    },
  );

  it.each(SAFETY_DIMENSIONS)(
    "%s low asks, and lowest denies only where its band says so",
    (dimension) => {
      const band = DEFAULT_AGGREGATOR_CONFIG.safety[dimension];
      const asks = aggregate.aggregate(
        input(calm({ [dimension]: sure(band.ask) })),
      );
      expect(asks.effect).toBe("ask");
      expect(asks.reasonCodes).toEqual([REASON_BY_DIMENSION[dimension]]);

      const lowest = aggregate.aggregate(input(calm({ [dimension]: sure(0) })));
      expect(lowest.effect).toBe(band.deny === undefined ? "ask" : "deny");
      expect(lowest.risk).toBe(100);

      const fine = aggregate.aggregate(
        input(calm({ [dimension]: sure(band.ask + 1) })),
      );
      expect(fine.effect).toBe("allow");
    },
  );

  it("asks for an external side effect, and reports it", () => {
    const result = aggregate.aggregate(
      input(calm({ externalSideEffect: { value: true, confidence: 0.8 } })),
    );
    expect(result).toMatchObject({
      effect: "ask",
      confidence: 0.8,
      reasonCodes: ["external_side_effect"],
    });
  });

  it("never goes under ask in production, whatever the model said", () => {
    const result = aggregate.aggregate(
      input(calm(), "local-read", "production"),
    );
    expect(result.effect).toBe("ask");
    expect(result.reasonCodes).toEqual(["production_mutation"]);
    expect(
      aggregate.aggregate(input(calm(), "local-read", "local")).effect,
    ).toBe("allow");
  });

  it("keeps deny > ask > allow: one denying dimension decides, and only its reasons are given", () => {
    const result = aggregate.aggregate(
      input(
        calm({
          destructiveRisk: sure(100),
          unusualScope: sure(50),
          externalSideEffect: { value: true, confidence: 0.9 },
        }),
      ),
    );
    expect(result.effect).toBe("deny");
    expect(result.reasonCodes).toEqual(["destructive"]);
  });

  it("does not average a dangerous dimension away: nine safe ones and one at the deny level still deny", () => {
    const result = aggregate.aggregate(
      input(calm({ secretAccess: sure(100) })),
    );
    expect(result.effect).toBe("deny");
  });

  it("takes the confidence of what decided, and the least sure of everything for an allow", () => {
    const decided = aggregate.aggregate(
      input(
        calm({
          destructiveRisk: { value: 100, confidence: 0.6 },
          unusualScope: { value: 0, confidence: 0.2 },
        }),
      ),
    );
    expect(decided).toMatchObject({ effect: "deny", confidence: 0.6 });
    const allowed = aggregate.aggregate(
      input(calm({ unusualScope: { value: 0, confidence: 0.55 } })),
    );
    expect(allowed).toMatchObject({ effect: "allow", confidence: 0.55 });
  });

  it("never reports a risk below what the classifier already knows about the class", () => {
    for (const sideEffectClass of SIDE_EFFECT_CLASSES) {
      const result = aggregate.aggregate(input(calm(), sideEffectClass));
      expect(result.risk, sideEffectClass).toBeGreaterThanOrEqual(
        sideEffectClass === "none" ? 0 : 5,
      );
    }
    expect(aggregate.aggregate(input(calm(), "destructive")).risk).toBe(90);
  });

  // Every threshold is configuration: with the bands moved, the same
  // assessment decides differently, and nothing in code decides on its own.
  it("decides from its configuration and from nothing else", () => {
    const lenient: AggregatorConfig = {
      ...DEFAULT_AGGREGATOR_CONFIG,
      risk: Object.fromEntries(
        RISK_DIMENSIONS.map((dimension) => [dimension, { ask: 101 }]),
      ) as AggregatorConfig["risk"],
      safety: Object.fromEntries(
        SAFETY_DIMENSIONS.map((dimension) => [dimension, { ask: -1 }]),
      ) as AggregatorConfig["safety"],
      externalSideEffect: "allow",
      environment: { production: "allow" },
      lowConfidence: {
        threshold: 0,
        highImpactClassRisk: 101,
        highImpactValue: 101,
      },
    };
    const anything = calm({
      destructiveRisk: sure(100),
      objectiveAlignment: sure(0),
      externalSideEffect: { value: true, confidence: 1 },
    });
    expect(
      createRiskAggregator(lenient).aggregate(
        input(anything, "local-read", "production"),
      ).effect,
    ).toBe("allow");

    const strict: AggregatorConfig = {
      ...DEFAULT_AGGREGATOR_CONFIG,
      risk: Object.fromEntries(
        RISK_DIMENSIONS.map((dimension) => [dimension, { ask: 0, deny: 0 }]),
      ) as AggregatorConfig["risk"],
    };
    expect(createRiskAggregator(strict).aggregate(input(calm())).effect).toBe(
      "deny",
    );
  });

  it("names the reason for every dimension it can act on", () => {
    for (const dimension of [
      ...RISK_DIMENSIONS,
      ...SAFETY_DIMENSIONS,
      "externalSideEffect",
    ] as const) {
      expect(REASON_BY_DIMENSION[dimension]).toBeTypeOf("string");
    }
  });
});

describe("RFX-036 class floors", () => {
  // Adversarial: the provider calls everything harmless and is sure. The
  // classifier read the command; what it called dangerous stays a human's.
  it("never allows what the classifier called dangerous or did not understand, on semantic evidence alone", () => {
    for (const sideEffectClass of [
      "unknown",
      "destructive",
      "external-write",
      "credential",
      "privilege",
      "financial",
    ] as const) {
      const result = aggregate.aggregate(input(calm(), sideEffectClass));
      expect(result.effect, sideEffectClass).toBe("ask");
      expect(result.reasonCodes.length, sideEffectClass).toBe(1);
    }
  });

  it("leaves reads, local writes and nothing to the model, which is where the autonomy is today", () => {
    for (const sideEffectClass of [
      "none",
      "local-read",
      "external-read",
      "local-write",
    ] as const) {
      expect(
        aggregate.aggregate(input(calm(), sideEffectClass)).effect,
        sideEffectClass,
      ).toBe("allow");
    }
  });

  it("never allows a request whose arguments carried a redacted value", () => {
    const result = aggregate.aggregate(
      input(calm(), "local-write", undefined, {
        command: "echo [REDACTED:github-token:0123abcd] > .npmrc",
      }),
    );
    expect(result).toMatchObject({
      effect: "ask",
      reasonCodes: ["secret_access"],
    });
    // The placeholder's shape, not its words: a lookalike is not one.
    expect(
      aggregate.aggregate(
        input(calm(), "local-write", undefined, { command: "echo REDACTED" }),
      ).effect,
    ).toBe("allow");
  });

  it("is configuration: without the floors the same evidence allows", () => {
    const without = createRiskAggregator({
      ...DEFAULT_AGGREGATOR_CONFIG,
      classFloor: {},
    });
    expect(without.aggregate(input(calm(), "credential")).effect).toBe("allow");
    expect(without.aggregate(input(calm(), "destructive")).effect).toBe(
      "allow",
    );
    const strict = createRiskAggregator({
      ...DEFAULT_AGGREGATOR_CONFIG,
      classFloor: { "local-write": "deny" },
    });
    expect(strict.aggregate(input(calm(), "local-write")).effect).toBe("deny");
  });
});

describe("RFX-037 low-confidence escalation", () => {
  const unsure = (value: number) => ({ value, confidence: 0.2 });

  // Adversarial: the provider says everything is fine, but is not sure, about
  // an action the classifier calls dangerous. It must not be allowed.
  it("never allows a high-impact action on an uncertain assessment", () => {
    // The floored classes ask anyway; the rule is what holds the rest.
    for (const sideEffectClass of [
      "unknown",
      "external-write",
      "privilege",
      "credential",
      "destructive",
      "financial",
    ] as const) {
      const result = aggregate.aggregate(
        input(calm({ destructiveRisk: unsure(0) }), sideEffectClass),
      );
      expect(result.effect, sideEffectClass).toBe("ask");
    }
    const unfloored = createRiskAggregator({
      ...DEFAULT_AGGREGATOR_CONFIG,
      classFloor: {},
    });
    for (const sideEffectClass of [
      "unknown",
      "destructive",
      "financial",
    ] as const) {
      const result = unfloored.aggregate(
        input(calm({ destructiveRisk: unsure(0) }), sideEffectClass),
      );
      expect(result.effect, sideEffectClass).toBe("ask");
      expect(result.reasonCodes, sideEffectClass).toContain("low_confidence");
      expect(result.confidence).toBe(0.2);
    }
  });

  it("treats the third level on any risk dimension as high impact, whatever the class", () => {
    const belowImpact = aggregate.aggregate(
      input(
        calm({
          financialConsequence: { value: 33, confidence: 0.95 },
          unusualScope: { value: 0, confidence: 0.3 },
        }),
      ),
    );
    expect(belowImpact.effect).toBe("allow");
    // A dimension at the ask band already asks; the rule is about what
    // is under it, so the test raises the band to see the rule alone.
    const wideBands = createRiskAggregator({
      ...DEFAULT_AGGREGATOR_CONFIG,
      risk: {
        ...DEFAULT_AGGREGATOR_CONFIG.risk,
        financialConsequence: { ask: 101 },
      },
    });
    const impactful = wideBands.aggregate(
      input(
        calm({
          financialConsequence: { value: 67, confidence: 0.95 },
          unusualScope: { value: 0, confidence: 0.3 },
        }),
      ),
    );
    expect(impactful.effect).toBe("ask");
    expect(impactful.reasonCodes).toEqual(["low_confidence"]);
  });

  it("still allows a low-impact action on an uncertain assessment: prompting for a read is the cost REFLEX removes", () => {
    for (const sideEffectClass of [
      "none",
      "local-read",
      "local-write",
      "external-read",
    ] as const) {
      const result = aggregate.aggregate(
        input(calm({ unusualScope: unsure(0) }), sideEffectClass),
      );
      expect(result.effect, sideEffectClass).toBe("allow");
      expect(result.reasonCodes).not.toContain("low_confidence");
    }
  });

  it("is uncertain below the threshold, and not at it", () => {
    const unfloored = createRiskAggregator({
      ...DEFAULT_AGGREGATOR_CONFIG,
      classFloor: {},
    });
    const at = unfloored.aggregate(
      input(
        calm({ destructiveRisk: { value: 0, confidence: 0.5 } }),
        "destructive",
      ),
    );
    expect(at.effect).toBe("allow");
    const below = unfloored.aggregate(
      input(
        calm({ destructiveRisk: { value: 0, confidence: 0.49 } }),
        "destructive",
      ),
    );
    expect(below.effect).toBe("ask");
  });

  it("does not lower an ask or a deny because it is unsure", () => {
    const result = aggregate.aggregate(
      input(calm({ destructiveRisk: unsure(100) })),
    );
    expect(result.effect).toBe("deny");
  });

  it("uses the configured threshold and nothing else", () => {
    const strict = createRiskAggregator({
      ...DEFAULT_AGGREGATOR_CONFIG,
      lowConfidence: {
        threshold: 0.99,
        highImpactClassRisk: 0,
        highImpactValue: 0,
      },
    });
    expect(strict.aggregate(input(calm())).effect).toBe("ask");
    const off = createRiskAggregator({
      ...DEFAULT_AGGREGATOR_CONFIG,
      classFloor: {},
      lowConfidence: {
        threshold: 0,
        highImpactClassRisk: 0,
        highImpactValue: 0,
      },
    });
    expect(
      off.aggregate(input(calm({ destructiveRisk: unsure(0) }), "destructive"))
        .effect,
    ).toBe("allow");
  });

  it("holds through the fake provider's own answers for every class", () => {
    for (const sideEffectClass of SIDE_EFFECT_CLASSES) {
      const result = aggregate.aggregate(
        input(assessmentForClass(sideEffectClass), sideEffectClass),
      );
      if (
        [
          "destructive",
          "financial",
          "privilege",
          "credential",
          "external-write",
        ].includes(sideEffectClass)
      ) {
        expect(result.effect, sideEffectClass).not.toBe("allow");
      }
    }
  });
});
