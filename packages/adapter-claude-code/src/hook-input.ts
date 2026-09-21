/**
 * RFX-042 — reading what Claude Code sends a hook on stdin.
 *
 * Validation is written by hand on purpose. This runs inside every tool call,
 * in a process the host starts per call, and the envelope is six fields:
 * loading a schema library here would cost more than everything else the hook
 * does.
 *
 * The reader is tolerant where the host is free to move (new envelope fields,
 * new events) and strict about the few fields the adapter relies on. An
 * envelope it cannot use is a typed failure, never a guess (RFX-124 will turn
 * that failure into a drift signal).
 */
export const TOOL_EVENTS = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
] as const;
export type ToolEventName = (typeof TOOL_EVENTS)[number];

export interface ClaudeToolEvent {
  readonly kind: "tool";
  readonly event: ToolEventName;
  readonly sessionId: string | undefined;
  readonly toolUseId: string | undefined;
  readonly toolName: string;
  /** As received. Untrusted, uninterpreted (ADR-001 §4). */
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly cwd: string | undefined;
  readonly permissionMode: string | undefined;
  /**
   * The name of the MCP server a tool belongs to, as the host states it in
   * `mcp_server` (seen live on 2.1.276, RFX-089). Absent for the host's own
   * tools.
   */
  readonly mcpServer: string | undefined;
}

export interface ClaudeTurnEndedEvent {
  readonly kind: "turn-ended";
  readonly sessionId: string | undefined;
}

/** A real event this adapter has no use for. Not an error. */
export interface ClaudeIgnoredEvent {
  readonly kind: "ignored";
  readonly event: string;
}

export type ClaudeHookEvent =
  ClaudeToolEvent | ClaudeTurnEndedEvent | ClaudeIgnoredEvent;

export type HookInputFailure =
  "not-json" | "not-an-object" | "missing-event-name" | "invalid-tool-event";

export type HookInputResult =
  | { readonly ok: true; readonly event: ClaudeHookEvent }
  | { readonly ok: false; readonly reason: HookInputFailure };

/** Generous: a Write call carries a whole file. The host bounds it, not us. */
const MAX_NAME_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

type McpServerReading =
  | { readonly ok: true; readonly name: string | undefined }
  | { readonly ok: false };

/**
 * The host states an MCP tool's server as `{ name, source }` (seen live on
 * 2.1.276, RFX-089). A bare string is read as the name. A statement that is
 * there and cannot be read fails the event: the alternative is guessing the
 * server from the tool name, which is the ambiguity this field ends.
 */
function readMcpServer(value: unknown): McpServerReading {
  if (value === undefined || value === null) {
    return { ok: true, name: undefined };
  }
  const name = isRecord(value) ? value.name : value;
  return typeof name === "string" &&
    name !== "" &&
    name.length <= MAX_NAME_LENGTH
    ? { ok: true, name }
    : { ok: false };
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
  const mcpServer = readMcpServer(payload.mcp_server);
  if (!mcpServer.ok) {
    return { ok: false, reason: "invalid-tool-event" };
  }

  return {
    ok: true,
    event: {
      kind: "tool",
      event: eventName,
      sessionId,
      toolUseId: optionalString(payload.tool_use_id),
      toolName,
      toolInput,
      cwd: optionalString(payload.cwd),
      permissionMode: optionalString(payload.permission_mode),
      mcpServer: mcpServer.name,
    },
  };
}
