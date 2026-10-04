import { CONTRACT_LIMITS } from "@reflex-control/contracts";
import type {
  ActionOperands,
  ActionTool,
  CanonicalAction,
  SideEffectClass,
} from "@reflex-control/contracts";

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

/**
 * The namespace of a tool is what an allow rule trusts (ADR-011: an allow rule
 * reaches an MCP tool only if it names `tool.namespace`), so it must never be
 * guessed wrong.
 *
 * The host names an MCP tool `mcp__<server>__<tool>`, and that does not split
 * in one way only: `mcp__github__admin__delete` is the tool `admin__delete` of
 * the server `github`, or the tool `delete` of the server `github__admin`. A
 * server could choose its name to be read as another one. The host also says
 * which server it is, in `mcp_server.name` (seen live on 2.1.276, RFX-089),
 * and that is authoritative.
 *
 * - With `mcp_server`: it is the namespace. The tool is what follows the exact
 *   prefix. If the name does not carry that prefix the two disagree, and the
 *   whole name is kept, so that no rule about a tool name matches by accident.
 * - Without it (a host that does not say): split at the first separator, as
 *   documented.
 * - A name that starts with `mcp__` always gets a namespace, however badly it
 *   is formed. It must never pass for one of the host's own tools.
 */
export function parseToolName(
  hostToolName: string,
  mcpServer?: string,
): ActionTool {
  if (mcpServer !== undefined && mcpServer !== "") {
    const prefix = `${MCP_PREFIX}${mcpServer}${MCP_SEPARATOR}`;
    return hostToolName.startsWith(prefix) &&
      hostToolName.length > prefix.length
      ? { name: hostToolName.slice(prefix.length), namespace: mcpServer }
      : { name: hostToolName, namespace: mcpServer };
  }
  if (!hostToolName.startsWith(MCP_PREFIX)) {
    return { name: hostToolName };
  }
  const rest = hostToolName.slice(MCP_PREFIX.length);
  const separator = rest.indexOf(MCP_SEPARATOR);
  const namespace = rest.slice(0, separator);
  const name = rest.slice(separator + MCP_SEPARATOR.length);
  return separator <= 0 || name === ""
    ? { name: hostToolName, namespace: rest === "" ? "mcp" : rest }
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
  // Loads the definition of a deferred tool. The host calls it before the
  // first use of an MCP tool or of `WebFetch` (seen live, RFX-089). It touches
  // nothing, and left as `unknown` it would put a prompt before every such call.
  ToolSearch: "none",
};

export function classifyByName(tool: ActionTool): SideEffectClass {
  if (tool.namespace !== undefined) {
    return "unknown";
  }
  return Object.hasOwn(SETTLED_BY_NAME, tool.name)
    ? (SETTLED_BY_NAME[tool.name] ?? "unknown")
    : "unknown";
}

/**
 * Which argument of each built-in tool holds which operand (ADR-011).
 *
 * This is the one place where this adapter knows the shape of a tool's input,
 * and it only copies: a string is a string, never parsed, never interpreted.
 * The field names are those of `sdk-tools.d.ts` as shipped in claude-code
 * 2.1.276, and the schema canary (RFX-124, `host-schema.ts`) compares them
 * with every later release. A tool that is not listed, an MCP tool, or an
 * argument of another type yields no operand, and absent is unknown, never
 * safe (ADR-001 §4). `MultiEdit` is kept for hosts that still have it; no
 * checked release declares it.
 */
const COMMAND_ARGUMENT: Readonly<Record<string, string>> = { Bash: "command" };
const PATH_ARGUMENT: Readonly<Record<string, string>> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};
const URL_ARGUMENT: Readonly<Record<string, string>> = { WebFetch: "url" };

export function operandsOf(
  tool: ActionTool,
  input: Readonly<Record<string, unknown>>,
): ActionOperands | undefined {
  if (tool.namespace !== undefined) {
    return undefined;
  }
  const text = (key: string | undefined): string | undefined => {
    const value = key === undefined ? undefined : input[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const lookup = (
    table: Readonly<Record<string, string>>,
  ): string | undefined =>
    Object.hasOwn(table, tool.name) ? text(table[tool.name]) : undefined;

  const command = lookup(COMMAND_ARGUMENT);
  const path = lookup(PATH_ARGUMENT);
  const url = lookup(URL_ARGUMENT);
  let host: string | undefined;
  if (url !== undefined) {
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      host = undefined;
    }
  }

  // Bounded by the contract. An operand that does not fit is left out, and the
  // action is then one that no allow rule about operands can match.
  const operands: ActionOperands = {
    ...(command !== undefined && command.length <= CONTRACT_LIMITS.commandLength
      ? { command: { raw: command } }
      : {}),
    ...(path !== undefined && path.length <= CONTRACT_LIMITS.pathLength
      ? { paths: [path] }
      : {}),
    ...(host !== undefined &&
    host !== "" &&
    host.length <= CONTRACT_LIMITS.nameLength
      ? { networkHosts: [host] }
      : {}),
  };
  return Object.keys(operands).length === 0 ? undefined : operands;
}

export function toCanonicalAction(
  event: ClaudeToolEvent,
  context: TranslationContext,
): CanonicalAction {
  const tool = parseToolName(event.toolName, event.mcpServer);
  const operands = operandsOf(tool, event.toolInput);

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
    ...(operands === undefined ? {} : { operands }),
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
