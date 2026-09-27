import { configFilePath, inspectConfig } from "@reflex/adapter-codex";
import type { ActionOutcome } from "@reflex/contracts";
import {
  assembleOutcomes,
  ObservationLog,
  type ObservedActionRecord,
} from "@reflex/telemetry";

import type { FileSystemPort } from "../backups/file-system.js";
import { daemonStatus, type DaemonStatus } from "../daemon/lifecycle.js";
import { hostProfile, type SupportedHost } from "../hosts.js";
import { readProvider, type ProviderReport } from "./provider.js";
import {
  parseIdentity,
  parseRegistry,
  reflexHome,
  statePaths,
  type Environment,
  type LocalIdentity,
} from "../state.js";

/**
 * RFX-056 — `rfx status`. Local, offline, no dashboard.
 *
 * It reports what REFLEX can actually see. In particular it re-reads each
 * settings file instead of trusting its own registry: a hook that was removed
 * or disabled since `rfx init` is the most important thing status can say,
 * because REFLEX must never be silently absent (CLAUDE.md principle 5).
 */
export type HookHealth =
  | "active"
  /** The settings file no longer carries every REFLEX hook. */
  | "missing"
  /** `disableAllHooks` is set in that file. */
  | "disabled"
  /**
   * RFX-103: the hook is there and runs something else. It still carries
   * REFLEX's marker, so nothing but its command gives it away.
   */
  | "altered"
  | "unreadable";

export interface AdapterStatus {
  readonly host: SupportedHost;
  readonly settingsPath: string;
  readonly health: HookHealth;
  /** What disabled it, when `disabled`. */
  readonly disabledBy?: string;
}

export interface OutcomeSummary {
  readonly actions: number;
  readonly prompted: number;
  readonly approved: number;
  readonly rejected: number;
  readonly ranWithoutPrompt: number;
  readonly blockedByHost: number;
  readonly unknown: number;
}

export interface HookOverhead {
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export interface StatusReport {
  readonly mode: "observe";
  readonly identity: LocalIdentity | undefined;
  /** RFX-138: whether the local decision daemon answers, and what it says. */
  readonly daemon: DaemonStatus;
  /** RFX-123: the configured provider and whether consent covers it. */
  readonly provider: ProviderReport;
  readonly adapters: readonly AdapterStatus[];
  readonly lastAction: ObservedActionRecord | undefined;
  readonly summary: OutcomeSummary;
  readonly overhead: HookOverhead | undefined;
  readonly logFile: string;
}

const RECENT_RECORDS = 5_000;

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

export function summarize(outcomes: readonly ActionOutcome[]): OutcomeSummary {
  const count = (test: (outcome: ActionOutcome) => boolean): number =>
    outcomes.filter(test).length;
  return {
    actions: outcomes.length,
    prompted: count((o) => o.prompted === "yes"),
    approved: count((o) => o.humanResponse === "approved"),
    rejected: count((o) => o.humanResponse === "rejected"),
    ranWithoutPrompt: count((o) => o.prompted === "no" && o.executed === "yes"),
    blockedByHost: count((o) => o.prompted === "no" && o.executed === "no"),
    // Counted apart on purpose: unknown is never folded into "not prompted".
    unknown: count((o) => o.prompted === "unknown"),
  };
}

export async function collectStatus(
  environment: Environment,
  fileSystem: FileSystemPort,
  probe: (home: string) => Promise<DaemonStatus> = daemonStatus,
): Promise<StatusReport> {
  const paths = statePaths(reflexHome(environment));
  const daemon = await probe(reflexHome(environment));
  const provider = await readProvider(environment, fileSystem);
  const registry = parseRegistry(
    (await fileSystem.read(paths.installs))?.content.toString("utf8"),
  );
  const identity = parseIdentity(
    (await fileSystem.read(paths.identity))?.content.toString("utf8"),
  );

  const adapters: AdapterStatus[] = [];
  for (const install of registry.installs) {
    if (install.projectDir !== environment.projectDir) {
      continue;
    }
    const profile = hostProfile(install.host);
    const file = await fileSystem.read(install.settingsPath);
    const inspection = profile.inspect(
      file?.content.toString("utf8"),
      profile.hookCommand(environment.nodePath, environment.entryPath),
    );
    const complete = profile.events.every((event) =>
      inspection.installedEvents.includes(event),
    );
    // Codex runs no hook while `features.hooks` is off (G8).
    let disabledBy: string | undefined;
    if (inspection.hooksDisabled) {
      disabledBy = `"disableAllHooks" in that file`;
    } else if (install.host === "codex") {
      const configPath = configFilePath("user", environment);
      const config = inspectConfig(
        (await fileSystem.read(configPath))?.content.toString("utf8"),
      );
      if (config.hooksEnabled !== true) {
        disabledBy = `features.hooks is off in ${configPath}`;
      }
    }
    adapters.push({
      host: install.host,
      settingsPath: install.settingsPath,
      health:
        inspection.state === "unparseable"
          ? "unreadable"
          : disabledBy !== undefined
            ? "disabled"
            : !complete
              ? "missing"
              : inspection.alteredEvents.length > 0
                ? "altered"
                : "active",
      ...(disabledBy === undefined ? {} : { disabledBy }),
    });
  }

  const log = new ObservationLog({ directory: paths.observe });
  const records = (await log.readRecent(RECENT_RECORDS)).filter(
    (record) =>
      record.kind !== "action" ||
      record.projectRoot === undefined ||
      record.projectRoot === environment.projectDir ||
      record.projectRoot.startsWith(`${environment.projectDir}/`),
  );
  const actions = records.filter(
    (record): record is ObservedActionRecord => record.kind === "action",
  );

  const timings = records
    .flatMap((record) =>
      record.kind !== "turn-ended" && record.hookMs !== undefined
        ? [record.hookMs]
        : [],
    )
    .sort((a, b) => a - b);

  return {
    mode: "observe",
    identity,
    daemon,
    provider,
    adapters,
    lastAction: actions.at(-1),
    summary: summarize(assembleOutcomes(records)),
    overhead:
      timings.length === 0
        ? undefined
        : {
            samples: timings.length,
            p50Ms: percentile(timings, 0.5),
            p95Ms: percentile(timings, 0.95),
          },
    logFile: log.activeFile,
  };
}
