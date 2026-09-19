import {
  describeShape,
  RECORD_VERSION,
  type ObservationRecord,
  type OutcomeSignal,
} from "@reflex/telemetry";

import type { ClaudeHookEvent, ToolEventName } from "./hook-input.js";
import { deriveActionId, deriveSessionId } from "./identity.js";
import { toCanonicalAction, type TranslationContext } from "./translate.js";

/**
 * RFX-092 — what each Claude Code event says about an action's outcome.
 *
 * `PreToolUse` is the action itself. The others are signals about it, in the
 * host-agnostic vocabulary that `assembleOutcomes` understands.
 */
const SIGNALS: Readonly<
  Record<Exclude<ToolEventName, "PreToolUse">, OutcomeSignal>
> = {
  PermissionRequest: "permission-requested",
  PostToolUse: "executed",
  PostToolUseFailure: "failed",
  PermissionDenied: "denied-by-host",
};

/**
 * The record to keep for a host event, or `undefined` when there is nothing
 * worth keeping. Pure: no I/O, no clock of its own.
 *
 * A signal that cannot be tied to an action (the host sent no tool-use
 * identifier) is dropped. Attaching it to a guessed action would give one
 * action another's outcome; a missing signal only leaves a field `unknown`.
 */
export function toObservationRecord(
  event: ClaudeHookEvent,
  context: TranslationContext,
): ObservationRecord | undefined {
  const recordedAt = context.now().toISOString();

  switch (event.kind) {
    case "ignored":
      return undefined;

    case "turn-ended":
      return {
        kind: "turn-ended",
        recordVersion: RECORD_VERSION,
        recordedAt,
        ...(event.sessionId === undefined
          ? {}
          : { sessionId: deriveSessionId(event.sessionId) }),
      };

    case "tool": {
      if (event.event === "PreToolUse") {
        const action = toCanonicalAction(event, context);
        return {
          kind: "action",
          recordVersion: RECORD_VERSION,
          recordedAt,
          actionId: action.id,
          ...(action.sessionId === undefined
            ? {}
            : { sessionId: action.sessionId }),
          host: action.agent.host,
          ...(action.agent.hostVersion === undefined
            ? {}
            : { hostVersion: action.agent.hostVersion }),
          toolName: action.tool.name,
          ...(action.tool.namespace === undefined
            ? {}
            : { toolNamespace: action.tool.namespace }),
          sideEffectClass: action.sideEffectClass,
          ...(action.cwd === undefined ? {} : { projectRoot: action.cwd }),
          createdAt: action.createdAt,
          // The only thing derived from the arguments. Never a value.
          argumentShape: describeShape(action.arguments),
        };
      }

      const actionId = deriveActionId(event.sessionId, event.toolUseId);
      if (actionId === undefined) {
        return undefined;
      }
      return {
        kind: "signal",
        recordVersion: RECORD_VERSION,
        recordedAt,
        actionId,
        ...(event.sessionId === undefined
          ? {}
          : { sessionId: deriveSessionId(event.sessionId) }),
        signal: SIGNALS[event.event],
      };
    }
  }
}
