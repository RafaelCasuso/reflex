import { join } from "node:path";

import {
  CONTRACT_VERSION,
  parseDecisionRecord,
  type ActionOutcome,
  type DecisionEffect,
  type DecisionFeedback,
  type DecisionLabel,
  type DecisionRecord,
  type EvaluationRole,
  type IsoTimestamp,
  type ProviderErrorKind,
  type RecordedEvaluation,
  type ReflexDecision,
  type SemanticAssessment,
  type SemanticDecisionRequest,
} from "@reflex-control/contracts";

import {
  RotatingJsonlLog,
  type AppendResult,
  type RotatingLogOptions,
} from "./rotating-log.js";

/**
 * RFX-143 — decision records (ADR-016 §4): the unit of training data.
 *
 * A record is built from what the engine observed after it answered: the
 * decision, the redacted request the primary was given, every provider's
 * answer or failure, and a label for what policy decided. An outcome and
 * feedback are joined later by id. Records are written off the decision
 * path to a local, size-rotated log kept seven days (ADR-008 §4, the
 * retention of redacted semantic context), and the never-stored list
 * (ADR-008 §3) holds: a record never sees the raw action, only the request
 * the redactor produced.
 */
export const DECISION_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export interface EvaluationInput {
  readonly provider: string;
  readonly model?: string;
  readonly role: EvaluationRole;
  readonly sampledOn?: "unresolved" | "resolved";
  readonly result:
    | { readonly ok: true; readonly assessment: SemanticAssessment }
    | {
        readonly ok: false;
        readonly error: {
          readonly kind: ProviderErrorKind;
          readonly retryable: boolean;
        };
      };
  readonly latencyMs: number;
}

export interface DecisionRecordInput {
  readonly decision: ReflexDecision;
  readonly request?: SemanticDecisionRequest;
  readonly evaluations: readonly EvaluationInput[];
  /** A rule or a policy default decided: the effect is a label. */
  readonly resolvedByPolicy: boolean;
  /** RFX-125: a human overrode a deny; the effect is a human label. */
  readonly humanOverride?: boolean;
  readonly recordedAt: IsoTimestamp;
}

const contractVersion = `${String(CONTRACT_VERSION.major)}.${String(CONTRACT_VERSION.minor)}`;

function evaluationOf(input: EvaluationInput): RecordedEvaluation {
  const base = {
    provider: input.provider,
    ...(input.model === undefined ? {} : { model: input.model }),
    role: input.role,
    ...(input.sampledOn === undefined ? {} : { sampledOn: input.sampledOn }),
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
  };
  return input.result.ok
    ? { ...base, assessment: input.result.assessment }
    : {
        ...base,
        error: {
          kind: input.result.error.kind,
          retryable: input.result.error.retryable,
        },
      };
}

/**
 * Pure. Copies from the decision what the record keeps and nothing else:
 * no cache key, no clock, no latency. The only label at this point is the
 * policy's own, when policy decided (`deterministic_rule`).
 */
export function decisionRecordOf(input: DecisionRecordInput): DecisionRecord {
  const { decision } = input;
  return {
    decisionId: decision.id,
    actionId: decision.actionId,
    recordedAt: input.recordedAt,
    contractVersion,
    ...(input.request === undefined ? {} : { request: input.request }),
    evaluations: input.evaluations.map(evaluationOf),
    decision: {
      effect: decision.effect,
      effectiveEffect: decision.effectiveEffect,
      mode: decision.mode,
      risk: decision.risk,
      confidence: decision.confidence,
      reasonCodes: decision.reasonCodes,
      policyMatches: decision.policyMatches,
      ...(decision.policySetHash === undefined
        ? {}
        : { policySetHash: decision.policySetHash }),
      ...(decision.fallback === undefined
        ? {}
        : { fallback: decision.fallback }),
    },
    labels:
      input.humanOverride === true
        ? [
            {
              kind: "effect",
              value: decision.effect,
              source: "human",
              at: input.recordedAt,
            },
          ]
        : input.resolvedByPolicy
          ? [
              {
                kind: "effect",
                value: decision.effect,
                source: "deterministic_rule",
                at: input.recordedAt,
              },
            ]
          : [],
  };
}

/**
 * What an outcome says, as labels: the human's answer is a `human` label,
 * and what the host did without asking anyone is a `production_outcome`.
 * `unknown` is never a label: it is not a guess (ADR-013).
 */
export function labelsFromOutcome(outcome: ActionOutcome): DecisionLabel[] {
  const labels: DecisionLabel[] = [];
  const at = outcome.observedAt;
  if (outcome.humanResponse === "approved") {
    labels.push({ kind: "effect", value: "allow", source: "human", at });
  } else if (outcome.humanResponse === "rejected") {
    labels.push({ kind: "effect", value: "deny", source: "human", at });
  }
  if (outcome.prompted === "no" && outcome.executed !== "unknown") {
    labels.push({
      kind: "effect",
      value: outcome.executed === "yes" ? "allow" : "deny",
      source: "production_outcome",
      at,
    });
  }
  return labels;
}

/** Feedback is a human's word on the effect: `correct` names the decision's. */
export function labelsFromFeedback(
  feedback: DecisionFeedback,
  decided: DecisionEffect,
): DecisionLabel[] {
  const value: DecisionEffect =
    feedback.value === "correct"
      ? decided
      : feedback.value === "should-allow"
        ? "allow"
        : feedback.value === "should-ask"
          ? "ask"
          : "deny";
  return [{ kind: "effect", value, source: "human", at: feedback.createdAt }];
}

/** Joined by `actionId`; another action's outcome is refused, not kept. */
export function withOutcome(
  record: DecisionRecord,
  outcome: ActionOutcome,
): DecisionRecord | undefined {
  if (outcome.actionId !== record.actionId) {
    return undefined;
  }
  return {
    ...record,
    outcome,
    labels: [...record.labels, ...labelsFromOutcome(outcome)],
  };
}

/** Joined by `decisionId`; feedback on another decision is refused. */
export function withFeedback(
  record: DecisionRecord,
  feedback: DecisionFeedback,
): DecisionRecord | undefined {
  if (feedback.decisionId !== record.decisionId) {
    return undefined;
  }
  return {
    ...record,
    feedback: [...(record.feedback ?? []), feedback],
    labels: [
      ...record.labels,
      ...labelsFromFeedback(feedback, record.decision.effect),
    ],
  };
}

export type DecisionRecordLogOptions = Omit<RotatingLogOptions, "baseName">;

function isDecisionRecord(value: unknown): value is DecisionRecord {
  return parseDecisionRecord(value).ok;
}

/** The local record log: `<REFLEX_HOME>/records/records.jsonl`, seven days. */
export class DecisionRecordLog {
  readonly #log: RotatingJsonlLog<DecisionRecord>;
  #pending: Promise<unknown> = Promise.resolve();
  #dropped = 0;

  constructor(options: DecisionRecordLogOptions) {
    this.#log = new RotatingJsonlLog<DecisionRecord>(
      {
        maxAgeMs: DECISION_RECORD_RETENTION_MS,
        ...options,
        baseName: "records",
      },
      isDecisionRecord,
    );
  }

  get activeFile(): string {
    return this.#log.activeFile;
  }

  /** Records the disk refused. Visible to `rfx status`, never to the host. */
  get dropped(): number {
    return this.#dropped;
  }

  /** Fire and forget, in order. A record is never allowed to fail a decision. */
  write(record: DecisionRecord): void {
    this.#pending = this.#pending.then(async () => {
      const result = await this.#log.append(record);
      if (!result.ok) {
        this.#dropped += 1;
      }
    });
  }

  async flush(): Promise<void> {
    await this.#pending;
  }

  append(record: DecisionRecord): Promise<AppendResult> {
    return this.#log.append(record);
  }

  /** The most recent records that parse, oldest first. */
  readRecent(limit: number): Promise<DecisionRecord[]> {
    return this.#log.readRecent(limit);
  }
}

export function defaultDecisionRecordDirectory(reflexHome: string): string {
  return join(reflexHome, "records");
}
