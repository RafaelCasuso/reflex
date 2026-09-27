import type { FailureMode, ReflexMode } from "@reflex/contracts";

import { sha256, type FileSystemPort } from "../backups/file-system.js";
import {
  failureModeOf,
  modeOf,
  parseRegistry,
  reflexHome,
  serialize,
  STATE_FILE_MODE,
  statePaths,
  type Environment,
  type InstallRecord,
} from "../state.js";

/**
 * RFX-043 — `rfx mode`: what the hook does with a decision in this project.
 *
 * Observe records and never answers the host; Assist allows what is safe
 * and hands the rest to the host's own approval, never blocking; Autopilot
 * enforces allow, ask and deny (ADR-002). The failure mode is what the hook
 * answers when it can reach nothing at all (ADR-003 §4). Both live in the
 * install registry, per project, and the hook reads them there on every
 * call; the daemon does not know them.
 */
export interface ModeReport {
  readonly installed: boolean;
  readonly mode: ReflexMode;
  readonly failureMode: FailureMode;
}

export interface ModeChange {
  readonly mode?: ReflexMode;
  readonly failureMode?: FailureMode;
}

export type ModeResult =
  | {
      readonly ok: true;
      readonly before: ModeReport;
      readonly after: ModeReport;
    }
  | { readonly ok: false; readonly reason: "not-installed" | "write-failed" };

function projectInstall(
  installs: readonly InstallRecord[],
  projectDir: string,
): InstallRecord | undefined {
  return installs.find((entry) => entry.projectDir === projectDir);
}

export async function readMode(
  environment: Environment,
  fileSystem: FileSystemPort,
): Promise<ModeReport> {
  const paths = statePaths(reflexHome(environment));
  const registry = parseRegistry(
    (await fileSystem.read(paths.installs))?.content.toString("utf8"),
  );
  const install = projectInstall(registry.installs, environment.projectDir);
  return {
    installed: install !== undefined,
    mode: modeOf(install),
    failureMode: failureModeOf(install),
  };
}

export async function changeMode(
  environment: Environment,
  fileSystem: FileSystemPort,
  change: ModeChange,
): Promise<ModeResult> {
  const paths = statePaths(reflexHome(environment));
  const registryFile = await fileSystem.read(paths.installs);
  const registry = parseRegistry(registryFile?.content.toString("utf8"));
  const install = projectInstall(registry.installs, environment.projectDir);
  if (install === undefined) {
    return { ok: false, reason: "not-installed" };
  }
  const before: ModeReport = {
    installed: true,
    mode: modeOf(install),
    failureMode: failureModeOf(install),
  };
  const updated: InstallRecord = {
    ...install,
    mode: change.mode ?? before.mode,
    failureMode: change.failureMode ?? before.failureMode,
  };
  try {
    const content = serialize({
      ...registry,
      installs: registry.installs.map((entry) =>
        entry === install ? updated : entry,
      ),
    });
    // The registry is small and the write is atomic; a concurrent `rfx
    // init` is the user's own doing, and the last write wins as it would
    // in any settings file.
    if (
      registryFile !== undefined &&
      sha256(registryFile.content) === sha256(content)
    ) {
      return { ok: true, before, after: before };
    }
    await fileSystem.write(paths.installs, content, STATE_FILE_MODE);
  } catch {
    return { ok: false, reason: "write-failed" };
  }
  return {
    ok: true,
    before,
    after: {
      installed: true,
      mode: updated.mode ?? "observe",
      failureMode: updated.failureMode ?? "fail-ask",
    },
  };
}
