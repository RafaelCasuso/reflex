import { join } from "node:path";

import {
  nodeFileSystem,
  sha256,
  type FileSnapshot,
  type FileSystemPort,
} from "./file-system.js";

/**
 * RFX-053 — every configuration write goes through a reversible transaction.
 *
 * A transaction is built from a plan that the user has already been shown
 * (RFX-052). Applying it must therefore do exactly what the plan said, to
 * exactly the bytes the plan was computed from, or do nothing at all.
 */
export interface PlannedWrite {
  /** Absolute path. */
  readonly path: string;
  /** New content. `undefined` deletes the file. */
  readonly content: Buffer | undefined;
  /**
   * SHA-256 of the content the plan was computed from, or `undefined` when
   * the file did not exist. If the file has changed since, the transaction
   * refuses to run: the user approved a plan for a different file.
   */
  readonly expectedSha256: string | undefined;
}

export interface BackupEntry {
  readonly path: string;
  /** `undefined` when the file did not exist before the transaction. */
  readonly backupFile: string | undefined;
  readonly originalSha256: string | undefined;
  readonly originalMode: number | undefined;
  /** SHA-256 of what the transaction wrote. `undefined` for a deletion. */
  readonly writtenSha256: string | undefined;
}

export interface BackupManifest {
  readonly version: 1;
  readonly createdAt: string;
  readonly entries: readonly BackupEntry[];
}

export type TransactionFailureReason =
  /** A file changed between planning and applying. Nothing was written. */
  | "changed-since-plan"
  /** A backup could not be written. Nothing was written. */
  | "backup-failed"
  /** A write failed. Earlier writes were rolled back. */
  | "write-failed";

export interface TransactionSuccess {
  readonly ok: true;
  readonly manifest: BackupManifest;
  readonly manifestPath: string;
}

export interface TransactionFailure {
  readonly ok: false;
  readonly reason: TransactionFailureReason;
  /** The file the failure is about. */
  readonly path: string;
  /**
   * `true` when every file is back to its original bytes (or nothing was
   * touched). `false` means a rollback step failed too: `unrestored` lists
   * the files to recover by hand from `backupDir`.
   */
  readonly rolledBack: boolean;
  readonly unrestored: readonly string[];
  readonly backupDir: string;
}

export type TransactionResult = TransactionSuccess | TransactionFailure;

export interface TransactionOptions {
  /** Directory that receives the backups and the manifest for this run. */
  readonly backupDir: string;
  readonly fileSystem?: FileSystemPort;
  readonly now?: () => Date;
}

const DEFAULT_MODE = 0o644;
const MANIFEST_MODE = 0o600;

interface Applied {
  readonly write: PlannedWrite;
  readonly original: FileSnapshot | undefined;
}

export async function applyTransaction(
  writes: readonly PlannedWrite[],
  options: TransactionOptions,
): Promise<TransactionResult> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const { backupDir } = options;
  const fail = (
    reason: TransactionFailureReason,
    path: string,
    unrestored: readonly string[] = [],
  ): TransactionFailure => ({
    ok: false,
    reason,
    path,
    rolledBack: unrestored.length === 0,
    unrestored,
    backupDir,
  });

  // Phase 1: read everything and verify the plan still describes reality.
  // Nothing is written until every file has passed.
  const originals: (FileSnapshot | undefined)[] = [];
  for (const write of writes) {
    const original = await fileSystem.read(write.path);
    const actual =
      original === undefined ? undefined : sha256(original.content);
    if (actual !== write.expectedSha256) {
      return fail("changed-since-plan", write.path);
    }
    originals.push(original);
  }

  // Phase 2: back everything up before touching anything.
  const entries: BackupEntry[] = [];
  for (const [index, write] of writes.entries()) {
    const original = originals[index];
    const backupFile =
      original === undefined
        ? undefined
        : join(backupDir, `${String(index).padStart(3, "0")}.bak`);
    try {
      if (original !== undefined && backupFile !== undefined) {
        await fileSystem.write(backupFile, original.content, MANIFEST_MODE);
      }
    } catch {
      return fail("backup-failed", write.path);
    }
    entries.push({
      path: write.path,
      backupFile,
      originalSha256:
        original === undefined ? undefined : sha256(original.content),
      originalMode: original?.mode,
      writtenSha256:
        write.content === undefined ? undefined : sha256(write.content),
    });
  }

  const manifest: BackupManifest = {
    version: 1,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    entries,
  };
  const manifestPath = join(backupDir, "manifest.json");
  try {
    await fileSystem.write(
      manifestPath,
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      MANIFEST_MODE,
    );
  } catch {
    return fail("backup-failed", manifestPath);
  }

  // Phase 3: apply, remembering what was done so it can be undone.
  const applied: Applied[] = [];
  for (const [index, write] of writes.entries()) {
    const original = originals[index];
    try {
      if (write.content === undefined) {
        await fileSystem.remove(write.path);
      } else {
        await fileSystem.write(
          write.path,
          write.content,
          original?.mode ?? DEFAULT_MODE,
        );
      }
      applied.push({ write, original });
    } catch {
      const unrestored = await rollback(fileSystem, [
        ...applied,
        // The failed write may have landed partially: restore it as well.
        { write, original },
      ]);
      return fail("write-failed", write.path, unrestored);
    }
  }

  return { ok: true, manifest, manifestPath };
}

/** Undoes writes in reverse order. Returns the paths it could not restore. */
async function rollback(
  fileSystem: FileSystemPort,
  applied: readonly Applied[],
): Promise<string[]> {
  const unrestored: string[] = [];
  for (const { write, original } of [...applied].reverse()) {
    try {
      if (original === undefined) {
        await fileSystem.remove(write.path);
      } else {
        await fileSystem.write(write.path, original.content, original.mode);
      }
    } catch {
      unrestored.push(write.path);
    }
  }
  return unrestored;
}
