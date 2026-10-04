import {
  CONTRACT_LIMITS,
  type ActionOperands,
  type ActionTool,
  type CanonicalAction,
  type SideEffectClass,
} from "@reflex-control/contracts";

import type { CodexToolEvent } from "./hook-input.js";
import { deriveActionId, deriveSessionId, randomActionId } from "./identity.js";

/**
 * RFX-048 — a Codex tool event as a `CanonicalAction` (ADR-001).
 *
 * Codex names its tools `Bash`, `apply_patch`, `mcp__<server>__<tool>` for
 * MCP tools, and other local function tools by their function name (its
 * documentation, 2026-09-27). Hosted tools (`WebSearch`) never reach a hook.
 * Nothing here interprets an argument beyond copying a string operand and,
 * for `apply_patch`, reading the file headers of the patch format.
 */
export interface TranslationContext {
  readonly now: () => Date;
  readonly hostVersion?: string;
}

const MCP_PREFIX = "mcp__";
const MCP_SEPARATOR = "__";

export function parseToolName(hostToolName: string): ActionTool {
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
 * The side-effect class, when the tool name alone settles it (ADR-011). That
 * is almost never: `Bash` is anything at all, and an adapter that cannot
 * classify says `unknown` (ADR-001 §4).
 */
const SETTLED_BY_NAME: Readonly<Record<string, SideEffectClass>> = {
  // Edits the agent's own plan. Codex's counterpart of TodoWrite.
  update_plan: "none",
};

/**
 * The `apply_patch` format: a patch is a sequence of file sections, each
 * opened by one of these headers. Reading them is not interpreting the
 * edit: it is the list of files the tool will touch.
 */
const PATCH_BEGIN = "*** Begin Patch";
const PATCH_HEADERS = {
  add: "*** Add File: ",
  update: "*** Update File: ",
  delete: "*** Delete File: ",
  move: "*** Move to: ",
} as const;

export interface PatchReading {
  readonly paths: readonly string[];
  readonly deletes: boolean;
}

/** `undefined` when the text is not a patch in the documented format. */
export function readPatch(text: string): PatchReading | undefined {
  if (!text.trimStart().startsWith(PATCH_BEGIN)) {
    return undefined;
  }
  const paths: string[] = [];
  let deletes = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    for (const [kind, header] of Object.entries(PATCH_HEADERS)) {
      if (line.startsWith(header)) {
        const path = line.slice(header.length).trim();
        if (path !== "" && !paths.includes(path)) {
          paths.push(path);
        }
        if (kind === "delete") {
          deletes = true;
        }
      }
    }
  }
  return paths.length === 0 ? undefined : { paths, deletes };
}

/** The patch text of an `apply_patch` call: `tool_input.command`, by the documentation. */
function patchTextOf(
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const command = input.command;
  return typeof command === "string" && command !== "" ? command : undefined;
}

export function classifyByName(
  tool: ActionTool,
  input: Readonly<Record<string, unknown>>,
): SideEffectClass {
  if (tool.namespace !== undefined) {
    return "unknown";
  }
  if (tool.name === "apply_patch") {
    // Writes files in the workspace, always. A patch that deletes a file is
    // read as destructive, as `rm` is by the command classifier; a patch
    // that is not in the documented format is unknown, never safe.
    const text = patchTextOf(input);
    const patch = text === undefined ? undefined : readPatch(text);
    return patch === undefined
      ? "unknown"
      : patch.deletes
        ? "destructive"
        : "local-write";
  }
  return Object.hasOwn(SETTLED_BY_NAME, tool.name)
    ? (SETTLED_BY_NAME[tool.name] ?? "unknown")
    : "unknown";
}

export function operandsOf(
  tool: ActionTool,
  input: Readonly<Record<string, unknown>>,
): ActionOperands | undefined {
  if (tool.namespace !== undefined) {
    return undefined;
  }
  if (tool.name === "Bash") {
    const command = input.command;
    return typeof command === "string" &&
      command !== "" &&
      command.length <= CONTRACT_LIMITS.commandLength
      ? { command: { raw: command } }
      : undefined;
  }
  if (tool.name === "apply_patch") {
    const text = patchTextOf(input);
    const patch = text === undefined ? undefined : readPatch(text);
    if (patch === undefined) {
      return undefined;
    }
    const paths = patch.paths.filter(
      (path) => path.length <= CONTRACT_LIMITS.pathLength,
    );
    return paths.length === 0 ? undefined : { paths };
  }
  return undefined;
}

export function toCanonicalAction(
  event: CodexToolEvent,
  context: TranslationContext,
): CanonicalAction {
  const tool = parseToolName(event.toolName);
  const operands = operandsOf(tool, event.toolInput);
  return {
    id: deriveActionId(event.sessionId, event.toolUseId) ?? randomActionId(),
    ...(event.sessionId === undefined
      ? {}
      : { sessionId: deriveSessionId(event.sessionId) }),
    agent: {
      host: "codex",
      ...(context.hostVersion === undefined
        ? {}
        : { hostVersion: context.hostVersion }),
    },
    tool,
    arguments: event.toolInput,
    ...(operands === undefined ? {} : { operands }),
    sideEffectClass: classifyByName(tool, event.toolInput),
    ...(event.cwd === undefined ? {} : { cwd: event.cwd }),
    adapterMetadata: {
      hookEventName: event.event,
      ...(event.toolUseId === undefined ? {} : { toolUseId: event.toolUseId }),
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      ...(event.permissionMode === undefined
        ? {}
        : { permissionMode: event.permissionMode }),
    },
    createdAt: context.now().toISOString(),
  };
}
