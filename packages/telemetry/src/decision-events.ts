import {
  resolveEnvironment,
  type ActionId,
  type AgentId,
  type CanonicalAction,
  type DecisionEffect,
  type DecisionLatency,
  type DecisionId,
  type EnvironmentKind,
  type FailureMode,
  type FallbackReason,
  type HostKind,
  type IsoTimestamp,
  type ProjectId,
  type ReasonCode,
  type ReflexDecision,
  type ReflexMode,
  type RiskScore,
  type SessionId,
  type SideEffectClass,
} from "@reflex-control/contracts";

/**
 * RFX-023 — structured decision telemetry (`docs/architecture.md` §13).
 *
 * An event is built from a decision and from fields of the action selected
 * by name: the host, the tool, the operation, the class, the environment,
 * the branch and remote host, and the ids (ADR-019). No argument, no
 * operand, no path, no working directory, no objective ever gets here, and
 * the gateway's telemetry test runs canary values through the whole engine
 * to hold that (ADR-008 §3).
 */
export const DECISION_EVENT_VERSION = 1;

/**
 * The action, by name. Structurally what `@reflex-control/core` observes
 * (`ObservedAction`); declared here so that this package depends on the
 * contracts alone. The repository is its branch and remote host, never its
 * root on disk.
 */
export type ActionFacts = Pick<
  CanonicalAction,
  | "agent"
  | "tool"
  | "projectId"
  | "sessionId"
  | "operation"
  | "sideEffectClass"
  | "resource"
> & {
  readonly repository?: Pick<
    NonNullable<CanonicalAction["repository"]>,
    "branch" | "remoteHost"
  >;
};

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
  /** ADR-019: the tenancy ids the action carried, when it carried them. */
  readonly agentId?: AgentId;
  readonly projectId?: ProjectId;
  readonly sessionId?: SessionId;
  readonly host: HostKind;
  readonly hostVersion?: string;
  readonly toolName: string;
  readonly toolNamespace?: string;
  readonly operation?: string;
  readonly sideEffectClass: SideEffectClass;
  readonly environment: EnvironmentKind;
  readonly branch?: string;
  readonly remoteHost?: string;
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
  // RFX-125: an override that could not be granted.
  "override-refused",
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

/**
 * RFX-125: a human overrode a deny, once. The decision that then lets the
 * action through carries `human_override` in its own event; this one counts
 * the grant itself, for the human override rate (CLAUDE.md), whether or not
 * the agent retries.
 */
export interface OverrideEvent {
  readonly kind: "override";
  readonly eventVersion: typeof DECISION_EVENT_VERSION;
  readonly at: IsoTimestamp;
  /** The denied decision that was overridden. */
  readonly decisionId: DecisionId;
  readonly requestId?: string;
}

export function overrideEventOf(
  decisionId: DecisionId,
  at: IsoTimestamp,
  requestId?: string,
): OverrideEvent {
  return {
    kind: "override",
    eventVersion: DECISION_EVENT_VERSION,
    at,
    decisionId,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

export type TelemetryEvent =
  | DecisionEvent
  | FallbackEvent
  | RejectedRequestEvent
  | ShadowEvent
  | OverrideEvent;

export interface TelemetrySink {
  /** Never on the decision path: called after the answer has been written. */
  emit(event: TelemetryEvent): void;
}

export interface DecisionEventInput {
  readonly decision: ReflexDecision;
  readonly action: ActionFacts;
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
    ...(action.agent.id === undefined ? {} : { agentId: action.agent.id }),
    ...(action.projectId === undefined ? {} : { projectId: action.projectId }),
    ...(action.sessionId === undefined ? {} : { sessionId: action.sessionId }),
    host: action.agent.host,
    ...(action.agent.hostVersion === undefined
      ? {}
      : { hostVersion: action.agent.hostVersion }),
    toolName: action.tool.name,
    ...(action.tool.namespace === undefined
      ? {}
      : { toolNamespace: action.tool.namespace }),
    ...(action.operation === undefined ? {} : { operation: action.operation }),
    sideEffectClass: action.sideEffectClass,
    environment: resolveEnvironment(action),
    ...(action.repository?.branch === undefined
      ? {}
      : { branch: action.repository.branch }),
    ...(action.repository?.remoteHost === undefined
      ? {}
      : { remoteHost: action.repository.remoteHost }),
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
