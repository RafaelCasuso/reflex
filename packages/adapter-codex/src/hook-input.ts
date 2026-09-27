/**
 * RFX-048 — reading what Codex sends a hook on stdin.
 *
 * Validation is written by hand on purpose: this runs inside every tool call,
 * in a process the host starts per call. The envelope is the one Codex
 * documents ("Hooks", 2026-09-27): `session_id`, `hook_event_name`, `cwd`,
 * `transcript_path`, `model`, `permission_mode`, `turn_id`, and for tool
 * events `tool_name`, `tool_input`, `tool_use_id` (absent on
 * `PermissionRequest`) and `tool_response` (`PostToolUse`). The reader is
 * tolerant where the host is free to move (new fields, new events) and strict
 * about the few fields the adapter relies on. An envelope it cannot use is a
 * typed failure, never a guess.
 *
 * Not verified against a live host yet: the Codex installed where this was
 * written (0.101.0) predates hooks. `docs/codex-hook.md` says what is
 * documentation and what is observed.
 */
export const TOOL_EVENTS = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
] as const;
export type ToolEventName = (typeof TOOL_EVENTS)[number];

export interface CodexToolEvent {
  readonly kind: "tool";
  readonly event: ToolEventName;
  readonly sessionId: string | undefined;
  readonly turnId: string | undefined;
  readonly toolUseId: string | undefined;
  readonly toolName: string;
  /** As received. Untrusted, uninterpreted (ADR-001 §4). */
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly cwd: string | undefined;
  readonly permissionMode: string | undefined;
}

export interface CodexTurnEndedEvent {
  readonly kind: "turn-ended";
  readonly sessionId: string | undefined;
}

/** A real event this adapter has no use for. Not an error. */
export interface CodexIgnoredEvent {
  readonly kind: "ignored";
  readonly event: string;
}

export type CodexHookEvent =
  CodexToolEvent | CodexTurnEndedEvent | CodexIgnoredEvent;

export type HookInputFailure =
  "not-json" | "not-an-object" | "missing-event-name" | "invalid-tool-event";

export type HookInputResult =
  | { readonly ok: true; readonly event: CodexHookEvent }
  | { readonly ok: false; readonly reason: HookInputFailure };

const MAX_NAME_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isToolEvent(name: string): name is ToolEventName {
  return (TOOL_EVENTS as readonly string[]).includes(name);
}

export function readHookInput(stdin: string): HookInputResult {
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  if (!isRecord(payload)) {
    return { ok: false, reason: "not-an-object" };
  }
  const eventName = payload.hook_event_name;
  if (typeof eventName !== "string" || eventName === "") {
    return { ok: false, reason: "missing-event-name" };
  }
  const sessionId = optionalString(payload.session_id);
  if (eventName === "Stop") {
    return { ok: true, event: { kind: "turn-ended", sessionId } };
  }
  if (!isToolEvent(eventName)) {
    return {
      ok: true,
      event: { kind: "ignored", event: eventName.slice(0, MAX_NAME_LENGTH) },
    };
  }
  const toolName = payload.tool_name;
  const toolInput = payload.tool_input;
  if (
    typeof toolName !== "string" ||
    toolName === "" ||
    toolName.length > MAX_NAME_LENGTH ||
    !isRecord(toolInput)
  ) {
    return { ok: false, reason: "invalid-tool-event" };
  }
  return {
    ok: true,
    event: {
      kind: "tool",
      event: eventName,
      sessionId,
      turnId: optionalString(payload.turn_id),
      toolUseId: optionalString(payload.tool_use_id),
      toolName,
      toolInput,
      cwd: optionalString(payload.cwd),
      permissionMode: optionalString(payload.permission_mode),
    },
  };
}
