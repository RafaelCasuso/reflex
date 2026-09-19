import { join } from "node:path";

import {
  buildHookCommand,
  inspectSettings,
  managedSettingsPaths,
  planInstall,
  SETTINGS_SCOPES,
  settingsPath,
  type SettingsInspection,
  type SettingsScope,
} from "@reflex/adapter-claude-code";

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
 * at apply time, so what the user approved is what happens.
 */
export interface ScopeReport {
  readonly scope: SettingsScope | "managed";
  readonly path: string;
  readonly inspection: SettingsInspection;
}

export type InitWarning =
  | { readonly kind: "hooks-disabled"; readonly path: string }
  | { readonly kind: "managed-hooks-only"; readonly path: string }
  | { readonly kind: "not-git-ignored"; readonly path: string }
  | { readonly kind: "shared-settings-file"; readonly path: string }
  | { readonly kind: "host-not-found" };

export interface InstallInitPlan {
  readonly kind: "install";
  readonly scope: SettingsScope;
  readonly settingsPath: string;
  readonly action: "create" | "modify";
  readonly command: string;
  readonly events: readonly string[];
  readonly createsIdentity: boolean;
  readonly backupDir: string;
  readonly writes: readonly PlannedWrite[];
  readonly reports: readonly ScopeReport[];
  readonly warnings: readonly InitWarning[];
}

export interface AlreadyInstalledPlan {
  readonly kind: "already-installed";
  readonly settingsPath: string;
  readonly reports: readonly ScopeReport[];
  readonly warnings: readonly InitWarning[];
}

export interface BlockedPlan {
  readonly kind: "blocked";
  readonly reason: "unparseable-settings";
  readonly settingsPath: string;
}

export type InitPlan = InstallInitPlan | AlreadyInstalledPlan | BlockedPlan;

export interface InitProbes {
  /** The host's version string, or `undefined` when it is not installed. */
  readonly hostVersion: () => Promise<string | undefined>;
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
  scope: SettingsScope,
  fileSystem: FileSystemPort,
  probes: InitProbes,
): Promise<InitPlan> {
  const home = reflexHome(environment);
  const paths = statePaths(home);
  const target = settingsPath(scope, environment);
  const now = environment.now();

  // Read everything first. Detection never writes (RFX-041).
  const reports: ScopeReport[] = [];
  for (const candidate of SETTINGS_SCOPES) {
    const path = settingsPath(candidate, environment);
    reports.push({
      scope: candidate,
      path,
      inspection: inspectSettings(text(await fileSystem.read(path))),
    });
  }
  for (const path of managedSettingsPaths(environment.platform)) {
    reports.push({
      scope: "managed",
      path,
      inspection: inspectSettings(text(await fileSystem.read(path))),
    });
  }

  const warnings: InitWarning[] = [];
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
  } else if ((await probes.isGitIgnored(target)) === false) {
    warnings.push({ kind: "not-git-ignored", path: target });
  }
  if ((await probes.hostVersion()) === undefined) {
    warnings.push({ kind: "host-not-found" });
  }

  const current = await fileSystem.read(target);
  const command = buildHookCommand(environment.nodePath, environment.entryPath);
  const install = planInstall(text(current), command);

  if (install.kind === "unparseable") {
    return {
      kind: "blocked",
      reason: "unparseable-settings",
      settingsPath: target,
    };
  }
  if (install.kind === "already-installed") {
    return {
      kind: "already-installed",
      settingsPath: target,
      reports,
      warnings,
    };
  }

  const identityFile = await fileSystem.read(paths.identity);
  const identity = parseIdentity(text(identityFile));
  const registryFile = await fileSystem.read(paths.installs);
  const registry = parseRegistry(text(registryFile));

  const backupDir = join(paths.backups, backupStamp(now));
  const previous = registry.installs.find(
    (entry) => entry.settingsPath === target,
  );
  const record: InstallRecord = {
    host: "claude-code",
    scope,
    settingsPath: target,
    projectDir: environment.projectDir,
    // A project keeps its identity across re-installs and uninstalls.
    projectId:
      registry.projects.find(
        (entry) => entry.projectDir === environment.projectDir,
      )?.projectId ?? newProjectId(),
    // The backup that matters is the one taken before REFLEX first touched
    // the file. A re-install must not replace it with a backup of itself.
    manifestPath: previous?.manifestPath ?? join(backupDir, "manifest.json"),
    installedAt: now.toISOString(),
  };

  const writes: PlannedWrite[] = [
    {
      path: target,
      content: Buffer.from(install.newText, "utf8"),
      expectedSha256: digest(current),
    },
    {
      path: paths.installs,
      content: serialize({
        version: 1,
        installs: [
          ...registry.installs.filter((entry) => entry.settingsPath !== target),
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
    },
  ];
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
    scope,
    settingsPath: target,
    action: install.kind,
    command,
    events: install.events,
    createsIdentity: identity === undefined,
    backupDir,
    writes,
    reports,
    warnings,
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
