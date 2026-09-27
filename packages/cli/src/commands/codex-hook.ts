import {
  toCanonicalAction,
  type CodexToolEvent,
  type TranslationContext,
} from "@reflex/adapter-codex/hook";
import type { DecisionEffect } from "@reflex/contracts";

import {
  decideAction,
  describeDecision,
  fallbackEffect,
  type DecideOptions,
  type DecisionOutcome,
  type FallbackWhy,
} from "./decide.js";

/**
 * RFX-048, RFX-049, RFX-051 — a Codex event to what Codex understands.
 *
 * Codex has two channels, and REFLEX uses each for what it is (ADR-007,
 * `docs/integrations.md`): `PreToolUse` sees every call and can block it or
 * ask; `PermissionRequest` fires only when Codex is about to show its own
 * prompt, and can approve, deny, or say nothing so that the prompt goes on.
 *
 *   effect   PreToolUse                        PermissionRequest
 *   allow    nothing (Codex proceeds)          decision.behavior: allow
 *   ask      permissionDecision: ask           nothing: the native prompt
 *   deny     permissionDecision: deny          decision.behavior: deny
 *
 * `ask` is native delegation and nothing else: on `PreToolUse` it is the
 * value Codex documents for "show your own prompt"; on `PermissionRequest`
 * it is abstention. Neither is a dialog of REFLEX's own. `allow` is granted
 * where Codex asks, not before: `PreToolUse` never widens what Codex would
 * have done on its own. The effect mapped is `effectiveEffect` (ADR-002):
 * in Assist a deny arrives as ask. When the daemon cannot be reached the
 * client answers by itself (ADR-003 §4): ask, or deny in Autopilot under
 * fail-closed, on the channel the event has for it.
 */
export type CodexAnswer =
  | {
      readonly hookSpecificOutput: {
        readonly hookEventName: "PreToolUse";
        readonly permissionDecision: "ask" | "deny";
        readonly permissionDecisionReason: string;
      };
    }
  | {
      readonly hookSpecificOutput: {
        readonly hookEventName: "PermissionRequest";
        readonly decision:
          | { readonly behavior: "allow" }
          | { readonly behavior: "deny"; readonly message: string };
      };
    };

/** `undefined` is silence: Codex goes on as it would have. */
export function codexAnswerFor(
  event: CodexToolEvent["event"],
  effect: DecisionEffect,
  reason: string,
): CodexAnswer | undefined {
  if (event === "PreToolUse") {
    return effect === "allow"
      ? undefined
      : {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: effect,
            permissionDecisionReason: reason,
          },
        };
  }
  if (event === "PermissionRequest") {
    if (effect === "allow") {
      return {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      };
    }
    if (effect === "deny") {
      return {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny", message: reason },
        },
      };
    }
    return undefined;
  }
  // PostToolUse: nothing to decide.
  return undefined;
}

const WHY: Readonly<Record<FallbackWhy, string>> = {
  "daemon-unavailable": "the local daemon could not be started or reached",
  "daemon-timeout": "the local daemon did not answer in time",
  "daemon-rejected": "the local daemon rejected the request",
  "malformed-answer": "the local daemon's answer could not be read",
};

export type CodexDecideOutcome = DecisionOutcome & {
  readonly answer: CodexAnswer | undefined;
};

export async function decideForCodex(
  event: CodexToolEvent,
  options: DecideOptions,
): Promise<CodexDecideOutcome> {
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
  const outcome = await decideAction(action, options);
  if (outcome.kind === "fallback") {
    const effect = fallbackEffect(options.mode, options.failureMode);
    return {
      ...outcome,
      answer: codexAnswerFor(
        event.event,
        effect,
        `REFLEX: ${WHY[outcome.reason]}; ${effect === "deny" ? "blocked as configured (fail-closed)" : "asking you, as configured"}`,
      ),
    };
  }
  const { decision } = outcome;
  return {
    ...outcome,
    answer: codexAnswerFor(
      event.event,
      decision.effectiveEffect,
      describeDecision(decision),
    ),
  };
}
