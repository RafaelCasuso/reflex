import type {
  ClaudeToolEvent,
  TranslationContext,
} from "@reflex/adapter-claude-code/hook";
import { toCanonicalAction } from "@reflex/adapter-claude-code/hook";
import type {
  DecisionEffect,
  FailureMode,
  ProjectId,
  ReflexDecision,
  ReflexMode,
} from "@reflex/contracts";

import { requestOverSocket } from "../daemon/client.js";
import { daemonPaths, ensureDaemon } from "../daemon/lifecycle.js";

/**
 * RFX-043 — from a `PreToolUse` event to the host's permission decision.
 *
 * The hook asks the daemon, once, inside its own deadline, after starting
 * it once if it does not answer (RFX-138). What comes back is mapped to
 * what Claude Code understands on `PreToolUse`:
 *
 *   permissionDecision: allow   the call runs, no prompt
 *   permissionDecision: ask     the host's own approval flow decides
 *   permissionDecision: deny    the call is blocked
 *
 * `ask` is native delegation and nothing else (CLAUDE.md principle 4): no
 * dialog of REFLEX's own. The effect mapped is `effectiveEffect`, which the
 * engine already computed for the mode (ADR-002): in Assist a deny arrives
 * as ask. When the daemon cannot be reached at all, the client answers by
 * itself (ADR-003 §4): ask, or deny in Autopilot under fail-closed; never
 * silence, never an exit code, never a value from the arguments.
 */
export interface HookAnswer {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: DecisionEffect;
    readonly permissionDecisionReason: string;
  };
}

export interface DecideOptions {
  readonly home: string;
  readonly nodePath: string;
  readonly mode: Exclude<ReflexMode, "observe">;
  readonly failureMode: FailureMode;
  readonly projectId?: ProjectId;
  readonly hostVersion?: string;
  readonly now: () => Date;
  /** The whole budget, start of the daemon included. Under the host's 5 s. */
  readonly budgetMs?: number;
  /** For tests. */
  readonly daemonEntry?: string;
}

export type DecideOutcome =
  | {
      readonly kind: "decided";
      readonly decision: ReflexDecision;
      readonly answer: HookAnswer;
    }
  | {
      readonly kind: "fallback";
      readonly reason: FallbackWhy;
      readonly answer: HookAnswer;
    };

export type FallbackWhy =
  | "daemon-unavailable"
  | "daemon-timeout"
  | "daemon-rejected"
  | "malformed-answer";

export const DEFAULT_BUDGET_MS = 2_500;
/** What the daemon may spend on the decision itself, once reached. */
const MIN_REQUEST_MS = 300;
const START_SHARE = 0.6;

export function answerFor(effect: DecisionEffect, reason: string): HookAnswer {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: effect,
      permissionDecisionReason: reason,
    },
  };
}

/** ADR-003 §4: what the client answers on its own. */
export function fallbackEffect(
  mode: Exclude<ReflexMode, "observe">,
  failureMode: FailureMode,
): DecisionEffect {
  return mode === "autopilot" && failureMode === "fail-closed" ? "deny" : "ask";
}

const WHY: Readonly<Record<FallbackWhy, string>> = {
  "daemon-unavailable": "the local daemon could not be started or reached",
  "daemon-timeout": "the local daemon did not answer in time",
  "daemon-rejected": "the local daemon rejected the request",
  "malformed-answer": "the local daemon's answer could not be read",
};

export function fallbackAnswer(
  mode: Exclude<ReflexMode, "observe">,
  failureMode: FailureMode,
  why: FallbackWhy,
): HookAnswer {
  const effect = fallbackEffect(mode, failureMode);
  return answerFor(
    effect,
    `REFLEX: ${WHY[why]}; ${effect === "deny" ? "blocked as configured (fail-closed)" : "asking you, as configured"}`,
  );
}

/**
 * One line for the host's prompt or refusal: what decided, never an
 * argument value (ADR-008 §3). Reason codes and rule ids only.
 */
export function describeDecision(decision: ReflexDecision): string {
  const rule = decision.policyMatches.find(
    (match) => match.effect === decision.effect,
  );
  const codes = decision.reasonCodes.filter(
    (code) => !code.startsWith("explicit_"),
  );
  const what =
    rule !== undefined
      ? `rule ${rule.ruleId}`
      : decision.fallback?.used === true
        ? `fallback (${decision.fallback.reason ?? "unknown"})`
        : decision.semanticAssessment !== undefined
          ? `assessment by ${decision.semanticAssessment.provider}`
          : "policy default";
  const detail = codes.length === 0 ? "" : ` (${codes.join(", ")})`;
  switch (decision.effectiveEffect) {
    case "allow":
      return `REFLEX: allowed by ${what}${detail}`;
    case "ask":
      return `REFLEX: needs your approval, ${what}${detail}`;
    case "deny":
      return `REFLEX: denied by ${what}${detail}`;
  }
}

function isDecision(value: unknown): value is ReflexDecision {
  return (
    typeof value === "object" &&
    value !== null &&
    "effect" in value &&
    "effectiveEffect" in value &&
    ["allow", "ask", "deny"].includes(String(value.effectiveEffect)) &&
    "reasonCodes" in value &&
    Array.isArray(value.reasonCodes) &&
    "policyMatches" in value &&
    Array.isArray(value.policyMatches)
  );
}

export async function decideForHost(
  event: ClaudeToolEvent,
  options: DecideOptions,
): Promise<DecideOutcome> {
  const started = Date.now();
  const budget = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const context: TranslationContext = {
    now: options.now,
    ...(options.hostVersion === undefined
      ? {}
      : { hostVersion: options.hostVersion }),
  };
  const action = {
    ...toCanonicalAction(event, context),
    ...(options.projectId === undefined
      ? {}
      : { projectId: options.projectId }),
  };

  const fallback = (why: FallbackWhy): DecideOutcome => ({
    kind: "fallback",
    reason: why,
    answer: fallbackAnswer(options.mode, options.failureMode, why),
  });

  const ensured = await ensureDaemon({
    home: options.home,
    nodePath: options.nodePath,
    deadlineMs: Math.max(MIN_REQUEST_MS, Math.round(budget * START_SHARE)),
    startedBy: "hook",
    ...(options.daemonEntry === undefined
      ? {}
      : { entry: options.daemonEntry }),
  });
  if (!ensured.ok) {
    return fallback("daemon-unavailable");
  }
  const remaining = budget - (Date.now() - started);
  const timeoutMs = Math.max(MIN_REQUEST_MS, remaining);
  const result = await requestOverSocket({
    socketPath: daemonPaths(options.home).socketPath,
    method: "POST",
    path: "/v1/decisions",
    body: JSON.stringify({
      action,
      mode: options.mode,
      failureMode: options.failureMode,
      // The daemon's own deadline stays inside the client's.
      deadlineMs: Math.max(1, timeoutMs - 100),
    }),
    timeoutMs,
  });
  if (!result.ok) {
    return fallback(
      result.reason === "timeout" ? "daemon-timeout" : "daemon-unavailable",
    );
  }
  if (result.response.status !== 200) {
    return fallback("daemon-rejected");
  }
  if (!isDecision(result.response.json)) {
    return fallback("malformed-answer");
  }
  const decision = result.response.json;
  return {
    kind: "decided",
    decision,
    answer: answerFor(decision.effectiveEffect, describeDecision(decision)),
  };
}
