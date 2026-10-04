import { join } from "node:path";

import { planDisableHooks } from "@reflex-control/adapter-codex";

import { sha256, type FileSystemPort } from "../backups/file-system.js";
import {
  applyTransaction,
  type BackupManifest,
  type PlannedWrite,
  type TransactionResult,
} from "../backups/transaction.js";
import { hostProfile, SUPPORTED_HOSTS, type SupportedHost } from "../hosts.js";
import {
  parseRegistry,
  reflexHome,
  serialize,
  STATE_FILE_MODE,
  statePaths,
  type Environment,
  type InstallRecord,
} from "../state.js";

/**
 * RFX-057 — `rfx uninstall`, for every host installed in this project.
 *
 * Two ways back, chosen per file (RFX-044):
 *
 * - **Exact.** If the file still holds exactly what REFLEX wrote, the original
 *   bytes are restored from the backup (or the file is removed, if REFLEX
 *   created it). The result is byte-identical to before the install.
 * - **Surgical.** If the user has edited the file since, only REFLEX's own
 *   entries are removed and every other byte stays, their edits included.
 *
 * A file shared with another project (a `user` scope: Codex's default) is
 * left as it is while that project is still installed; only this project's
 * registry entry goes. Codex's `features.hooks` is unset only when REFLEX
 * was the one that set it, the same two ways. Idempotent.
 */
export type RemovalMethod = "exact-restore" | "surgical" | "already-gone";

export interface PlannedRemoval {
  readonly settingsPath: string;
  readonly method: RemovalMethod;
}

export interface UninstallCommandPlan {
  readonly removals: readonly PlannedRemoval[];
  /** Files that could not be understood. Left alone, and reported. */
  readonly skipped: readonly string[];
  /** Files shared with another installed project, kept for it. */
  readonly kept: readonly string[];
  readonly writes: readonly PlannedWrite[];
  readonly backupDir: string;
}

function readManifest(text: string | undefined): BackupManifest | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as BackupManifest;
    return Array.isArray(parsed.entries) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface Candidate {
  readonly path: string;
  readonly host: SupportedHost;
  /** The install whose manifest holds this file's backup, when known. */
  readonly entry: InstallRecord | undefined;
  readonly kind: "hooks" | "feature";
}

export async function planUninstallCommand(
  environment: Environment,
  fileSystem: FileSystemPort,
): Promise<UninstallCommandPlan> {
  const paths = statePaths(reflexHome(environment));
  const registryFile = await fileSystem.read(paths.installs);
  const registry = parseRegistry(registryFile?.content.toString("utf8"));

  // Registered installs for this project, plus any hooks file of this
  // project that still carries a REFLEX hook the registry has lost track of.
  const registered = registry.installs.filter(
    (entry) => entry.projectDir === environment.projectDir,
  );
  const candidates = new Map<string, Candidate>();
  for (const entry of registered) {
    candidates.set(entry.settingsPath, {
      path: entry.settingsPath,
      host: entry.host,
      entry,
      kind: "hooks",
    });
    if (entry.enabledFeatureIn !== undefined) {
      candidates.set(entry.enabledFeatureIn, {
        path: entry.enabledFeatureIn,
        host: entry.host,
        entry,
        kind: "feature",
      });
    }
  }
  for (const host of SUPPORTED_HOSTS) {
    const profile = hostProfile(host);
    for (const scope of profile.scopes) {
      const path = profile.settingsPath(scope, environment);
      if (candidates.has(path)) {
        continue;
      }
      const found = await fileSystem.read(path);
      if (
        profile.inspect(found?.content.toString("utf8")).installedEvents
          .length > 0
      ) {
        candidates.set(path, { path, host, entry: undefined, kind: "hooks" });
      }
    }
  }

  const removals: PlannedRemoval[] = [];
  const skipped: string[] = [];
  const kept: string[] = [];
  const writes: PlannedWrite[] = [];

  for (const candidate of candidates.values()) {
    const { path, host, entry } = candidate;
    // Another project still needs this file as it is: the same hooks file,
    // or, for the feature flag, any other Codex install at all.
    const sharedWith = registry.installs.filter(
      (other) =>
        other.projectDir !== environment.projectDir &&
        (candidate.kind === "feature"
          ? other.host === host
          : other.settingsPath === path),
    );
    if (sharedWith.length > 0) {
      kept.push(path);
      continue;
    }
    const current = await fileSystem.read(path);
    if (current === undefined) {
      removals.push({ settingsPath: path, method: "already-gone" });
      continue;
    }
    const currentSha = sha256(current.content);
    const manifestFile =
      entry === undefined
        ? undefined
        : await fileSystem.read(entry.manifestPath);
    const backup = readManifest(
      manifestFile?.content.toString("utf8"),
    )?.entries.find((candidateEntry) => candidateEntry.path === path);

    if (backup?.writtenSha256 === currentSha) {
      const original =
        backup.backupFile === undefined
          ? undefined
          : await fileSystem.read(backup.backupFile);
      const intact =
        backup.backupFile === undefined ||
        (original !== undefined &&
          sha256(original.content) === backup.originalSha256);
      if (intact) {
        writes.push({
          path,
          content: original?.content,
          expectedSha256: currentSha,
        });
        removals.push({ settingsPath: path, method: "exact-restore" });
        continue;
      }
    }

    const surgical =
      candidate.kind === "feature"
        ? planDisableHooks(current.content.toString("utf8"))
        : hostProfile(host).planUninstall(current.content.toString("utf8"));
    switch (surgical.kind) {
      case "modify":
        writes.push({
          path,
          content: Buffer.from(surgical.newText, "utf8"),
          expectedSha256: currentSha,
        });
        removals.push({ settingsPath: path, method: "surgical" });
        break;
      case "nothing-to-remove":
      case "unchanged":
      case "create":
        removals.push({ settingsPath: path, method: "already-gone" });
        break;
      case "unparseable":
      case "unsupported":
        skipped.push(path);
        break;
    }
  }

  const remaining = registry.installs.filter(
    (entry) =>
      entry.projectDir !== environment.projectDir ||
      skipped.includes(entry.settingsPath),
  );
  if (remaining.length !== registry.installs.length) {
    writes.push({
      path: paths.installs,
      // Project identities stay: they outlive an uninstall (RFX-061).
      content: serialize({
        version: 1,
        installs: remaining,
        projects: registry.projects,
      }),
      expectedSha256:
        registryFile === undefined ? undefined : sha256(registryFile.content),
      createMode: STATE_FILE_MODE,
    });
  }

  const stamp = environment.now().toISOString().replaceAll(/[-:.]/g, "");
  return {
    removals,
    skipped,
    kept,
    writes,
    backupDir: join(paths.backups, `${stamp}-uninstall`),
  };
}

export function applyUninstall(
  plan: UninstallCommandPlan,
  fileSystem: FileSystemPort,
  now: () => Date,
): Promise<TransactionResult> {
  return applyTransaction(plan.writes, {
    backupDir: plan.backupDir,
    fileSystem,
    now,
  });
}
