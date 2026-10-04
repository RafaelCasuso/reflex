import type { SemanticAssessment } from "@reflex-control/contracts";
import type { SemanticDecisionProvider } from "@reflex-control/semantic-provider";

import {
  SCORED_ASSESSMENT_DIMENSIONS,
  type CorpusCase,
  type ExpectedAssessment,
} from "./corpus.js";

/**
 * RFX-110 — confidence calibration.
 *
 * A model's self-reported confidence is not calibrated until someone
 * measures it. This runs a provider over every case that says what a right
 * assessment is, bins each answer by the confidence the provider gave it,
 * and reports, per dimension and per bin, how often the answer was right.
 * From that table it proposes the low-confidence threshold RFX-037 uses:
 * the lowest confidence at which answers are right at least as often as
 * the target says.
 *
 * Offline against the fake provider the table is exact and uninteresting;
 * against a real provider it is the justification for the threshold, and
 * it is re-run whenever the provider or the model changes.
 */
export const CONFIDENCE_BINS = 10;

export interface CalibrationBin {
  /** `[from, to)`, on 0..1; the last bin includes 1. */
  readonly from: number;
  readonly to: number;
  readonly answers: number;
  readonly right: number;
  /** `right / answers`, or `undefined` for an empty bin. */
  readonly accuracy: number | undefined;
}

export interface DimensionReliability {
  readonly dimension: keyof ExpectedAssessment;
  readonly answers: number;
  readonly right: number;
  readonly accuracy: number | undefined;
  readonly bins: readonly CalibrationBin[];
  /**
   * The lowest bin's lower bound from which every bin at or above it is at
   * least `target` accurate, or `undefined` when none is.
   */
  readonly suggestedThreshold: number | undefined;
}

export interface CalibrationReport {
  readonly provider: string;
  readonly model: string | undefined;
  readonly target: number;
  readonly cases: number;
  readonly unassessed: number;
  readonly dimensions: readonly DimensionReliability[];
  /** The highest of the per-dimension suggestions: the one that holds for all. */
  readonly suggestedThreshold: number | undefined;
}

type Dimension = keyof ExpectedAssessment;

interface Answer {
  readonly confidence: number;
  readonly right: boolean;
}

function binIndex(confidence: number): number {
  return Math.min(
    CONFIDENCE_BINS - 1,
    Math.max(0, Math.floor(confidence * CONFIDENCE_BINS)),
  );
}

function isRight(
  expected: ExpectedAssessment,
  dimension: Dimension,
  assessment: SemanticAssessment,
): boolean | undefined {
  if (dimension === "externalSideEffect") {
    const wanted = expected.externalSideEffect;
    return wanted === undefined
      ? undefined
      : assessment.externalSideEffect.value === wanted;
  }
  const accepted = expected[dimension];
  if (accepted === undefined) {
    return undefined;
  }
  return (accepted as readonly number[]).includes(assessment[dimension].value);
}

function confidenceOf(
  dimension: Dimension,
  assessment: SemanticAssessment,
): number {
  return dimension === "externalSideEffect"
    ? assessment.externalSideEffect.confidence
    : assessment[dimension].confidence;
}

function reliabilityOf(
  dimension: Dimension,
  answers: readonly Answer[],
  target: number,
): DimensionReliability {
  const counts = Array.from({ length: CONFIDENCE_BINS }, () => ({
    answers: 0,
    right: 0,
  }));
  for (const answer of answers) {
    const bin = counts[binIndex(answer.confidence)];
    if (bin !== undefined) {
      bin.answers += 1;
      bin.right += answer.right ? 1 : 0;
    }
  }
  const bins: CalibrationBin[] = counts.map((bin, index) => ({
    from: index / CONFIDENCE_BINS,
    to: (index + 1) / CONFIDENCE_BINS,
    answers: bin.answers,
    right: bin.right,
    accuracy: bin.answers === 0 ? undefined : bin.right / bin.answers,
  }));
  // From the top down: the threshold is where the run of good-enough bins
  // starts. An empty bin neither helps nor breaks the run.
  let suggestedThreshold: number | undefined;
  for (let index = bins.length - 1; index >= 0; index -= 1) {
    const bin = bins[index];
    if (bin === undefined) {
      continue;
    }
    if (bin.accuracy !== undefined && bin.accuracy < target) {
      break;
    }
    if (bin.accuracy !== undefined) {
      suggestedThreshold = bin.from;
    }
  }
  const right = answers.filter((answer) => answer.right).length;
  return {
    dimension,
    answers: answers.length,
    right,
    accuracy: answers.length === 0 ? undefined : right / answers.length,
    bins,
    suggestedThreshold,
  };
}

export interface CalibrationOptions {
  /** How often an answer must be right for its confidence to be trusted. */
  readonly target?: number;
  /** What the provider is asked for each case; the corpus's action by default. */
  readonly requestOf?: (
    testCase: CorpusCase,
  ) => Parameters<SemanticDecisionProvider["evaluate"]>[0];
}

export async function calibrate(
  provider: SemanticDecisionProvider,
  cases: readonly CorpusCase[],
  options: CalibrationOptions = {},
): Promise<CalibrationReport> {
  const target = options.target ?? 0.9;
  const requestOf =
    options.requestOf ??
    ((testCase: CorpusCase) => ({
      action: {
        ...(testCase.action.userObjective === undefined
          ? {}
          : { userObjective: testCase.action.userObjective }),
        ...(testCase.action.taskSummary === undefined
          ? {}
          : { taskSummary: testCase.action.taskSummary }),
        tool: testCase.action.tool,
        ...(testCase.action.operation === undefined
          ? {}
          : { operation: testCase.action.operation }),
        arguments: testCase.action.arguments,
        ...(testCase.action.resource === undefined
          ? {}
          : { resource: testCase.action.resource }),
        sideEffectClass: testCase.action.sideEffectClass,
      },
      maxInputTokens: 600,
      deadlineMs: 5_000,
    }));
  const answers = new Map<Dimension, Answer[]>();
  const dimensions: Dimension[] = [
    ...SCORED_ASSESSMENT_DIMENSIONS,
    "externalSideEffect",
  ];
  for (const dimension of dimensions) {
    answers.set(dimension, []);
  }
  let unassessed = 0;
  let assessed = 0;
  for (const testCase of cases) {
    if (testCase.expectedAssessment === undefined) {
      continue;
    }
    assessed += 1;
    const result = await provider.evaluate(requestOf(testCase));
    if (!result.ok) {
      unassessed += 1;
      continue;
    }
    for (const dimension of dimensions) {
      const right = isRight(
        testCase.expectedAssessment,
        dimension,
        result.assessment,
      );
      if (right === undefined) {
        continue;
      }
      answers.get(dimension)?.push({
        confidence: confidenceOf(dimension, result.assessment),
        right,
      });
    }
  }
  const reliability = dimensions.map((dimension) =>
    reliabilityOf(dimension, answers.get(dimension) ?? [], target),
  );
  const suggestions = reliability
    .map((entry) => entry.suggestedThreshold)
    .filter((value): value is number => value !== undefined);
  return {
    provider: provider.providerName,
    model: provider.model,
    target,
    cases: assessed,
    unassessed,
    dimensions: reliability,
    suggestedThreshold:
      suggestions.length === 0 ? undefined : Math.max(...suggestions),
  };
}

/** One line per dimension, for a terminal or a document. */
export function describeCalibration(report: CalibrationReport): string[] {
  return report.dimensions.map((entry) => {
    const accuracy =
      entry.accuracy === undefined
        ? "n/a"
        : `${(entry.accuracy * 100).toFixed(0)}%`;
    const threshold =
      entry.suggestedThreshold === undefined
        ? "none"
        : entry.suggestedThreshold.toFixed(1);
    return `${entry.dimension}: ${String(entry.right)}/${String(entry.answers)} right (${accuracy}), threshold ${threshold}`;
  });
}
