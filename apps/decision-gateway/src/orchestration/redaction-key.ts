import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { REDACTION_KEY_BYTES } from "@reflex/context-compiler";

/**
 * RFX-031 — the redaction key (ADR-006 §4).
 *
 * Generated once per installation, stored under the REFLEX home with mode
 * 0600, never sent anywhere. The same secret gives the same placeholder on
 * this machine, so repetition is visible without content; without the key
 * a fingerprint cannot be confirmed by guessing. `rfx uninstall --purge`
 * removes it with the rest of the home.
 */
export const REDACTION_KEY_FILE = "redaction.key";
const KEY_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export function redactionKeyPath(reflexHome: string): string {
  return join(reflexHome, REDACTION_KEY_FILE);
}

export type RedactionKeyResult =
  | { readonly ok: true; readonly key: Uint8Array; readonly created: boolean }
  | {
      readonly ok: false;
      readonly reason: "unreadable" | "wrong-size" | "cannot-write";
    };

/**
 * Reads the key, or creates it. A key of the wrong size is refused rather
 * than replaced: replacing it would silently break the continuity of every
 * fingerprint, and a truncated file is a sign of something else wrong.
 */
export async function readOrCreateRedactionKey(
  path: string,
): Promise<RedactionKeyResult> {
  let existing: Buffer | undefined;
  try {
    existing = await readFile(path);
  } catch (error: unknown) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      return { ok: false, reason: "unreadable" };
    }
  }
  if (existing !== undefined) {
    if (existing.length !== REDACTION_KEY_BYTES) {
      return { ok: false, reason: "wrong-size" };
    }
    // A key that became readable by others is tightened, not rotated.
    await chmod(path, KEY_MODE).catch(() => undefined);
    return { ok: true, key: existing, created: false };
  }
  const key = randomBytes(REDACTION_KEY_BYTES);
  try {
    await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
    await writeFile(path, key, { mode: KEY_MODE, flag: "wx" });
  } catch (error: unknown) {
    // Another daemon wrote it first: read theirs.
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return readOrCreateRedactionKey(path);
    }
    return { ok: false, reason: "cannot-write" };
  }
  const written = await stat(path);
  if ((written.mode & 0o777) !== KEY_MODE) {
    await chmod(path, KEY_MODE);
  }
  return { ok: true, key, created: true };
}
