import { join } from "node:path";

import { managedSettingsPaths } from "@reflex/adapter-claude-code";
import {
  configFilePath,
  inspectConfig,
  planEnableHooks,
  type CodexConfigInspection,
} from "@reflex/adapter-codex";
import type { FailureMode, ReflexMode } from "@reflex/contracts";
import {
  parseTrustRecord,
  policyHashOf,
  PROJECT_POLICY_RELATIVE,
  trustFilePath,
  withTrust,
} from "@reflex/decision-gateway/policy.js";
import { STARTER_POLICY_YAML } from "@reflex/policy-engine";

import {
  sha256,
  type FileSnapshot,
  type FileSystemPort,
} from "../backups/file-system.js";
import {
  applyTransaction,
  type PlannedWrite,
  type TransactionResult,
} from "../backups/transaction.js";
import {
  hostProfile,
  scopeFor,
  type HookFileInspection,
  type HostScope,
  type SupportedHost,
} from "../hosts.js";
import {
  newIdentity,
  newProjectId,
  parseIdentity,
  parseRegistry,
  reflexHome,
  serialize,
  STATE_FILE_MODE,
  statePaths,
  type Environment,
  type InstallRecord,
} from "../state.js";

/**
 * RFX-052 — `rfx init`: detect, plan, show the plan, and only then mutate.
 *
 * `planInit` is read-only and its result is the whole truth about what
 * `applyInit` will do: the exact bytes, the exact paths. Nothing is decided
 * at apply time, so what the user approved is what happens. Since G8 it
 * plans one host at a time (RFX-050 for Codex, RFX-052 for Claude Code);
 * the binary runs it once per host it detected.
 */
/** RFX-043: what the hook will do with a decision (ADR-002, ADR-003). */
export interface InitPreferences {
  readonly mode?: ReflexMode;
  readonly failureMode?: FailureMode;
}

export interface ScopeReport {
  readonly scope: HostScope | "managed";
  readonly path: string;
  readonly inspection: HookFileInspection;
}

export type InitWarning =
  | { readonly kind: "hooks-disabled"; readonly path: string }
  | { readonly kind: "managed-hooks-only"; readonly path: string }
  | { readonly kind: "not-git-ignored"; readonly path: string }
  | { readonly kind: "shared-settings-file"; readonly path: string }
  | { readonly kind: "host-not-found"; readonly host: SupportedHost }
  /** The `--scope` given is not one of this host's; its default is used. */
  | { readonly kind: "scope-substituted"; readonly scope: HostScope }
  /** Codex: `features.hooks` is off and this planner cannot set it here. */
  | {
      readonly kind: "hooks-feature-not-set";
      readonly path: string;
      readonly reason: string;
    }
  /** Codex: the user declares hooks in a `[hooks]` table. Left alone. */
  | { readonly kind: "inline-hooks-table"; readonly path: string };

/** RFX-047: the trust-sensitive setup the plan reports, never changes. */
export interface CodexReport {
  readonly configPath: string;
  readonly config: CodexConfigInspection;
  /** What the plan does to `features.hooks`. */
  readonly feature: "already-on" | "set" | "not-set";
}

export interface InstallInitPlan {
  readonly kind: "install";
  readonly host: SupportedHost;
  /**
   * RFX-054: the starter `.reflex/policy.yaml` this plan writes, trusted
   * at its content (RFX-104), or `undefined` when the project has one.
   * An existing file is never overwritten here.
   */
  readonly starterPolicyPath?: string;
  readonly scope: HostScope;
  readonly settingsPath: string;
  readonly action: "create" | "modify";
  readonly command: string;
  readonly events: readonly string[];
  readonly createsIdentity: boolean;
  readonly backupDir: string;
  readonly writes: readonly PlannedWrite[];
  readonly reports: readonly ScopeReport[];
  readonly warnings: readonly InitWarning[];
  readonly codex?: CodexReport;
}

export interface AlreadyInstalledPlan {
  readonly kind: "already-installed";
  readonly host: SupportedHost;
  readonly settingsPath: string;
  readonly reports: readonly ScopeReport[];
  readonly warnings: readonly InitWarning[];
}

export interface BlockedPlan {
  readonly kind: "blocked";
  readonly host: SupportedHost;
  readonly reason: "unparseable-settings";
  readonly settingsPath: string;
}

export type InitPlan = InstallInitPlan | AlreadyInstalledPlan | BlockedPlan;

export interface InitProbes {
  /** The host's version string, or `undefined` when it is not installed. */
  readonly hostVersion: (host: SupportedHost) => Promise<string | undefined>;
  /** `undefined` when the path is not inside a git repository. */
  readonly isGitIgnored: (path: string) => Promise<boolean | undefined>;
}

const text = (snapshot: FileSnapshot | undefined): string | undefined =>
  snapshot?.content.toString("utf8");

const digest = (snapshot: FileSnapshot | undefined): string | undefined =>
  snapshot === undefined ? undefined : sha256(snapshot.content);

function backupStamp(now: Date): string {
  return now.toISOString().replaceAll(/[-:.]/g, "");
}

export async function planInit(
  environment: Environment,
  host: SupportedHost,
  wantedScope: HostScope | undefined,
  fileSystem: FileSystemPort,
  probes: InitProbes,
  preferences: InitPreferences = {},
): Promise<InitPlan> {
  const profile = hostProfile(host);
  const home = reflexHome(environment);
  const paths = statePaths(home);
  const { scope, substituted } = scopeFor(host, wantedScope);
  const target = profile.settingsPath(scope, environment);
  const now = environment.now();
  const command = profile.hookCommand(
    environment.nodePath,
    environment.entryPath,
  );

  // Read everything first. Detection never writes (RFX-041, RFX-047).
  const reports: ScopeReport[] = [];
  for (const candidate of profile.scopes) {
    const path = profile.settingsPath(candidate, environment);
    reports.push({
      scope: candidate,
      path,
      inspection: profile.inspect(text(await fileSystem.read(path))),
    });
  }
  if (host === "claude-code") {
    for (const path of managedSettingsPaths(environment.platform)) {
      reports.push({
        scope: "managed",
        path,
        inspection: profile.inspect(text(await fileSystem.read(path))),
      });
    }
  }

  const warnings: InitWarning[] = [];
  if (substituted && wantedScope !== undefined) {
    warnings.push({ kind: "scope-substituted", scope: wantedScope });
  }
  for (const report of reports) {
    if (report.inspection.hooksDisabled) {
      warnings.push({ kind: "hooks-disabled", path: report.path });
    }
    if (report.scope === "managed" && report.inspection.managedHooksOnly) {
      warnings.push({ kind: "managed-hooks-only", path: report.path });
    }
  }
  if (scope === "project") {
    warnings.push({ kind: "shared-settings-file", path: target });
  } else if (
    scope === "local" &&
    (await probes.isGitIgnored(target)) === false
  ) {
    warnings.push({ kind: "not-git-ignored", path: target });
  }
  if ((await probes.hostVersion(host)) === undefined) {
    warnings.push({ kind: "host-not-found", host });
  }

  const current = await fileSystem.read(target);
  const install = profile.planInstall(text(current), command);
  if (install.kind === "unparseable") {
    return {
      kind: "blocked",
      host,
      reason: "unparseable-settings",
      settingsPath: target,
    };
  }

  // Codex runs no hook unless `features.hooks` is on, in the user's
  // config.toml, whatever the scope of the hooks file (RFX-050).
  let codex: CodexReport | undefined;
  let configWrite: PlannedWrite | undefined;
  if (host === "codex") {
    const configPath = configFilePath("user", environment);
    const configFile = await fileSystem.read(configPath);
    const config = inspectConfig(text(configFile), environment.projectDir);
    if (config.inlineHookEvents.length > 0) {
      warnings.push({ kind: "inline-hooks-table", path: configPath });
    }
    if (config.hooksEnabled === true) {
      codex = { configPath, config, feature: "already-on" };
    } else {
      const feature = planEnableHooks(text(configFile));
      if (feature.kind === "create" || feature.kind === "modify") {
        codex = { configPath, config, feature: "set" };
        configWrite = {
          path: configPath,
          content: Buffer.from(feature.newText, "utf8"),
          expectedSha256: digest(configFile),
          createMode: STATE_FILE_MODE,
        };
      } else {
        codex = { configPath, config, feature: "not-set" };
        warnings.push({
          kind: "hooks-feature-not-set",
          path: configPath,
          reason:
            feature.kind === "unsupported"
              ? feature.reason
              : feature.kind === "unparseable"
                ? "the file is not valid TOML"
                : "it is off",
        });
      }
    }
  }

  const identityFile = await fileSystem.read(paths.identity);
  const identity = parseIdentity(text(identityFile));
  const registryFile = await fileSystem.read(paths.installs);
  const registry = parseRegistry(text(registryFile));
  const previous = registry.installs.find(
    (entry) =>
      entry.host === host && entry.projectDir === environment.projectDir,
  );

  // Already installed means: the file carries the hooks, the flag is on,
  // and this project is registered. A second project behind the same user
  // file (Codex's default scope) still gets its registry entry.
  const starterMissing =
    (await fileSystem.read(
      join(environment.projectDir, PROJECT_POLICY_RELATIVE),
    )) === undefined;
  if (
    install.kind === "already-installed" &&
    configWrite === undefined &&
    previous !== undefined &&
    !starterMissing
  ) {
    return {
      kind: "already-installed",
      host,
      settingsPath: target,
      reports,
      warnings,
    };
  }

  const backupDir = join(paths.backups, `${backupStamp(now)}-${host}`);
  const reflexSetFlag =
    configWrite?.path ??
    previous?.enabledFeatureIn ??
    registry.installs.find(
      (entry) => entry.host === host && entry.enabledFeatureIn !== undefined,
    )?.enabledFeatureIn;
  const record: InstallRecord = {
    host,
    scope,
    settingsPath: target,
    projectDir: environment.projectDir,
    // RFX-043: a re-install keeps the mode the project had unless told
    // otherwise; a first install observes unless told otherwise. The mode
    // is the project's: another host's install in it says the same.
    mode:
      preferences.mode ??
      previous?.mode ??
      registry.installs.find(
        (entry) => entry.projectDir === environment.projectDir,
      )?.mode ??
      "observe",
    failureMode:
      preferences.failureMode ??
      previous?.failureMode ??
      registry.installs.find(
        (entry) => entry.projectDir === environment.projectDir,
      )?.failureMode ??
      "fail-ask",
    // A project keeps its identity across re-installs and uninstalls.
    projectId:
      registry.projects.find(
        (entry) => entry.projectDir === environment.projectDir,
      )?.projectId ?? newProjectId(),
    // The backup that matters is the one taken before REFLEX first touched
    // the file. A re-install must not replace it with a backup of itself.
    manifestPath: previous?.manifestPath ?? join(backupDir, "manifest.json"),
    installedAt: now.toISOString(),
    // The flag is REFLEX's to unset when REFLEX set it, for whichever
    // project set it: every Codex install shares that fact, and the last
    // one out turns it off.
    ...(reflexSetFlag === undefined ? {} : { enabledFeatureIn: reflexSetFlag }),
  };

  const writes: PlannedWrite[] = [];
  if (install.kind !== "already-installed") {
    writes.push({
      path: target,
      content: Buffer.from(install.newText, "utf8"),
      expectedSha256: digest(current),
    });
  }
  if (configWrite !== undefined) {
    writes.push(configWrite);
  }
  // RFX-054, RFX-104: a conservative starter policy for the project when it
  // has none, trusted at the content REFLEX wrote (the user asked for it).
  // A file that exists is left exactly as it is.
  const starterPath = join(environment.projectDir, PROJECT_POLICY_RELATIVE);
  const existingStarter = await fileSystem.read(starterPath);
  let starterPolicyPath: string | undefined;
  if (existingStarter === undefined) {
    starterPolicyPath = starterPath;
    writes.push({
      path: starterPath,
      content: Buffer.from(STARTER_POLICY_YAML, "utf8"),
      expectedSha256: undefined,
      createMode: 0o644,
    });
    const trustFile = trustFilePath(home);
    const trustFileSnapshot = await fileSystem.read(trustFile);
    writes.push({
      path: trustFile,
      content: serialize(
        withTrust(
          parseTrustRecord(text(trustFileSnapshot)),
          starterPath,
          policyHashOf(STARTER_POLICY_YAML),
          now,
        ),
      ),
      expectedSha256: digest(trustFileSnapshot),
      createMode: STATE_FILE_MODE,
    });
  }
  writes.push({
    path: paths.installs,
    content: serialize({
      version: 1,
      installs: [
        ...registry.installs.filter(
          (entry) =>
            !(
              entry.host === host && entry.projectDir === environment.projectDir
            ),
        ),
        record,
      ],
      projects: [
        ...registry.projects.filter(
          (entry) => entry.projectDir !== environment.projectDir,
        ),
        { projectDir: environment.projectDir, projectId: record.projectId },
      ],
    }),
    expectedSha256: digest(registryFile),
    createMode: STATE_FILE_MODE,
  });
  if (identity === undefined) {
    writes.push({
      path: paths.identity,
      content: serialize(newIdentity(now)),
      expectedSha256: digest(identityFile),
      createMode: STATE_FILE_MODE,
    });
  }

  return {
    kind: "install",
    host,
    scope,
    settingsPath: target,
    action: install.kind === "already-installed" ? "modify" : install.kind,
    command,
    events: profile.events,
    createsIdentity: identity === undefined,
    backupDir,
    writes,
    reports,
    warnings,
    ...(codex === undefined ? {} : { codex }),
    ...(starterPolicyPath === undefined ? {} : { starterPolicyPath }),
  };
}

export function applyInit(
  plan: InstallInitPlan,
  fileSystem: FileSystemPort,
  now: () => Date,
): Promise<TransactionResult> {
  return applyTransaction(plan.writes, {
    backupDir: plan.backupDir,
    fileSystem,
    now,
  });
}
