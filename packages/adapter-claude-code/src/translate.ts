import type {
  ActionTool,
  CanonicalAction,
  SideEffectClass,
} from "@reflex/contracts";

import type { ClaudeToolEvent } from "./hook-input.js";
import { deriveActionId, deriveSessionId, randomActionId } from "./identity.js";

/**
 * RFX-042 — a Claude Code tool event as a `CanonicalAction`.
 *
 * Translate, do not judge (ADR-001 §4). Arguments pass through as received,
 * and this file never looks inside them: not to classify, not to extract a
 * path, not to summarize. Host-specific data the canonical model has no field
 * for goes into `adapterMetadata`, where domain logic may not read it.
 */
export interface TranslationContext {
  readonly now: () => Date;
  readonly hostVersion?: string;
}

const MCP_PREFIX = "mcp__";
const MCP_SEPARATOR = "__";

/** `mcp__<server>__<tool>`: the server is the namespace, the tool the name. */
export function parseToolName(hostToolName: string): ActionTool {
  if (!hostToolName.startsWith(MCP_PREFIX)) {
    return { name: hostToolName };
  }
  const rest = hostToolName.slice(MCP_PREFIX.length);
  const separator = rest.indexOf(MCP_SEPARATOR);
  const namespace = rest.slice(0, separator);
  const name = rest.slice(separator + MCP_SEPARATOR.length);
  // Anything that does not split cleanly stays whole. A malformed name must
  // not be "repaired" into a namespace and a tool it never declared.
  return separator <= 0 || name === ""
    ? { name: hostToolName }
    : { name, namespace };
}

/**
 * The side-effect class, when the tool name alone settles it.
 *
 * That is almost never. `Read` is a local read until the path is a credentials
 * file; `Bash` is anything at all. Classifying from the name would understate
 * exactly the cases that matter, and ADR-001 §4 says an adapter that cannot
 * classify says `unknown`. Real classification needs the arguments and arrives
 * with the command classifier (RFX-096).
 */
const SETTLED_BY_NAME: Readonly<Record<string, SideEffectClass>> = {
  // Queries a search engine. Nothing local is read, nothing is changed.
  WebSearch: "external-read",
  // Edits the agent's own to-do list.
  TodoWrite: "none",
};

export function classifyByName(tool: ActionTool): SideEffectClass {
  if (tool.namespace !== undefined) {
    return "unknown";
  }
  return Object.hasOwn(SETTLED_BY_NAME, tool.name)
    ? (SETTLED_BY_NAME[tool.name] ?? "unknown")
    : "unknown";
}

export function toCanonicalAction(
  event: ClaudeToolEvent,
  context: TranslationContext,
): CanonicalAction {
  const tool = parseToolName(event.toolName);

  return {
    id: deriveActionId(event.sessionId, event.toolUseId) ?? randomActionId(),
    ...(event.sessionId === undefined
      ? {}
      : { sessionId: deriveSessionId(event.sessionId) }),

    agent: {
      host: "claude-code",
      ...(context.hostVersion === undefined
        ? {}
        : { hostVersion: context.hostVersion }),
    },

    tool,
    arguments: event.toolInput,
    sideEffectClass: classifyByName(tool),

    ...(event.cwd === undefined ? {} : { cwd: event.cwd }),

    adapterMetadata: {
      hookEventName: event.event,
      ...(event.toolUseId === undefined ? {} : { toolUseId: event.toolUseId }),
      ...(event.permissionMode === undefined
        ? {}
        : { permissionMode: event.permissionMode }),
    },

    createdAt: context.now().toISOString(),
  };
}
