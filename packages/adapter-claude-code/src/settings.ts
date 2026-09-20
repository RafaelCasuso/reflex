import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

/**
 * RFX-041 / RFX-044 — planning changes to a Claude Code settings file.
 *
 * Everything here is pure: text in, text out. Reading and writing belong to
 * the CLI, inside a reversible transaction (RFX-053). That split is what lets
 * `rfx init` show the exact plan before anything is touched.
 *
 * Edits are surgical. The file is never parsed and re-serialized, because
 * that would reformat a file the user owns: their indentation, key order,
 * comments and trailing newline are left exactly as they were.
 */

/**
 * Every hook REFLEX installs starts with this. It is a harmless environment
 * assignment to the shell, and it is how REFLEX recognizes its own entries
 * later, whatever path the rest of the command points at.
 */
export const MANAGED_MARKER = "REFLEX_MANAGED=1";

/** Events subscribed to in Observe: the action, and what happened to it. */
export const OBSERVED_EVENTS = [
  { event: "PreToolUse", matcher: "*" },
  { event: "PermissionRequest", matcher: "*" },
  { event: "PostToolUse", matcher: "*" },
  { event: "PostToolUseFailure", matcher: "*" },
  { event: "PermissionDenied", matcher: "*" },
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
  return `${MANAGED_MARKER} ${shellQuote(nodePath)} ${shellQuote(entryPath)} hook claude-code`;
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

function parseSettings(text: string): Parsed {
  if (text.trim() === "") {
    return { ok: true, root: {} };
  }
  const errors: ParseError[] = [];
  const root: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(root)) {
    return { ok: false };
  }
  // A `hooks` key of the wrong type is a file REFLEX does not understand.
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

export interface SettingsInspection {
  readonly state: "absent" | "valid" | "unparseable";
  /** `disableAllHooks: true`. REFLEX would be installed and never run. */
  readonly hooksDisabled: boolean;
  /** `allowManagedHooksOnly: true`. Meaningful in managed settings. */
  readonly managedHooksOnly: boolean;
  /** Events that already carry a REFLEX-managed hook. */
  readonly installedEvents: readonly string[];
  /**
   * RFX-103: events whose REFLEX-managed hook no longer runs the command that
   * was expected. The marker is still there and the hook does something else,
   * for example nothing. Only filled when an expected command is given.
   */
  readonly alteredEvents: readonly string[];
  /** Hooks that belong to the user or to other tools. Never touched. */
  readonly foreignHooks: number;
}

export function inspectSettings(
  text: string | undefined,
  expectedCommand?: string,
): SettingsInspection {
  const empty = {
    hooksDisabled: false,
    managedHooksOnly: false,
    installedEvents: [],
    alteredEvents: [],
    foreignHooks: 0,
  };
  if (text === undefined) {
    return { state: "absent", ...empty };
  }
  const parsed = parseSettings(text);
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

  return {
    state: "valid",
    hooksDisabled: root.disableAllHooks === true,
    managedHooksOnly: root.allowManagedHooksOnly === true,
    installedEvents,
    alteredEvents,
    foreignHooks,
  };
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
  const initial = parseSettings(text);
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
    const parsed = parseSettings(current);
    if (!parsed.ok) {
      return { kind: "unparseable" };
    }
    const groups = hookGroups(parsed.root, event);
    let touched = false;

    // Highest index first, so earlier indices stay valid while editing.
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
      // A group the user also put their own hook in: take only ours.
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
      const after = parseSettings(current);
      if (after.ok && hookGroups(after.root, event).length === 0) {
        current = edit(current, ["hooks", event], undefined, formatting);
      }
    }
  }

  if (removedEvents.length === 0) {
    return { kind: "nothing-to-remove" };
  }
  const final = parseSettings(current);
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
 */
export function planInstall(
  text: string | undefined,
  command: string,
): InstallPlan {
  const base = text ?? "";
  if (!parseSettings(base).ok) {
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
