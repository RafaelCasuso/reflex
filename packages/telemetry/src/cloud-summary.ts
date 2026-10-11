import {
  resolveEnvironment,
  type AgentId,
  type DecisionRecord,
  type DecisionSummary,
  type IngestEntry,
  type ReflexDecision,
} from "@reflex-control/contracts";

import type { ActionFacts, DecisionEvent } from "./decision-events.js";

/**
 * ADR-019 §4 — the decision summary a claimed installation uploads.
 *
 * Built from the decision and from the action's facts by name, like the
 * local event (RFX-023), and from nothing else: there is no field for an
 * argument, a path or a working directory, and the contract's parser is
 * strict about it. A decision of a project that is not claimed has no
 * summary at all, and the daemon writes nothing for it.
 */
export interface SummaryInput {
  readonly decision: ReflexDecision;
  readonly action: ActionFacts;
  /** The installation's identity (`identity.json`), when the action has none. */
  readonly agentId: AgentId;
}

/** Pure. `undefined` when the action names no project: nothing to attribute it to. */
export function decisionSummaryOf(
  input: SummaryInput,
): DecisionSummary | undefined {
  const { decision, action } = input;
  if (action.projectId === undefined) {
    return undefined;
  }
  return {
    decisionId: decision.id,
    actionId: decision.actionId,
    agentId: action.agent.id ?? input.agentId,
    projectId: action.projectId,
    ...(action.sessionId === undefined ? {} : { sessionId: action.sessionId }),
    decidedAt: decision.decidedAt,
    action: {
      host: action.agent.host,
      ...(action.agent.hostVersion === undefined
        ? {}
        : { hostVersion: action.agent.hostVersion }),
      toolName: action.tool.name,
      ...(action.tool.namespace === undefined
        ? {}
        : { toolNamespace: action.tool.namespace }),
      ...(action.operation === undefined
        ? {}
        : { operation: action.operation }),
      sideEffectClass: action.sideEffectClass,
      environment: resolveEnvironment(action),
      ...(action.repository?.branch === undefined
        ? {}
        : { branch: action.repository.branch }),
      ...(action.repository?.remoteHost === undefined
        ? {}
        : { remoteHost: action.repository.remoteHost }),
    },
    effect: decision.effect,
    effectiveEffect: decision.effectiveEffect,
    mode: decision.mode,
    risk: decision.risk,
    confidence: decision.confidence,
    reasonCodes: decision.reasonCodes,
    matchedRuleIds: decision.policyMatches.map((match) => match.ruleId),
    ...(decision.policySetHash === undefined
      ? {}
      : { policySetHash: decision.policySetHash }),
    cached: decision.cached,
    ...(decision.fallback === undefined ? {} : { fallback: decision.fallback }),
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
}

/**
 * A summary from a local decision event, for the history a claim enqueues
 * (ADR-019 §3). An event written before the ids and the class were recorded
 * (RFX-023 before G10) has no summary: the history starts where the facts do.
 */
export function summaryFromEvent(
  event: DecisionEvent,
  agentId: AgentId,
): DecisionSummary | undefined {
  // Events are read back from disk by shape only; an older event lacks the
  // fields this version writes, and the types do not say so.
  const partial: Partial<DecisionEvent> = event;
  if (
    event.projectId === undefined ||
    partial.sideEffectClass === undefined ||
    partial.environment === undefined
  ) {
    return undefined;
  }
  return {
    decisionId: event.decisionId,
    actionId: event.actionId,
    agentId: event.agentId ?? agentId,
    projectId: event.projectId,
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    decidedAt: event.at,
    action: {
      host: event.host,
      ...(event.hostVersion === undefined
        ? {}
        : { hostVersion: event.hostVersion }),
      toolName: event.toolName,
      ...(event.toolNamespace === undefined
        ? {}
        : { toolNamespace: event.toolNamespace }),
      ...(event.operation === undefined ? {} : { operation: event.operation }),
      sideEffectClass: event.sideEffectClass,
      environment: event.environment,
      ...(event.branch === undefined ? {} : { branch: event.branch }),
      ...(event.remoteHost === undefined
        ? {}
        : { remoteHost: event.remoteHost }),
    },
    effect: event.effect,
    effectiveEffect: event.effectiveEffect,
    mode: event.mode,
    risk: event.risk,
    confidence: event.confidence,
    reasonCodes: event.reasonCodes,
    matchedRuleIds: event.matchedRuleIds,
    ...(event.policySetHash === undefined
      ? {}
      : { policySetHash: event.policySetHash }),
    cached: event.cached,
    ...(event.fallbackUsed ? { fallback: { used: true } } : {}),
    ...(event.provider === undefined ? {} : { provider: event.provider }),
    ...(event.model === undefined ? {} : { model: event.model }),
    latency: event.latency,
  };
}

/** The outbox entry for a decision, with its record when one was written. */
export function decisionEntryOf(
  summary: DecisionSummary,
  record?: DecisionRecord,
): IngestEntry {
  return {
    kind: "decision",
    summary,
    ...(record === undefined ? {} : { record }),
  };
}
