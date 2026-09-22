import type { SemanticAssessment, SemanticSignal } from "@reflex/contracts";

import {
  DIMENSIONS,
  SCORE_LEVELS,
  type BooleanQuestionForm,
  type Dimension,
  type ScoreDimension,
} from "./questions.js";

/**
 * RFX-027 — the provider's answers, read strictly, into the contract.
 *
 * Malformed or partial output never becomes an implicit allow: a missing
 * answer, an unexpected type, probabilities that do not sum to one, a level
 * out of range, or a model other than the one requested is a failure, to be
 * handled by the fallback class, not a default to fill in
 * (`docs/jev-provider.md` §3, ADR-005 §3). Extra answers are a failure too:
 * eleven questions were asked, and the answer to anything else is not ours.
 *
 * A score is mapped coarsely on purpose: the expected level, rounded to the
 * nearest one, on an integer scale from 0 to 100. The vendor says not to
 * read magnitudes out of the space between two levels.
 */
export type JevParseResult =
  | { readonly ok: true; readonly assessment: SemanticAssessment }
  | { readonly ok: false; readonly problem: string };

const PROBABILITY_TOLERANCE = 0.02;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function probabilitiesSumToOne(
  probabilities: unknown,
  expectedKeys: readonly string[],
): boolean {
  if (!isRecord(probabilities)) {
    return false;
  }
  const keys = Object.keys(probabilities);
  if (
    keys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => keys.includes(key))
  ) {
    return false;
  }
  let sum = 0;
  for (const key of keys) {
    const probability = probabilities[key];
    if (!isUnit(probability)) {
      return false;
    }
    sum += probability;
  }
  return Math.abs(sum - 1) <= PROBABILITY_TOLERANCE;
}

/** The expected level, to the nearest one, on 0..100. */
export function scoreToValue(score: number): number {
  const level = Math.min(SCORE_LEVELS - 1, Math.max(0, Math.round(score)));
  return Math.round((level * 100) / (SCORE_LEVELS - 1));
}

function readScore(
  answer: unknown,
  dimension: ScoreDimension,
): SemanticSignal<number> | string {
  if (!isRecord(answer) || answer.type !== "score") {
    return `${dimension}: not a score answer`;
  }
  const { score, confidence, probabilities, legend } = answer;
  if (
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > SCORE_LEVELS - 1
  ) {
    return `${dimension}: score out of range`;
  }
  if (!isUnit(confidence)) {
    return `${dimension}: confidence out of range`;
  }
  const levels = Array.from({ length: SCORE_LEVELS }, (_, index) =>
    String(index),
  );
  if (!probabilitiesSumToOne(probabilities, levels)) {
    return `${dimension}: probabilities do not describe ${String(SCORE_LEVELS)} levels`;
  }
  if (!isRecord(legend) || Object.keys(legend).length !== SCORE_LEVELS) {
    return `${dimension}: legend does not name ${String(SCORE_LEVELS)} levels`;
  }
  return { value: scoreToValue(score), confidence };
}

function readBoolean(
  answer: unknown,
  form: BooleanQuestionForm,
): SemanticSignal<boolean> | string {
  if (!isRecord(answer)) {
    return "externalSideEffect: not an answer";
  }
  if (form === "choice") {
    if (answer.type !== "choice") {
      return "externalSideEffect: not a choice answer";
    }
    const { choice, confidence, probabilities } = answer;
    if (choice !== "yes" && choice !== "no") {
      return "externalSideEffect: choice is not yes or no";
    }
    if (!isUnit(confidence)) {
      return "externalSideEffect: confidence out of range";
    }
    if (!probabilitiesSumToOne(probabilities, ["yes", "no"])) {
      return "externalSideEffect: probabilities do not describe yes and no";
    }
    return { value: choice === "yes", confidence };
  }
  if (answer.type !== "noul" || !isUnit(answer.noul)) {
    return "externalSideEffect: not a noul answer in range";
  }
  // No confidence comes with a noul. The distance of the probability from
  // one half, on 0..1, is how sure the answer is; never a constant.
  const probability = answer.noul;
  return {
    value: probability >= 0.5,
    confidence: Math.abs(probability - 0.5) * 2,
  };
}

export interface JevParseOptions {
  readonly expectedModel: string;
  readonly booleanForm: BooleanQuestionForm;
  readonly providerName: string;
  readonly latencyMs: number;
}

export function parseJevResponse(
  body: unknown,
  options: JevParseOptions,
): JevParseResult {
  if (!isRecord(body)) {
    return { ok: false, problem: "body is not an object" };
  }
  if (body.model !== options.expectedModel) {
    // An alias moves when a release ships; the versioned id was requested
    // and anything else answered is not the model the thresholds were set on.
    return { ok: false, problem: "model is not the one requested" };
  }
  const answers = body.answers;
  if (!isRecord(answers)) {
    return { ok: false, problem: "answers missing" };
  }
  const keys = Object.keys(answers);
  if (
    keys.length !== DIMENSIONS.length ||
    !DIMENSIONS.every((dimension) => keys.includes(dimension))
  ) {
    return { ok: false, problem: "answers do not match the questions asked" };
  }

  const signals: Partial<
    Record<Dimension, SemanticSignal<number> | SemanticSignal<boolean>>
  > = {};
  for (const dimension of DIMENSIONS) {
    const read =
      dimension === "externalSideEffect"
        ? readBoolean(answers[dimension], options.booleanForm)
        : readScore(answers[dimension], dimension);
    if (typeof read === "string") {
      return { ok: false, problem: read };
    }
    signals[dimension] = read;
  }

  const numeric = (dimension: ScoreDimension): SemanticSignal<number> =>
    signals[dimension] as SemanticSignal<number>;
  return {
    ok: true,
    assessment: {
      objectiveAlignment: numeric("objectiveAlignment"),
      destructiveRisk: numeric("destructiveRisk"),
      reversibility: numeric("reversibility"),
      externalSideEffect: signals.externalSideEffect as SemanticSignal<boolean>,
      privilegeEscalation: numeric("privilegeEscalation"),
      secretAccess: numeric("secretAccess"),
      sensitiveDataExposure: numeric("sensitiveDataExposure"),
      financialConsequence: numeric("financialConsequence"),
      productionMutation: numeric("productionMutation"),
      unusualScope: numeric("unusualScope"),
      untrustedInput: numeric("untrustedInput"),
      provider: options.providerName,
      model: options.expectedModel,
      latencyMs: Math.max(0, Math.round(options.latencyMs)),
    },
  };
}
