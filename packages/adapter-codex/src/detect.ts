import { join } from "node:path";

/**
 * RFX-047 — where Codex reads hooks and configuration from. Path arithmetic
 * only: detection is read-only, and the reading itself is the CLI's job.
 *
 * Codex loads hooks from four places (its documentation, "Hooks",
 * 2026-09-27): `~/.codex/hooks.json`, a `[hooks]` table in
 * `~/.codex/config.toml`, `<repo>/.codex/hooks.json` and a `[hooks]` table in
 * `<repo>/.codex/config.toml`. REFLEX writes only a `hooks.json`, never a
 * `[hooks]` table: a TOML file cannot be edited surgically the way a JSON
 * file can, and the user's own representation is theirs to keep (RFX-047).
 */
export const HOOK_SCOPES = ["user", "project"] as const;
export type HookScope = (typeof HOOK_SCOPES)[number];

/**
 * REFLEX installs into `user` by default.
 *
 * Codex has no personal, project-scoped file the way Claude Code has
 * `.claude/settings.local.json`: the project file `.codex/hooks.json` is
 * committed and shared, and the hook command holds an absolute path to this
 * user's `rfx`. The user file is personal and fires in every project, so the
 * hook itself keeps to the projects REFLEX was installed in (the install
 * registry), and does nothing elsewhere.
 */
export const DEFAULT_HOOK_SCOPE: HookScope = "user";

export interface ScopeRoots {
  readonly projectDir: string;
  readonly homeDir: string;
}

export function codexDirectory(scope: HookScope, roots: ScopeRoots): string {
  return scope === "user"
    ? join(roots.homeDir, ".codex")
    : join(roots.projectDir, ".codex");
}

/** The JSON file REFLEX installs its hooks into. */
export function hooksFilePath(scope: HookScope, roots: ScopeRoots): string {
  return join(codexDirectory(scope, roots), "hooks.json");
}

/**
 * The TOML configuration at that scope. Read for the `features.hooks` flag,
 * the approval policy, the sandbox and the project's trust; written only to
 * set `features.hooks = true`, without which no hook runs at all.
 */
export function configFilePath(scope: HookScope, roots: ScopeRoots): string {
  return join(codexDirectory(scope, roots), "config.toml");
}
