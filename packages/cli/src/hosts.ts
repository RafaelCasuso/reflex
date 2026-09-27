import * as claude from "@reflex/adapter-claude-code";
import * as codex from "@reflex/adapter-codex";

/**
 * G8 — the hosts `rfx` installs into, behind one shape.
 *
 * Each adapter knows its host and nothing else (CLAUDE.md: "host-specific
 * translation only"); the CLI knows the registry, the transactions and the
 * daemon. This file is where the two meet: the file a host reads hooks from,
 * the command to put in it, and the pure planners that edit it. What differs
 * beyond that (Claude Code's managed settings, Codex's `features.hooks`
 * flag and trust) is handled where it is needed, by host, explicitly.
 */
export const SUPPORTED_HOSTS = ["claude-code", "codex"] as const;
export type SupportedHost = (typeof SUPPORTED_HOSTS)[number];

/** Every scope any host has; which ones a host accepts is its profile's. */
export type HostScope = "local" | "project" | "user";

export interface HostRoots {
  readonly projectDir: string;
  readonly homeDir: string;
}

/** The common shape of both adapters' inspections. */
export interface HookFileInspection {
  readonly state: "absent" | "valid" | "unparseable";
  readonly installedEvents: readonly string[];
  readonly alteredEvents: readonly string[];
  readonly foreignHooks: number;
  /** Claude Code: `disableAllHooks`. */
  readonly hooksDisabled: boolean;
  /** Claude Code managed settings: `allowManagedHooksOnly`. */
  readonly managedHooksOnly: boolean;
}

export type HookInstallPlan = claude.InstallPlan;
export type HookUninstallPlan = claude.UninstallPlan;

export interface HostProfile {
  readonly host: SupportedHost;
  readonly displayName: string;
  /** The binary whose `--version` says the host is installed. */
  readonly binary: string;
  readonly scopes: readonly HostScope[];
  readonly defaultScope: HostScope;
  readonly events: readonly string[];
  settingsPath(scope: HostScope, roots: HostRoots): string;
  hookCommand(nodePath: string, entryPath: string): string;
  inspect(
    text: string | undefined,
    expectedCommand?: string,
  ): HookFileInspection;
  planInstall(text: string | undefined, command: string): HookInstallPlan;
  planUninstall(text: string): HookUninstallPlan;
}

function claudeScope(scope: HostScope): claude.SettingsScope {
  return claude.SETTINGS_SCOPES.includes(scope) ? scope : claude.DEFAULT_SCOPE;
}

function codexScope(scope: HostScope): codex.HookScope {
  return (codex.HOOK_SCOPES as readonly string[]).includes(scope)
    ? (scope as codex.HookScope)
    : codex.DEFAULT_HOOK_SCOPE;
}

const CLAUDE_CODE: HostProfile = {
  host: "claude-code",
  displayName: "Claude Code",
  binary: "claude",
  scopes: claude.SETTINGS_SCOPES,
  defaultScope: claude.DEFAULT_SCOPE,
  events: claude.OBSERVED_EVENTS.map(({ event }) => event),
  settingsPath: (scope, roots) =>
    claude.settingsPath(claudeScope(scope), roots),
  hookCommand: claude.buildHookCommand,
  inspect: (text, expectedCommand) =>
    claude.inspectSettings(text, expectedCommand),
  planInstall: claude.planInstall,
  planUninstall: claude.planUninstall,
};

const CODEX: HostProfile = {
  host: "codex",
  displayName: "Codex",
  binary: "codex",
  scopes: codex.HOOK_SCOPES,
  defaultScope: codex.DEFAULT_HOOK_SCOPE,
  events: codex.OBSERVED_EVENTS.map(({ event }) => event),
  settingsPath: (scope, roots) => codex.hooksFilePath(codexScope(scope), roots),
  hookCommand: codex.buildHookCommand,
  inspect: (text, expectedCommand) => ({
    ...codex.inspectHooksFile(text, expectedCommand),
    hooksDisabled: false,
    managedHooksOnly: false,
  }),
  planInstall: codex.planInstall,
  planUninstall: codex.planUninstall,
};

const PROFILES: Readonly<Record<SupportedHost, HostProfile>> = {
  "claude-code": CLAUDE_CODE,
  codex: CODEX,
};

export function hostProfile(host: SupportedHost): HostProfile {
  return PROFILES[host];
}

export function isSupportedHost(value: unknown): value is SupportedHost {
  return (
    typeof value === "string" &&
    (SUPPORTED_HOSTS as readonly string[]).includes(value)
  );
}

/**
 * The scope a host installs into for a `--scope` the user gave, or its
 * default when the value is not one of that host's. `local` is Claude Code's
 * personal project file; Codex has none, and gets `user`.
 */
export function scopeFor(
  host: SupportedHost,
  wanted: HostScope | undefined,
): { readonly scope: HostScope; readonly substituted: boolean } {
  const profile = hostProfile(host);
  if (wanted === undefined) {
    return { scope: profile.defaultScope, substituted: false };
  }
  return profile.scopes.includes(wanted)
    ? { scope: wanted, substituted: false }
    : { scope: profile.defaultScope, substituted: true };
}

/**
 * Whether a payload's working directory belongs to a project REFLEX was
 * installed in for this host: the project itself or a directory under it.
 * A user-scoped hook fires in every project and keeps to these.
 */
export function installedProjectFor<
  Install extends { readonly host: string; readonly projectDir: string },
>(
  installs: readonly Install[],
  host: SupportedHost,
  cwd: string | undefined,
): Install | undefined {
  if (cwd === undefined) {
    return undefined;
  }
  return installs
    .filter(
      (entry) =>
        entry.host === host &&
        (cwd === entry.projectDir || cwd.startsWith(`${entry.projectDir}/`)),
    )
    .sort((a, b) => b.projectDir.length - a.projectDir.length)[0];
}
