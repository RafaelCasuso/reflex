import { parse } from "smol-toml";

/**
 * RFX-047 / RFX-050 — the Codex `config.toml`, read for what matters to a
 * hook and written for one thing only.
 *
 * Codex runs no hook unless `features.hooks = true` (its documentation,
 * 2026-09-27; `codex_hooks` is the deprecated alias). An install that left
 * the flag off would be written and silently never run (CLAUDE.md principle
 * 5), so `rfx init` sets it. The file is TOML, which no library edits while
 * keeping the user's bytes, so the edit is a single line placed by hand and
 * the result is re-parsed before it is trusted. Anything more elaborate
 * (an inline `features = { ... }` table) is left to the user, and said.
 *
 * Read, never written: the `[hooks]` table (the user's own representation,
 * RFX-047), `approval_policy`, `sandbox_mode` and the project's
 * `trust_level`: trust-sensitive setup the plan reports.
 */
export interface CodexConfigInspection {
  readonly state: "absent" | "valid" | "unparseable";
  /** `features.hooks` (or the alias). `undefined` when neither is set. */
  readonly hooksEnabled: boolean | undefined;
  /** Events declared under an inline `[hooks]` table. Never touched. */
  readonly inlineHookEvents: readonly string[];
  readonly approvalPolicy: string | undefined;
  readonly sandboxMode: string | undefined;
  /** `projects."<projectDir>".trust_level`, when the project is listed. */
  readonly trustLevel: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const asText = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

function parseToml(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function hooksFlag(root: Record<string, unknown>): boolean | undefined {
  const features = root.features;
  if (!isRecord(features)) {
    return undefined;
  }
  if (typeof features.hooks === "boolean") {
    return features.hooks;
  }
  return typeof features.codex_hooks === "boolean"
    ? features.codex_hooks
    : undefined;
}

export function inspectConfig(
  text: string | undefined,
  projectDir?: string,
): CodexConfigInspection {
  const empty = {
    hooksEnabled: undefined,
    inlineHookEvents: [],
    approvalPolicy: undefined,
    sandboxMode: undefined,
    trustLevel: undefined,
  };
  if (text === undefined) {
    return { state: "absent", ...empty };
  }
  const root = parseToml(text);
  if (root === undefined) {
    return { state: "unparseable", ...empty };
  }
  const projects = isRecord(root.projects) ? root.projects : undefined;
  const project =
    projectDir !== undefined && projects !== undefined
      ? projects[projectDir]
      : undefined;
  return {
    state: "valid",
    hooksEnabled: hooksFlag(root),
    inlineHookEvents: isRecord(root.hooks) ? Object.keys(root.hooks) : [],
    approvalPolicy: asText(root.approval_policy),
    sandboxMode: asText(root.sandbox_mode),
    trustLevel: isRecord(project) ? asText(project.trust_level) : undefined,
  };
}

export type FeaturePlan =
  | { readonly kind: "unchanged" }
  | { readonly kind: "create" | "modify"; readonly newText: string }
  | { readonly kind: "unparseable" }
  /** A shape this planner does not edit. The user sets the flag themselves. */
  | { readonly kind: "unsupported"; readonly reason: string };

const FEATURES_HEADER = /^\[features\]\s*(?:#.*)?$/;
const HOOKS_LINE = /^\s*(?:hooks|codex_hooks)\s*=\s*(true|false)\s*(?:#.*)?$/;
const DOTTED_HOOKS_LINE =
  /^\s*features\s*\.\s*(?:hooks|codex_hooks)\s*=\s*(true|false)\s*(?:#.*)?$/;
export const ENABLE_LINE = "hooks = true";

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** The index range of the lines under `[features]`, header excluded. */
function featuresBody(
  lines: readonly string[],
): { readonly start: number; readonly end: number } | undefined {
  const header = lines.findIndex((line) => FEATURES_HEADER.test(line));
  if (header === -1) {
    return undefined;
  }
  let end = header + 1;
  while (end < lines.length && !(lines[end] ?? "").startsWith("[")) {
    end += 1;
  }
  return { start: header + 1, end };
}

function verified(
  text: string | undefined,
  newText: string,
  wanted: boolean | undefined,
): FeaturePlan {
  const root = parseToml(newText);
  if (root === undefined || hooksFlag(root) !== wanted) {
    return { kind: "unparseable" };
  }
  return { kind: text === undefined ? "create" : "modify", newText };
}

/**
 * `features.hooks = true`, by the smallest edit: a replaced value on the
 * line that sets it, a line added under an existing `[features]` table, or
 * a `[features]` table appended at the end.
 */
export function planEnableHooks(text: string | undefined): FeaturePlan {
  if (text === undefined || text.trim() === "") {
    return verified(text, `[features]\n${ENABLE_LINE}\n`, true);
  }
  const root = parseToml(text);
  if (root === undefined) {
    return { kind: "unparseable" };
  }
  if (hooksFlag(root) === true) {
    return { kind: "unchanged" };
  }
  const eol = eolOf(text);
  const lines = text.split(eol);

  const dotted = lines.findIndex((line) => DOTTED_HOOKS_LINE.test(line));
  if (dotted !== -1) {
    lines[dotted] = (lines[dotted] ?? "").replace(/=\s*false/, "= true");
    return verified(text, lines.join(eol), true);
  }
  const body = featuresBody(lines);
  if (body === undefined) {
    if (isRecord(root.features)) {
      return {
        kind: "unsupported",
        reason: "features is an inline table; add hooks = true to it yourself",
      };
    }
    const trailing = text.endsWith(eol) ? "" : eol;
    return verified(
      text,
      `${text}${trailing}${eol}[features]${eol}${ENABLE_LINE}${eol}`,
      true,
    );
  }
  for (let index = body.start; index < body.end; index += 1) {
    if (HOOKS_LINE.test(lines[index] ?? "")) {
      lines[index] = (lines[index] ?? "").replace(/=\s*false/, "= true");
      return verified(text, lines.join(eol), true);
    }
  }
  lines.splice(body.start, 0, ENABLE_LINE);
  return verified(text, lines.join(eol), true);
}

/**
 * The reverse of `planEnableHooks`, for `rfx uninstall` when REFLEX was the
 * one that set the flag: the one line is removed, and a `[features]` header
 * left with nothing under it goes too. A flag the user set is not REFLEX's
 * to unset; the caller knows which it was (the install record).
 */
export function planDisableHooks(text: string): FeaturePlan {
  const root = parseToml(text);
  if (root === undefined) {
    return { kind: "unparseable" };
  }
  if (hooksFlag(root) !== true) {
    return { kind: "unchanged" };
  }
  const eol = eolOf(text);
  const lines = text.split(eol);
  const dotted = lines.findIndex((line) => DOTTED_HOOKS_LINE.test(line));
  if (dotted !== -1) {
    lines.splice(dotted, 1);
    return verified(text, lines.join(eol), undefined);
  }
  const body = featuresBody(lines);
  if (body === undefined) {
    return { kind: "unsupported", reason: "features is an inline table" };
  }
  const flag = lines
    .slice(body.start, body.end)
    .findIndex((line) => HOOKS_LINE.test(line));
  if (flag === -1) {
    return { kind: "unsupported", reason: "the flag is not on its own line" };
  }
  lines.splice(body.start + flag, 1);
  const rest = lines
    .slice(body.start, body.end - 1)
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  if (rest.length === 0) {
    // Header and its blank lines: nothing of the user's under it.
    lines.splice(body.start - 1, body.end - body.start);
  }
  let joined = lines.join(eol);
  while (joined.endsWith(`${eol}${eol}`)) {
    joined = joined.slice(0, -eol.length);
  }
  return verified(text, joined, undefined);
}
