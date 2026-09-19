import { join } from "node:path";

/**
 * RFX-041 — where Claude Code reads settings from. Path arithmetic only:
 * detection is read-only, and the reading itself is the CLI's job.
 */
export const SETTINGS_SCOPES = ["local", "project", "user"] as const;
export type SettingsScope = (typeof SETTINGS_SCOPES)[number];

/**
 * REFLEX installs into `local` by default.
 *
 * `docs/integrations.md` asks for project scope first. A project has two
 * settings files, and they differ in who they affect: `.claude/settings.json`
 * is committed and shared, `.claude/settings.local.json` is personal and
 * ignored by git. The hook command holds an absolute path to this user's
 * `rfx`, so writing it to the shared file would hand every teammate a hook
 * that fails on their machine. Team-wide rollout is a later, deliberate step.
 */
export const DEFAULT_SCOPE: SettingsScope = "local";

export interface ScopeRoots {
  readonly projectDir: string;
  readonly homeDir: string;
}

export function settingsPath(scope: SettingsScope, roots: ScopeRoots): string {
  switch (scope) {
    case "local":
      return join(roots.projectDir, ".claude", "settings.local.json");
    case "project":
      return join(roots.projectDir, ".claude", "settings.json");
    case "user":
      return join(roots.homeDir, ".claude", "settings.json");
  }
}

/**
 * Administrator-deployed settings. REFLEX never writes here. It reads them
 * only to warn: an organization can restrict hooks to managed ones, in which
 * case a user-level install would be written and silently never run.
 */
export function managedSettingsPaths(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  }
  if (platform === "win32") {
    return ["C:\\ProgramData\\ClaudeCode\\managed-settings.json"];
  }
  // Linux and every other Unix-like platform.
  return ["/etc/claude-code/managed-settings.json"];
}
