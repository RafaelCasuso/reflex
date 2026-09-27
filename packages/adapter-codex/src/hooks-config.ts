import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

/**
 * RFX-047 / RFX-050 — planning changes to a Codex `hooks.json`.
 *
 * Everything here is pure: text in, text out. Reading and writing belong to
 * the CLI, inside a reversible transaction (RFX-053). The file has the same
 * shape as a Claude Code settings file's `hooks` member (Codex documents it
 * as `{ "hooks": { "<Event>": [{ "matcher", "hooks": [{ "type": "command",
 * "command", "timeout" }] }] } }`), and the same rule applies: edits are
 * surgical, the file is never parsed and re-serialized, and the user's own
 * hooks, indentation, key order, comments and trailing newline keep their
 * bytes. A `description` member or anything else the user put there is left
 * as it is.
 */

/**
 * Every hook REFLEX installs starts with this. It is a harmless environment
 * assignment to the shell, and it is how REFLEX recognizes its own entries
 * later, whatever path the rest of the command points at.
 */
export const MANAGED_MARKER = "REFLEX_MANAGED=1";

/**
 * Events subscribed to: the action, the host's own approval prompt, the
 * completed call, and the end of the turn. Codex has no `PostToolUseFailure`
 * or `PermissionDenied` (its documentation, 2026-09-27); where it exposes no
 * signal the outcome says `unknown` (RFX-093). Matchers are ignored for
 * `Stop`, so it has none.
 */
export const OBSERVED_EVENTS = [
  { event: "PreToolUse", matcher: "*" },
  { event: "PermissionRequest", matcher: "*" },
  { event: "PostToolUse", matcher: "*" },
  { event: "Stop", matcher: undefined },
] as const;

/**
 * Seconds. The host default is ten minutes; a hung observer must not be able
 * to stall an agent for that long.
 */
export const HOOK_TIMEOUT_SECONDS = 5;

/** POSIX single-quoting: safe for spaces, quotes and `$` in a path. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildHookCommand(nodePath: string, entryPath: string): string {
  return `${MANAGED_MARKER} ${shellQuote(nodePath)} ${shellQuote(entryPath)} hook codex`;
}

function isManagedHook(hook: unknown): boolean {
  return (
    isRecord(hook) &&
    typeof hook.command === "string" &&
    hook.command.startsWith(`${MANAGED_MARKER} `)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Parsed =
  | { readonly ok: true; readonly root: Record<string, unknown> }
  | { readonly ok: false };

function parseHooksFile(text: string): Parsed {
  if (text.trim() === "") {
    return { ok: true, root: {} };
  }
  const errors: ParseError[] = [];
  const root: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(root)) {
    return { ok: false };
  }
  if (root.hooks !== undefined && !isRecord(root.hooks)) {
    return { ok: false };
  }
  return { ok: true, root };
}

function hookGroups(root: Record<string, unknown>, event: string): unknown[] {
  const hooks = root.hooks;
  if (!isRecord(hooks)) {
    return [];
  }
  const groups = hooks[event];
  return Array.isArray(groups) ? (groups as unknown[]) : [];
}

function groupHooks(group: unknown): unknown[] {
  return isRecord(group) && Array.isArray(group.hooks)
    ? (group.hooks as unknown[])
    : [];
}

export interface HooksFileInspection {
  readonly state: "absent" | "valid" | "unparseable";
  /** Events that already carry a REFLEX-managed hook. */
  readonly installedEvents: readonly string[];
  /**
   * RFX-103: events whose REFLEX-managed hook no longer runs the command that
   * was expected. Only filled when an expected command is given.
   */
  readonly alteredEvents: readonly string[];
  /** Hooks that belong to the user or to other tools. Never touched. */
  readonly foreignHooks: number;
}

export function inspectHooksFile(
  text: string | undefined,
  expectedCommand?: string,
): HooksFileInspection {
  const empty = { installedEvents: [], alteredEvents: [], foreignHooks: 0 };
  if (text === undefined) {
    return { state: "absent", ...empty };
  }
  const parsed = parseHooksFile(text);
  if (!parsed.ok) {
    return { state: "unparseable", ...empty };
  }
  const { root } = parsed;
  const installedEvents: string[] = [];
  const alteredEvents: string[] = [];
  let foreignHooks = 0;
  for (const event of Object.keys(isRecord(root.hooks) ? root.hooks : {})) {
    const hooks = hookGroups(root, event).flatMap(groupHooks);
    const managed = hooks.filter(isManagedHook);
    if (managed.length > 0) {
      installedEvents.push(event);
      if (
        expectedCommand !== undefined &&
        !managed.some(
          (hook) => isRecord(hook) && hook.command === expectedCommand,
        )
      ) {
        alteredEvents.push(event);
      }
    }
    foreignHooks += hooks.filter((hook) => !isManagedHook(hook)).length;
  }
  return { state: "valid", installedEvents, alteredEvents, foreignHooks };
}

interface Formatting {
  readonly insertSpaces: boolean;
  readonly tabSize: number;
  readonly eol: string;
}

function detectFormatting(text: string): Formatting {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  if (indent === undefined) {
    return { insertSpaces: true, tabSize: 2, eol };
  }
  return indent.startsWith("\t")
    ? { insertSpaces: false, tabSize: 1, eol }
    : { insertSpaces: true, tabSize: indent.length, eol };
}

function edit(
  text: string,
  path: (string | number)[],
  value: unknown,
  formatting: Formatting,
  isArrayInsertion = false,
): string {
  return applyEdits(
    text,
    modify(text, path, value, {
      formattingOptions: formatting,
      isArrayInsertion,
    }),
  );
}

export type UninstallPlan =
  | {
      readonly kind: "modify";
      readonly newText: string;
      readonly removedEvents: readonly string[];
    }
  | { readonly kind: "nothing-to-remove" }
  | { readonly kind: "unparseable" };

/**
 * Removes exactly what REFLEX added: its own hooks, then any group, event or
 * `hooks` object that removal left empty. Everything else keeps its bytes.
 */
export function planUninstall(text: string): UninstallPlan {
  const initial = parseHooksFile(text);
  if (!initial.ok) {
    return { kind: "unparseable" };
  }
  const formatting = detectFormatting(text);
  const removedEvents: string[] = [];
  let current = text;

  const events = Object.keys(
    isRecord(initial.root.hooks) ? initial.root.hooks : {},
  );
  for (const event of events) {
    const parsed = parseHooksFile(current);
    if (!parsed.ok) {
      return { kind: "unparseable" };
    }
    const groups = hookGroups(parsed.root, event);
    let touched = false;
    for (let g = groups.length - 1; g >= 0; g -= 1) {
      const hooks = groupHooks(groups[g]);
      const managed = hooks.filter(isManagedHook).length;
      if (managed === 0) {
        continue;
      }
      touched = true;
      if (managed === hooks.length) {
        current = edit(current, ["hooks", event, g], undefined, formatting);
        continue;
      }
      for (let h = hooks.length - 1; h >= 0; h -= 1) {
        if (isManagedHook(hooks[h])) {
          current = edit(
            current,
            ["hooks", event, g, "hooks", h],
            undefined,
            formatting,
          );
        }
      }
    }
    if (touched) {
      removedEvents.push(event);
      const after = parseHooksFile(current);
      if (after.ok && hookGroups(after.root, event).length === 0) {
        current = edit(current, ["hooks", event], undefined, formatting);
      }
    }
  }

  if (removedEvents.length === 0) {
    return { kind: "nothing-to-remove" };
  }
  const final = parseHooksFile(current);
  if (
    final.ok &&
    isRecord(final.root.hooks) &&
    Object.keys(final.root.hooks).length === 0
  ) {
    current = edit(current, ["hooks"], undefined, formatting);
  }
  return { kind: "modify", newText: current, removedEvents };
}

export type InstallPlan =
  | {
      readonly kind: "create" | "modify";
      readonly newText: string;
      readonly events: readonly string[];
    }
  | { readonly kind: "already-installed" }
  | { readonly kind: "unparseable" };

/**
 * Idempotent and self-healing: any earlier REFLEX entries are replaced, so a
 * moved `rfx` binary or a partial install converges to one correct state.
 * A file the user already has keeps every hook of theirs (RFX-050).
 */
export function planInstall(
  text: string | undefined,
  command: string,
): InstallPlan {
  const base = text ?? "";
  if (!parseHooksFile(base).ok) {
    return { kind: "unparseable" };
  }
  const cleared = planUninstall(base);
  if (cleared.kind === "unparseable") {
    return { kind: "unparseable" };
  }
  let current = cleared.kind === "modify" ? cleared.newText : base;
  if (current.trim() === "") {
    current = "{}\n";
  }
  const formatting = detectFormatting(current);
  for (const { event, matcher } of OBSERVED_EVENTS) {
    const group = {
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }],
    };
    current = edit(current, ["hooks", event, -1], group, formatting, true);
  }
  if (text !== undefined && current === text) {
    return { kind: "already-installed" };
  }
  return {
    kind: text === undefined ? "create" : "modify",
    newText: current,
    events: OBSERVED_EVENTS.map(({ event }) => event),
  };
}
