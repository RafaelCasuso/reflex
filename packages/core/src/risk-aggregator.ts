import type {
  Confidence,
  DecisionEffect,
  ReasonCode,
  RiskScore,
  SemanticAssessment,
  SideEffectClass,
} from "@reflex-control/contracts";
import { mostRestrictive } from "@reflex-control/policy-engine";

import { reasonForClass, riskOf } from "./risk.js";
import type {
  Aggregation,
  AggregationInput,
  RiskAggregator,
} from "./semantic-stage.js";

/**
 * RFX-036, RFX-037 — the risk aggregator, version 1.
 *
 * An assessment is evidence; this turns it into an effect, a risk and a
 * confidence, and the engine then applies what the aggregator may not go
 * under (ADR-002 §1, ADR-012). Every number that decides anything is in
 * one configuration object, `AggregatorConfig`, and nowhere else: a
 * threshold that lives in code is a threshold nobody can see, tune or
 * justify (RFX-110).
 *
 * The rule is the simplest one that can be explained to the person who is
 * asked: **each dimension is judged on its own against its band, and the
 * strictest verdict wins.** A risk dimension at or above its `ask` value
 * asks and at or above its `deny` value denies; a safety dimension (where
 * higher is safer) does the same below its values. Nothing is summed or
 * weighted: a weighted score is one more number to argue about, and a
 * dangerous dimension must not be averaged away by nine safe ones.
 */
export const RISK_DIMENSIONS = [
  "destructiveRisk",
  "privilegeEscalation",
  "secretAccess",
  "sensitiveDataExposure",
  "financialConsequence",
  "productionMutation",
  "unusualScope",
  "untrustedInput",
] as const;
export type RiskDimension = (typeof RISK_DIMENSIONS)[number];

export const SAFETY_DIMENSIONS = [
  "objectiveAlignment",
  "reversibility",
] as const;
export type SafetyDimension = (typeof SAFETY_DIMENSIONS)[number];

export type ScoredDimension = RiskDimension | SafetyDimension;

/**
 * For a risk dimension: `ask` at or above, `deny` at or above. For a safety
 * dimension: `ask` at or below, `deny` at or below. A band without `deny`
 * never denies on its own.
 */
export interface Band {
  readonly ask: number;
  readonly deny?: number;
}

export interface LowConfidenceRule {
  /**
   * A dimension whose confidence is below this is uncertain. Provisional
   * until RFX-110 measures it against the corpus; re-checked when the
   * provider or the model changes.
   */
  readonly threshold: Confidence;
  /** An action is high-impact when the class risk table puts it at or above this. */
  readonly highImpactClassRisk: RiskScore;
  /** Or when any risk dimension is at or above this. */
  readonly highImpactValue: number;
}

export interface AggregatorConfig {
  readonly risk: Readonly<Record<RiskDimension, Band>>;
  readonly safety: Readonly<Record<SafetyDimension, Band>>;
  /** What a true `externalSideEffect` does on its own. */
  readonly externalSideEffect: "allow" | "ask";
  readonly lowConfidence: LowConfidenceRule;
  /** Environment-specific rules: the least the effect may be there. */
  readonly environment: {
    readonly production: DecisionEffect;
  };
  /**
   * The least the effect may be for what the classifier called the action,
   * whatever the model said. The classifier read the command; a model that
   * calls a credential read harmless is wrong, or lied to (RFX-108), and
   * either way a human decides. A rule may still allow such an action:
   * deterministic policy runs first and never reaches this.
   */
  readonly classFloor: Partial<
    Readonly<Record<SideEffectClass, DecisionEffect>>
  >;
  /**
   * The least the effect may be when the request the provider saw carried a
   * redacted value (ADR-006): the arguments held a credential, whatever the
   * model made of the placeholder. Absent means no floor.
   */
  readonly redactedContent?: DecisionEffect;
}

/**
 * A four-level score maps to 0, 33, 67 and 100 (`packages/provider-jev`),
 * so a band is written in those values: `67` reads "at the third level or
 * above". The levels are the questions' own criteria: for `destructiveRisk`,
 * 33 is "only generated or temporary files that can be rebuilt", 67 is
 * "source files, configuration or user data in one project", 100 is
 * "broadly". Asking at 33 would prompt for `rm -rf dist`, which is the
 * prompt REFLEX exists to remove.
 */
export const DEFAULT_AGGREGATOR_CONFIG: AggregatorConfig = {
  risk: {
    destructiveRisk: { ask: 67, deny: 100 },
    privilegeEscalation: { ask: 67, deny: 100 },
    secretAccess: { ask: 67, deny: 100 },
    sensitiveDataExposure: { ask: 67, deny: 100 },
    financialConsequence: { ask: 67, deny: 100 },
    productionMutation: { ask: 67, deny: 100 },
    unusualScope: { ask: 67, deny: 100 },
    // Provenance escalates; on its own it does not deny.
    untrustedInput: { ask: 67 },
  },
  safety: {
    // Loosely related asks; unrelated or against the goal denies.
    objectiveAlignment: { ask: 33, deny: 0 },
    // Hard to undo asks; what cannot be undone still only asks on its own.
    reversibility: { ask: 33 },
  },
  externalSideEffect: "ask",
  lowConfidence: {
    threshold: 0.5,
    highImpactClassRisk: 50,
    highImpactValue: 67,
  },
  environment: {
    production: "ask",
  },
  // What the classifier itself calls dangerous or does not understand is
  // never allowed on semantic evidence alone. The model may lower what it
  // sees; it may not overrule what the command says, because a model can
  // be lied to (RFX-108) and the command cannot. Reads, local writes and
  // `none` are the model's to judge, which is where the semantic stage adds
  // autonomy today; a destructive action inside the project that the model
  // calls rebuildable is RFX-148's work.
  classFloor: {
    unknown: "ask",
    destructive: "ask",
    "external-write": "ask",
    credential: "ask",
    privilege: "ask",
    financial: "ask",
  },
  redactedContent: "ask",
};

/** ADR-006 §4: what a redacted value looks like in what the provider saw. */
const REDACTED = /\[REDACTED:[a-z-]+:[0-9a-f]{8}\]/;

export const REASON_BY_DIMENSION: Readonly<
  Record<ScoredDimension | "externalSideEffect", ReasonCode>
> = {
  destructiveRisk: "destructive",
  privilegeEscalation: "privilege_escalation",
  secretAccess: "secret_access",
  sensitiveDataExposure: "sensitive_data",
  financialConsequence: "financial_action",
  productionMutation: "production_mutation",
  unusualScope: "unusual_scope",
  untrustedInput: "untrusted_input",
  objectiveAlignment: "off_task",
  reversibility: "irreversible",
  externalSideEffect: "external_side_effect",
};

interface Verdict {
  readonly effect: DecisionEffect;
  readonly reason: ReasonCode;
  readonly confidence: Confidence;
}

function judgeRisk(
  dimension: RiskDimension,
  band: Band,
  assessment: SemanticAssessment,
): Verdict | undefined {
  const { value, confidence } = assessment[dimension];
  const reason = REASON_BY_DIMENSION[dimension];
  if (band.deny !== undefined && value >= band.deny) {
    return { effect: "deny", reason, confidence };
  }
  if (value >= band.ask) {
    return { effect: "ask", reason, confidence };
  }
  return undefined;
}

function judgeSafety(
  dimension: SafetyDimension,
  band: Band,
  assessment: SemanticAssessment,
): Verdict | undefined {
  const { value, confidence } = assessment[dimension];
  const reason = REASON_BY_DIMENSION[dimension];
  if (band.deny !== undefined && value <= band.deny) {
    return { effect: "deny", reason, confidence };
  }
  if (value <= band.ask) {
    return { effect: "ask", reason, confidence };
  }
  return undefined;
}

const clamp = (value: number): RiskScore =>
  Math.max(0, Math.min(100, Math.round(value)));

export function createRiskAggregator(
  config: AggregatorConfig = DEFAULT_AGGREGATOR_CONFIG,
): RiskAggregator {
  return {
    aggregate(input: AggregationInput): Aggregation {
      const { assessment, action, policy } = input;
      const verdicts: Verdict[] = [];

      for (const dimension of RISK_DIMENSIONS) {
        const verdict = judgeRisk(
          dimension,
          config.risk[dimension],
          assessment,
        );
        if (verdict !== undefined) {
          verdicts.push(verdict);
        }
      }
      for (const dimension of SAFETY_DIMENSIONS) {
        const verdict = judgeSafety(
          dimension,
          config.safety[dimension],
          assessment,
        );
        if (verdict !== undefined) {
          verdicts.push(verdict);
        }
      }
      if (
        assessment.externalSideEffect.value &&
        config.externalSideEffect === "ask"
      ) {
        verdicts.push({
          effect: "ask",
          reason: REASON_BY_DIMENSION.externalSideEffect,
          confidence: assessment.externalSideEffect.confidence,
        });
      }
      if (action.resource?.environment === "production") {
        verdicts.push({
          effect: config.environment.production,
          reason: "production_mutation",
          confidence: 1,
        });
      }
      const classFloor = config.classFloor[policy.sideEffectClass];
      if (classFloor !== undefined) {
        verdicts.push({
          effect: classFloor,
          reason: reasonForClass(policy.sideEffectClass) ?? "unknown_risk",
          confidence: 1,
        });
      }
      if (
        config.redactedContent !== undefined &&
        REDACTED.test(JSON.stringify(input.request.action.arguments))
      ) {
        verdicts.push({
          effect: config.redactedContent,
          reason: "secret_access",
          confidence: 1,
        });
      }

      let effect: DecisionEffect =
        mostRestrictive(verdicts.map((verdict) => verdict.effect)) ?? "allow";

      // The risk of the action: its worst dimension, and never below what
      // the classifier already knows about its class.
      const dimensionRisk = Math.max(
        ...RISK_DIMENSIONS.map((dimension) => assessment[dimension].value),
        ...SAFETY_DIMENSIONS.map(
          (dimension) => 100 - assessment[dimension].value,
        ),
      );
      const risk = clamp(
        Math.max(dimensionRisk, riskOf(policy.sideEffectClass)),
      );

      // The confidence of the decision: the least sure of what decided it.
      // An allow depends on every dimension being low, so the least sure
      // of all of them bounds it.
      const deciding = verdicts.filter((verdict) => verdict.effect === effect);
      const everyConfidence = [
        ...RISK_DIMENSIONS.map((dimension) => assessment[dimension].confidence),
        ...SAFETY_DIMENSIONS.map(
          (dimension) => assessment[dimension].confidence,
        ),
        assessment.externalSideEffect.confidence,
      ];
      const minimum = (values: readonly number[]): Confidence =>
        values.length === 0 ? 1 : Math.min(...values);
      let confidence = minimum(
        effect === "allow"
          ? everyConfidence
          : deciding.map((verdict) => verdict.confidence),
      );

      const reasons = new Set<ReasonCode>(
        verdicts
          .filter((verdict) => verdict.effect === effect)
          .map((verdict) => verdict.reason),
      );

      // RFX-037: an uncertain assessment of a high-impact action never
      // allows on its own. A low-confidence read still may: prompting for
      // what is trivially safe is what REFLEX exists to remove.
      if (effect === "allow") {
        const uncertain =
          minimum(everyConfidence) < config.lowConfidence.threshold;
        const highImpact =
          riskOf(policy.sideEffectClass) >=
            config.lowConfidence.highImpactClassRisk ||
          RISK_DIMENSIONS.some(
            (dimension) =>
              assessment[dimension].value >=
              config.lowConfidence.highImpactValue,
          );
        if (uncertain && highImpact) {
          effect = "ask";
          confidence = minimum(everyConfidence);
          reasons.add("low_confidence");
        }
      }

      return {
        effect,
        risk,
        confidence,
        reasonCodes: [...reasons],
      };
    },
  };
}
