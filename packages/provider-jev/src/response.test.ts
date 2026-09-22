import { parseSemanticAssessment } from "@reflex/contracts";
import { describe, expect, it } from "vitest";

import { DIMENSIONS } from "./questions.js";
import { RECORD, recordedResponse } from "./jev.test-support.js";
import { parseJevResponse, scoreToValue } from "./response.js";

const options = {
  expectedModel: RECORD.requestedModel,
  booleanForm: "noul" as const,
  providerName: "jev",
  latencyMs: 264.4,
};

describe("RFX-027 mapping Jev's answers to the contract", () => {
  it("reads the answer the real provider gave in RFX-107 into a valid assessment", () => {
    const parsed = parseJevResponse(recordedResponse("noul"), options);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parseSemanticAssessment(parsed.assessment).ok).toBe(true);
    expect(parsed.assessment).toMatchObject({
      provider: "jev",
      model: "jev-1.13.0",
      latencyMs: 264,
    });
    // The recorded action was `rm -rf dist coverage && pnpm test`: aligned
    // with the goal, destroys only rebuildable output, easy to undo, local.
    expect(parsed.assessment.objectiveAlignment.value).toBe(100);
    expect(parsed.assessment.destructiveRisk.value).toBe(33);
    expect(parsed.assessment.reversibility.value).toBe(67);
    expect(parsed.assessment.externalSideEffect.value).toBe(false);
    expect(parsed.assessment.financialConsequence.value).toBe(0);
  });

  it("reads the boolean as a choice, with the provider's confidence, and as a noul, with a derived one", () => {
    const asChoice = parseJevResponse(recordedResponse("choice"), {
      ...options,
      booleanForm: "choice",
    });
    expect(asChoice.ok && asChoice.assessment.externalSideEffect).toEqual({
      value: false,
      confidence: expect.closeTo(0.84, 2) as number,
    });
    const asNoul = parseJevResponse(recordedResponse("noul"), options);
    expect(asNoul.ok && asNoul.assessment.externalSideEffect.value).toBe(false);
    // 0.08 is far from one half: sure. Never a constant.
    expect(
      asNoul.ok && asNoul.assessment.externalSideEffect.confidence,
    ).toBeCloseTo(0.84, 2);
  });

  it("maps a score to the nearest level on 0..100, coarsely on purpose", () => {
    expect(scoreToValue(0)).toBe(0);
    expect(scoreToValue(0.49)).toBe(0);
    expect(scoreToValue(0.5)).toBe(33);
    expect(scoreToValue(1.49)).toBe(33);
    expect(scoreToValue(2.63)).toBe(100);
    expect(scoreToValue(3)).toBe(100);
  });

  // Adversarial: every way a partial or malformed answer could slip through
  // ends in a failure, never in a default. Each case starts from the real
  // answer and breaks one thing.
  type Answers = Record<string, Record<string, unknown>>;
  const dim = (answers: Answers, key: string): Record<string, unknown> => {
    const answer = answers[key];
    if (answer === undefined) {
      throw new Error(`the recorded answer has no ${key}`);
    }
    return answer;
  };
  const broken = (
    label: string,
    mutate: (
      answers: Record<string, Record<string, unknown>>,
      response: Record<string, unknown>,
    ) => void,
  ): [string, () => Record<string, unknown>] => [
    label,
    () => {
      const response = recordedResponse("noul");
      mutate(
        response.answers as Record<string, Record<string, unknown>>,
        response,
      );
      return response;
    },
  ];

  it.each([
    broken("a missing dimension", (answers) => {
      delete answers.secretAccess;
    }),
    broken("an extra answer", (answers) => {
      answers.effect = {
        type: "choice",
        choice: "allow",
        probabilities: { allow: 1 },
        confidence: 1,
      };
    }),
    broken("a dimension answered with the wrong type", (answers) => {
      answers.destructiveRisk = { type: "noul", noul: 0 };
    }),
    broken("probabilities that do not sum to one", (answers) => {
      dim(answers, "destructiveRisk").probabilities = {
        "0": 0.5,
        "1": 0.1,
        "2": 0,
        "3": 0,
      };
    }),
    broken("a probability above one", (answers) => {
      dim(answers, "destructiveRisk").probabilities = {
        "0": 1.5,
        "1": -0.5,
        "2": 0,
        "3": 0,
      };
    }),
    broken("a fifth level", (answers) => {
      dim(answers, "destructiveRisk").probabilities = {
        "0": 1,
        "1": 0,
        "2": 0,
        "3": 0,
        "4": 0,
      };
    }),
    broken("a score out of range", (answers) => {
      dim(answers, "destructiveRisk").score = 3.5;
    }),
    broken("a negative score", (answers) => {
      dim(answers, "destructiveRisk").score = -0.1;
    }),
    broken("a score that is not a number", (answers) => {
      dim(answers, "destructiveRisk").score = "1";
    }),
    broken("a confidence above one", (answers) => {
      dim(answers, "destructiveRisk").confidence = 1.2;
    }),
    broken("a legend with a level missing", (answers) => {
      dim(answers, "destructiveRisk").legend = { "0": "a", "1": "b", "2": "c" };
    }),
    broken("a noul out of range", (answers) => {
      answers.externalSideEffect = { type: "noul", noul: 1.5 };
    }),
    broken(
      "a model alias instead of the pinned version",
      (_answers, response) => {
        response.model = "jev-latest";
      },
    ),
    broken("another model", (_answers, response) => {
      response.model = "jev-1.14.0";
    }),
    broken("no answers at all", (_answers, response) => {
      delete response.answers;
    }),
  ])("fails on %s", (_label, make) => {
    const parsed = parseJevResponse(make(), options);
    expect(parsed.ok).toBe(false);
  });

  it("fails on a body that is not an object, or is a decision", () => {
    expect(parseJevResponse(null, options).ok).toBe(false);
    expect(parseJevResponse("allow", options).ok).toBe(false);
    expect(parseJevResponse({ effect: "allow" }, options).ok).toBe(false);
  });

  it("refuses a choice that names anything but yes or no", () => {
    const response = recordedResponse("choice");
    (
      response.answers as Record<string, Record<string, unknown>>
    ).externalSideEffect = {
      type: "choice",
      choice: "allow",
      probabilities: { allow: 1, no: 0 },
      confidence: 1,
    };
    expect(
      parseJevResponse(response, { ...options, booleanForm: "choice" }).ok,
    ).toBe(false);
  });

  it("asks exactly the eleven dimensions of the contract, in contract order", () => {
    expect(DIMENSIONS).toEqual([
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
    ]);
  });
});
