import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type {
  AgentId,
  FailureMode,
  IsoTimestamp,
  ProjectId,
  ReflexMode,
} from "@reflex/contracts";

import {
  isSupportedHost,
  type HostScope,
  type SupportedHost,
} from "./hosts.js";

/**
 * REFLEX's own local state. It lives under the user's home, not inside the
 * repository: observations and backups are personal, and nothing REFLEX keeps
 * for itself should be one `git add .` away from being published.
 */
export interface Environment {
  readonly homeDir: string;
  readonly projectDir: string;
  /** `REFLEX_HOME`, when set. Mostly for tests. */
  readonly reflexHomeOverride: string | undefined;
  readonly platform: NodeJS.Platform;
  /** How the installed hook starts REFLEX: the node binary and this script. */
  readonly nodePath: string;
  readonly entryPath: string;
  readonly now: () => Date;
}

export function reflexHome(environment: Environment): string {
  return environment.reflexHomeOverride ?? join(environment.homeDir, ".reflex");
}

export const statePaths = (home: string) =>
  ({
    identity: join(home, "identity.json"),
    installs: join(home, "installs.json"),
    observe: join(home, "observe"),
    backups: join(home, "backups"),
  }) as const;

/**
 * RFX-058 — the anonymous local identity.
 *
 * Created on first `rfx init`, random, and never sent anywhere in G1.5. It is
 * what a later claim flow (RFX-061) links to an account without losing local
 * history. It identifies an installation, not a person.
 */
export interface LocalIdentity {
  readonly version: 1;
  readonly agentId: AgentId;
  readonly createdAt: IsoTimestamp;
}

export function newIdentity(now: Date): LocalIdentity {
  return {
    version: 1,
    agentId: `agt_${randomBytes(16).toString("hex")}`,
    createdAt: now.toISOString(),
  };
}

export function newProjectId(): ProjectId {
  return `prj_${randomBytes(16).toString("hex")}`;
}

export interface InstallRecord {
  readonly host: SupportedHost;
  readonly scope: HostScope;
  /** The file REFLEX put its hooks in. Shared by projects under `user` scope. */
  readonly settingsPath: string;
  /**
   * G8, Codex: the `config.toml` in which REFLEX set `features.hooks = true`
   * because it was not on. Absent when the user had it on already, or for
   * a host without such a flag. `rfx uninstall` unsets only what it set.
   */
  readonly enabledFeatureIn?: string;
  readonly projectDir: string;
  readonly projectId: ProjectId;
  /** The transaction manifest that holds the pre-install backup. */
  readonly manifestPath: string;
  readonly installedAt: IsoTimestamp;
  /**
   * RFX-043: what the hook does with a decision in this project (ADR-002).
   * Absent means `observe`: a registry written before modes existed keeps
   * observing, and never starts deciding on its own.
   */
  readonly mode?: ReflexMode;
  /** RFX-043: what the hook answers when it can reach nothing (ADR-003 §4). */
  readonly failureMode?: FailureMode;
}

export const DEFAULT_MODE: ReflexMode = "observe";
export const DEFAULT_FAILURE_MODE: FailureMode = "fail-ask";

export function modeOf(install: InstallRecord | undefined): ReflexMode {
  return install?.mode ?? DEFAULT_MODE;
}

export function failureModeOf(install: InstallRecord | undefined): FailureMode {
  return install?.failureMode ?? DEFAULT_FAILURE_MODE;
}

/**
 * A project's local identity. Kept apart from `installs` on purpose: it has to
 * survive `rfx uninstall`, or re-installing would orphan the project's history
 * and a later claim (RFX-061) would have nothing stable to link.
 */
export interface ProjectIdentity {
  readonly projectDir: string;
  readonly projectId: ProjectId;
}

export interface InstallRegistry {
  readonly version: 1;
  readonly installs: readonly InstallRecord[];
  readonly projects: readonly ProjectIdentity[];
}

export const EMPTY_REGISTRY: InstallRegistry = {
  version: 1,
  installs: [],
  projects: [],
};

/** REFLEX's own state holds local paths and identifiers: user-only. */
export const STATE_FILE_MODE = 0o600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A state file REFLEX cannot read is treated as absent, never trusted. */
export function parseIdentity(
  text: string | undefined,
): LocalIdentity | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      typeof parsed.agentId === "string" &&
      /^agt_[0-9a-f]{32}$/.test(parsed.agentId) &&
      typeof parsed.createdAt === "string"
    ) {
      return {
        version: 1,
        agentId: parsed.agentId as AgentId,
        createdAt: parsed.createdAt,
      };
    }
  } catch {
    // Falls through: unreadable is absent.
  }
  return undefined;
}

export function parseRegistry(text: string | undefined): InstallRegistry {
  if (text === undefined) {
    return EMPTY_REGISTRY;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      Array.isArray(parsed.installs)
    ) {
      const installs = (parsed.installs as unknown[]).flatMap(
        (entry): InstallRecord[] => {
          if (
            !isRecord(entry) ||
            !isSupportedHost(entry.host) ||
            typeof entry.settingsPath !== "string" ||
            typeof entry.projectDir !== "string" ||
            typeof entry.projectId !== "string" ||
            typeof entry.manifestPath !== "string" ||
            typeof entry.scope !== "string" ||
            typeof entry.installedAt !== "string"
          ) {
            return [];
          }
          const { mode, failureMode, ...rest } = entry;
          // A mode or a failure mode that is not one is read as absent: the
          // default is the quietest, never a guess in the other direction.
          return [
            {
              ...(rest as unknown as InstallRecord),
              ...(mode === "observe" ||
              mode === "assist" ||
              mode === "autopilot"
                ? { mode }
                : {}),
              ...(failureMode === "fail-open" ||
              failureMode === "fail-ask" ||
              failureMode === "fail-closed"
                ? { failureMode }
                : {}),
            },
          ];
        },
      );
      const declared = Array.isArray(parsed.projects)
        ? (parsed.projects as unknown[]).filter(
            (entry): entry is ProjectIdentity =>
              isRecord(entry) &&
              typeof entry.projectDir === "string" &&
              typeof entry.projectId === "string",
          )
        : [];
      // A registry written before `projects` existed still knows its projects.
      const projects = [...declared];
      for (const install of installs) {
        if (!projects.some((p) => p.projectDir === install.projectDir)) {
          projects.push({
            projectDir: install.projectDir,
            projectId: install.projectId,
          });
        }
      }
      return { version: 1, installs, projects };
    }
  } catch {
    // Falls through.
  }
  return EMPTY_REGISTRY;
}

export const serialize = (value: unknown): Buffer =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
