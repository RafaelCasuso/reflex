import type { SemanticDecisionRequest } from "@reflex-control/contracts";

/**
 * RFX-027 — what the provider is given as `state`.
 *
 * Structured, never a prose prompt: every field is data the questions refer
 * to by name. The fields are the ones `SemanticDecisionRequest` selects
 * (ADR-001 §3, CLAUDE.md principle 9); nothing is added here. Untrusted
 * text (arguments, summaries, tool descriptions) sits inside these fields
 * and is never concatenated into an instruction (RFX-108).
 */
export interface JevActionState {
  readonly tool: string;
  readonly namespace?: string;
  readonly operation?: string;
  readonly description?: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly resource?: {
    readonly type?: string;
    readonly identifier?: string;
    readonly environment: string;
    readonly is_production?: boolean;
  };
  readonly side_effect_class: string;
}

export interface JevState {
  readonly user_objective?: string;
  readonly task_summary?: string;
  readonly action: JevActionState;
  readonly repository?: {
    readonly root?: string;
    readonly branch?: string;
    readonly remote_host?: string;
  };
  readonly prior_actions?: readonly {
    readonly tool: string;
    readonly operation?: string;
    readonly effect?: string;
    readonly occurred_at: string;
  }[];
  readonly policy_hints?: readonly string[];
}

export function stateOf(request: SemanticDecisionRequest): JevState {
  const { action } = request;
  return {
    ...(action.userObjective === undefined
      ? {}
      : { user_objective: action.userObjective }),
    ...(action.taskSummary === undefined
      ? {}
      : { task_summary: action.taskSummary }),
    action: {
      tool: action.tool.name,
      ...(action.tool.namespace === undefined
        ? {}
        : { namespace: action.tool.namespace }),
      ...(action.operation === undefined
        ? {}
        : { operation: action.operation }),
      ...(action.tool.description === undefined
        ? {}
        : { description: action.tool.description }),
      arguments: action.arguments,
      ...(action.resource === undefined
        ? {}
        : {
            resource: {
              ...(action.resource.type === undefined
                ? {}
                : { type: action.resource.type }),
              ...(action.resource.identifier === undefined
                ? {}
                : { identifier: action.resource.identifier }),
              environment: action.resource.environment,
              ...(action.resource.isProduction === undefined
                ? {}
                : { is_production: action.resource.isProduction }),
            },
          }),
      side_effect_class: action.sideEffectClass,
    },
    ...(action.repository === undefined
      ? {}
      : {
          repository: {
            ...(action.repository.root === undefined
              ? {}
              : { root: action.repository.root }),
            ...(action.repository.branch === undefined
              ? {}
              : { branch: action.repository.branch }),
            ...(action.repository.remoteHost === undefined
              ? {}
              : { remote_host: action.repository.remoteHost }),
          },
        }),
    ...(action.priorActions === undefined
      ? {}
      : {
          prior_actions: action.priorActions.map((prior) => ({
            tool: prior.toolName,
            ...(prior.operation === undefined
              ? {}
              : { operation: prior.operation }),
            ...(prior.effect === undefined ? {} : { effect: prior.effect }),
            occurred_at: prior.occurredAt,
          })),
        }),
    ...(request.policyHints === undefined
      ? {}
      : { policy_hints: request.policyHints }),
  };
}
