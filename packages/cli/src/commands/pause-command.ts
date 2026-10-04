import { appendFile } from "node:fs/promises";

import type { FileSystemPort } from "../backups/file-system.js";
import {
  activePause,
  auditPath,
  parseDuration,
  parsePause,
  pausePath,
  pauseRecord,
  type AuditEvent,
  type PauseRecord,
} from "../pause.js";
import {
  reflexHome,
  serialize,
  STATE_FILE_MODE,
  type Environment,
} from "../state.js";

/** RFX-126 — the pause and resume commands, and the local audit line they write. */
export async function appendAudit(
  home: string,
  event: AuditEvent,
): Promise<void> {
  try {
    await appendFile(auditPath(home), `${JSON.stringify(event)}\n`, {
      mode: STATE_FILE_MODE,
    });
  } catch {
    // The audit never stops the command; `rfx doctor` reports an unwritable home.
  }
}

export async function currentPause(
  environment: Environment,
  fileSystem: FileSystemPort,
): Promise<PauseRecord | undefined> {
  const text = (
    await fileSystem.read(pausePath(reflexHome(environment)))
  )?.content.toString("utf8");
  return activePause(parsePause(text), environment.now());
}

export type PauseResult =
  | { readonly kind: "paused"; readonly record: PauseRecord }
  | { readonly kind: "bad-duration" }
  | { readonly kind: "write-failed" };

export async function pauseEnforcement(
  environment: Environment,
  fileSystem: FileSystemPort,
  duration: string | undefined,
  reason: string | undefined,
): Promise<PauseResult> {
  const ms = duration === undefined ? undefined : parseDuration(duration);
  if (ms === undefined) {
    return { kind: "bad-duration" };
  }
  const home = reflexHome(environment);
  const record = pauseRecord(environment.now(), ms, reason);
  try {
    await fileSystem.write(pausePath(home), serialize(record), STATE_FILE_MODE);
  } catch {
    return { kind: "write-failed" };
  }
  await appendAudit(home, {
    at: record.pausedAt,
    kind: "pause",
    projectDir: environment.projectDir,
    detail: {
      until: record.until,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
    },
  });
  return { kind: "paused", record };
}

export type ResumeResult =
  | { readonly kind: "resumed"; readonly wasPausedUntil: string }
  | { readonly kind: "not-paused" }
  | { readonly kind: "write-failed" };

export async function resumeEnforcement(
  environment: Environment,
  fileSystem: FileSystemPort,
): Promise<ResumeResult> {
  const home = reflexHome(environment);
  const file = await fileSystem.read(pausePath(home));
  const record = activePause(
    parsePause(file?.content.toString("utf8")),
    environment.now(),
  );
  if (file !== undefined) {
    try {
      await fileSystem.remove(pausePath(home));
    } catch {
      return { kind: "write-failed" };
    }
  }
  if (record === undefined) {
    return { kind: "not-paused" };
  }
  await appendAudit(home, {
    at: environment.now().toISOString(),
    kind: "resume",
    projectDir: environment.projectDir,
    detail: { wasPausedUntil: record.until },
  });
  return { kind: "resumed", wasPausedUntil: record.until };
}
