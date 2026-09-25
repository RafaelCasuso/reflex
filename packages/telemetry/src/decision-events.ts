import type {
  ActionId,
  CanonicalAction,
  DecisionEffect,
  DecisionLatency,
  DecisionId,
  FailureMode,
  FallbackReason,
  HostKind,
  IsoTimestamp,
  ReasonCode,
  ReflexDecision,
  ReflexMode,
  RiskScore,
} from "@reflex/contracts";

/**
 * RFX-023 — structured decision telemetry (`docs/architecture.md` §13).
 *
 * An event is built from a decision and from three fields of the action
 * selected by name: the host, the tool and nothing else. No argument, no
 * operand, no path, no working directory, no objective ever gets here, and
 * `decision-events.test.ts` runs canary values through the whole engine to
 * hold that (ADR-008 §3).
 */
export const DECISION_EVENT_VERSION = 1;

export type RiskBucket = "low" | "medium" | "high" | "critical";

export function riskBucketOf(risk: RiskScore): RiskBucket {
  if (risk < 25) {
    return "low";
  }
  if (risk < 50) {
    return "medium";
  }
  if (risk < 80) {
    return "high";
  }
  return "critical";
}

export interface DecisionEvent {
  readonly kind: "decision";
  readonly eventVersion: typeof DECISION_EVENT_VERSION;
  readonly at: IsoTimestamp;
  readonly decisionId: DecisionId;
  readonly actionId: ActionId;
  readonly requestId?: string;
  readonly host: HostKind;
  readonly hostVersion?: string;
  readonly toolName: string;
  readonly toolNamespace?: string;
  readonly mode: ReflexMode;
  readonly effect: DecisionEffect;
  readonly effectiveEffect: DecisionEffect;
  readonly risk: RiskScore;
  readonly riskBucket: RiskBucket;
  readonly confidence: number;
  readonly reasonCodes: readonly ReasonCode[];
  readonly matchedRuleIds: readonly string[];
  readonly policySetHash?: string;
  readonly cached: boolean;
  readonly fallbackUsed: boolean;
  /** RFX-030: which provider and model answered, when one did. */
  readonly provider?: string;
  readonly model?: string;
  readonly latency: DecisionLatency;
}

/** ADR-003 §5: a fallback is a telemetry event of its own. */
export interface FallbackEvent {
  readonly kind: "fallback";
  readonly eventVersion: typeof DECISION_EVENT_VERSION;
  readonly at: IsoTimestamp;
  readonly decisionId: DecisionId;
  readonly reason: FallbackReason | undefined;
  readonly configuredMode: FailureMode | undefined;
  readonly effect: DecisionEffect;
  readonly mode: ReflexMode;
  readonly host: HostKind;
}

/** A request the gateway turned away before deciding anything (RFX-119). */
export const REJECTION_CODES = [
  "invalid-request",
  "payload-too-large",
  "rate-limited",
  "idempotency-conflict",
  "unsupported-media-type",
  "not-found",
  "method-not-allowed",
  "internal-error",
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

export interface RejectedRequestEvent {
  readonly kind: "rejected";
  readonly eventVersion: typeof DECISION_EVENT_VERSION;
  readonly at: IsoTimestamp;
  readonly code: RejectionCode;
  readonly requestId?: string;
}

/**
 * RFX-142: a shadow evaluation, when it settled (ADR-016 §3). Its own event,
 * never a fallback: how it did says nothing about the decision. No content:
 * whether it answered, how it failed, and how long it took.
 */
export interface ShadowEvent {
  readonly kind: "shadow";
  readonly eventVersion: typeof DECISION_EVENT_VERSION;
  readonly at: IsoTimestamp;
  readonly decisionId: DecisionId;
  readonly actionId: ActionId;
  readonly provider: string;
  readonly model?: string;
  readonly sampledOn: "unresolved" | "resolved";
  readonly outcome: "assessed" | "failed";
  readonly errorKind?: string;
  readonly latencyMs: number;
}

export interface ShadowEventInput {
  readonly decisionId: DecisionId;
  readonly actionId: ActionId;
  readonly provider: string;
  readonly model?: string;
  readonly sampledOn: "unresolved" | "resolved";
  readonly result:
    | { readonly ok: true }
    | { readonly ok: false; readonly error: { readonly kind: string } };
  readonly latencyMs: number;
  readonly at: IsoTimestamp;
}

/** Pure. Reads the outcome and nothing of the assessment. */
export function shadowEventOf(input: ShadowEventInput): ShadowEvent {
  return {
    kind: "shadow",
    eventVersion: DECISION_EVENT_VERSION,
    at: input.at,
    decisionId: input.decisionId,
    actionId: input.actionId,
    provider: input.provider,
    ...(input.model === undefined ? {} : { model: input.model }),
    sampledOn: input.sampledOn,
    outcome: input.result.ok ? "assessed" : "failed",
    ...(input.result.ok ? {} : { errorKind: input.result.error.kind }),
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
  };
}

export type TelemetryEvent =
  DecisionEvent | FallbackEvent | RejectedRequestEvent | ShadowEvent;

export interface TelemetrySink {
  /** Never on the decision path: called after the answer has been written. */
  emit(event: TelemetryEvent): void;
}

export interface DecisionEventInput {
  readonly decision: ReflexDecision;
  readonly action: Pick<CanonicalAction, "agent" | "tool">;
  readonly at: IsoTimestamp;
  readonly requestId?: string;
}

/** Pure. The decision event, and the fallback event when one was used. */
export function decisionEventsOf(
  input: DecisionEventInput,
): readonly TelemetryEvent[] {
  const { decision, action, at } = input;
  const event: DecisionEvent = {
    kind: "decision",
    eventVersion: DECISION_EVENT_VERSION,
    at,
    decisionId: decision.id,
    actionId: decision.actionId,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    host: action.agent.host,
    ...(action.agent.hostVersion === undefined
      ? {}
      : { hostVersion: action.agent.hostVersion }),
    toolName: action.tool.name,
    ...(action.tool.namespace === undefined
      ? {}
      : { toolNamespace: action.tool.namespace }),
    mode: decision.mode,
    effect: decision.effect,
    effectiveEffect: decision.effectiveEffect,
    risk: decision.risk,
    riskBucket: riskBucketOf(decision.risk),
    confidence: decision.confidence,
    reasonCodes: decision.reasonCodes,
    matchedRuleIds: decision.policyMatches.map((match) => match.ruleId),
    ...(decision.policySetHash === undefined
      ? {}
      : { policySetHash: decision.policySetHash }),
    cached: decision.cached,
    fallbackUsed: decision.fallback?.used === true,
    ...(decision.semanticAssessment === undefined
      ? {}
      : {
          provider: decision.semanticAssessment.provider,
          ...(decision.semanticAssessment.model === undefined
            ? {}
            : { model: decision.semanticAssessment.model }),
        }),
    latency: decision.latency,
  };
  if (decision.fallback?.used !== true) {
    return [event];
  }
  const fallback: FallbackEvent = {
    kind: "fallback",
    eventVersion: DECISION_EVENT_VERSION,
    at,
    decisionId: decision.id,
    reason: decision.fallback.reason,
    configuredMode: decision.fallback.configuredMode,
    effect: decision.effect,
    mode: decision.mode,
    host: action.agent.host,
  };
  return [event, fallback];
}

export function rejectedRequestEvent(
  code: RejectionCode,
  at: IsoTimestamp,
  requestId?: string,
): RejectedRequestEvent {
  return {
    kind: "rejected",
    eventVersion: DECISION_EVENT_VERSION,
    at,
    code,
    ...(requestId === undefined ? {} : { requestId }),
  };
}
