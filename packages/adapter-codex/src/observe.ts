import {
  describeShape,
  RECORD_VERSION,
  type ObservationRecord,
  type OutcomeSignal,
} from "@reflex-control/telemetry";

import type { CodexHookEvent, ToolEventName } from "./hook-input.js";
import { deriveActionId, deriveSessionId } from "./identity.js";
import {
  parseToolName,
  toCanonicalAction,
  type TranslationContext,
} from "./translate.js";

/**
 * RFX-093 — what each Codex event says about an action's outcome.
 *
 * `PreToolUse` is the action itself; `PermissionRequest` says the host is
 * about to ask; `PostToolUse` says the call completed. Codex exposes no
 * failure or refusal event, so those outcomes stay `unknown` (the
 * acceptance of RFX-093), in the host-agnostic vocabulary that
 * `assembleOutcomes` understands.
 */
const SIGNALS: Readonly<
  Record<Exclude<ToolEventName, "PreToolUse">, OutcomeSignal>
> = {
  PermissionRequest: "permission-requested",
  PostToolUse: "executed",
};

/**
 * Pure: no I/O, no clock of its own. `PermissionRequest` carries no
 * `tool_use_id` (documented), so its record names the session and the tool
 * and `assembleOutcomes` attributes it by order. A signal with neither an
 * identifier nor a session is dropped rather than guessed.
 */
export function toObservationRecord(
  event: CodexHookEvent,
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
      if (actionId === undefined && event.sessionId === undefined) {
        return undefined;
      }
      const tool = parseToolName(event.toolName);
      return {
        kind: "signal",
        recordVersion: RECORD_VERSION,
        recordedAt,
        ...(actionId === undefined
          ? {
              toolName: tool.name,
              ...(tool.namespace === undefined
                ? {}
                : { toolNamespace: tool.namespace }),
            }
          : { actionId }),
        ...(event.sessionId === undefined
          ? {}
          : { sessionId: deriveSessionId(event.sessionId) }),
        signal: SIGNALS[event.event],
      };
    }
  }
}
