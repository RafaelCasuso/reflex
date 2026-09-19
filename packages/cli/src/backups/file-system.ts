import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The file operations a config transaction needs, as a port. Tests inject a
 * failing implementation to prove rollback; production uses `nodeFileSystem`.
 */
export interface FileSnapshot {
  /** Raw bytes. Configuration is restored byte for byte, so no decoding. */
  readonly content: Buffer;
  /** Permission bits, for example 0o600 on a user's settings file. */
  readonly mode: number;
}

export interface FileSystemPort {
  /** `undefined` when the file does not exist. Follows symlinks. */
  read(path: string): Promise<FileSnapshot | undefined>;
  /** Atomic replace that keeps a symlink a symlink. Creates parent dirs. */
  write(path: string, content: Buffer, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
}

export function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * Where a write must land. Many developers keep their settings under a
 * dotfiles repository and symlink them into place; renaming a temp file over
 * the link would silently replace it with a regular file and detach their
 * setup. The write goes to the link's target instead.
 */
async function resolveTarget(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    return info.isSymbolicLink() ? await realpath(path) : path;
  } catch (error) {
    if (isMissing(error)) {
      return path;
    }
    throw error;
  }
}

export const nodeFileSystem: FileSystemPort = {
  async read(path) {
    try {
      const [content, info] = await Promise.all([readFile(path), stat(path)]);
      return { content, mode: info.mode & 0o777 };
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
  },

  async write(path, content, mode) {
    const target = await resolveTarget(path);
    await mkdir(dirname(target), { recursive: true });

    // Same directory as the target, so the rename cannot cross a filesystem.
    const temporary = join(
      dirname(target),
      `.reflex-${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      const handle = await open(temporary, "wx", mode);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // `open` applies the umask; the original mode must survive exactly.
      await chmod(temporary, mode);
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  },

  async remove(path) {
    await rm(path, { force: true });
  },
};
