import { join } from "node:path";

import {
  inspectSettings,
  planUninstall,
  SETTINGS_SCOPES,
  settingsPath,
} from "@reflex/adapter-claude-code";

import { sha256, type FileSystemPort } from "../backups/file-system.js";
import {
  applyTransaction,
  type BackupManifest,
  type PlannedWrite,
  type TransactionResult,
} from "../backups/transaction.js";
import {
  parseRegistry,
  reflexHome,
  serialize,
  STATE_FILE_MODE,
  statePaths,
  type Environment,
} from "../state.js";

/**
 * RFX-057 — `rfx uninstall`.
 *
 * Two ways back, chosen per file (RFX-044):
 *
 * - **Exact.** If the file still holds exactly what REFLEX wrote, the original
 *   bytes are restored from the backup (or the file is removed, if REFLEX
 *   created it). The result is byte-identical to before the install.
 * - **Surgical.** If the user has edited the file since, only REFLEX's own
 *   entries are removed and every other byte stays, their edits included.
 *
 * Idempotent: with nothing installed there is nothing to do, and it says so.
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

export async function planUninstallCommand(
  environment: Environment,
  fileSystem: FileSystemPort,
): Promise<UninstallCommandPlan> {
  const paths = statePaths(reflexHome(environment));
  const registryFile = await fileSystem.read(paths.installs);
  const registry = parseRegistry(registryFile?.content.toString("utf8"));

  // Registered installs for this project, plus any settings file of this
  // project that still carries a REFLEX hook the registry has lost track of.
  const registered = registry.installs.filter(
    (entry) => entry.projectDir === environment.projectDir,
  );
  const candidates = new Set(registered.map((entry) => entry.settingsPath));
  for (const scope of SETTINGS_SCOPES) {
    const path = settingsPath(scope, environment);
    const found = await fileSystem.read(path);
    if (
      inspectSettings(found?.content.toString("utf8")).installedEvents.length >
      0
    ) {
      candidates.add(path);
    }
  }

  const removals: PlannedRemoval[] = [];
  const skipped: string[] = [];
  const writes: PlannedWrite[] = [];

  for (const path of candidates) {
    const current = await fileSystem.read(path);
    if (current === undefined) {
      removals.push({ settingsPath: path, method: "already-gone" });
      continue;
    }
    const currentSha = sha256(current.content);
    const entry = registered.find((install) => install.settingsPath === path);
    const manifestFile =
      entry === undefined
        ? undefined
        : await fileSystem.read(entry.manifestPath);
    const backup = readManifest(
      manifestFile?.content.toString("utf8"),
    )?.entries.find((candidate) => candidate.path === path);

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

    const surgical = planUninstall(current.content.toString("utf8"));
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
        removals.push({ settingsPath: path, method: "already-gone" });
        break;
      case "unparseable":
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
