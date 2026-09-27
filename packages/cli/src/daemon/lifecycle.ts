import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseConsentRecord } from "@reflex/semantic-provider";

import {
  configPath,
  consentPath,
  daemonArguments,
  parseConfig,
  withConsent,
} from "../config.js";
import { requestOverSocket } from "./client.js";

/**
 * RFX-138 — the daemon's lifecycle (ADR-010): start it once when it does
 * not answer, find it when it does, replace it when it is not the version
 * this installation ships, stop it on uninstall.
 *
 * One daemon per user, whatever the project or the host: its socket lives
 * under the REFLEX home, in a directory of mode 0700, and is 0600. Several
 * hooks may find it down at the same moment; one of them starts it (a lock
 * taken with `O_EXCL`) and the others wait for it to answer. A socket or a
 * PID file left behind by a crash is never joined: the daemon itself
 * replaces a socket nobody answers on, and a PID is only ever signalled
 * when the daemon answering on the socket reports it as its own.
 */
export const RUN_DIRECTORY = "run";
export const SOCKET_FILE = "reflex.sock";
export const STATE_FILE = "daemon.json";
export const LOCK_FILE = "start.lock";
export const LOG_FILE = "daemon.log";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** A lock older than this belongs to a starter that died. */
const STALE_LOCK_MS = 15_000;
const POLL_MS = 20;
const PROBE_TIMEOUT_MS = 250;
/**
 * `rfx uninstall`, `rfx provider` and `rfx status` are run by a human, off
 * the hot path, and must not mistake a slow daemon for a stopped one: a
 * probe that gives up in 250 ms on a loaded machine would report "not
 * running", and `stopDaemon` would then remove the socket of a live daemon
 * (seen once on a CI runner). They wait longer.
 */
const HUMAN_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_START_DEADLINE_MS = 2_500;
const DEFAULT_STOP_GRACE_MS = 3_000;

export interface DaemonPaths {
  readonly home: string;
  readonly runDir: string;
  readonly socketPath: string;
  readonly stateFile: string;
  readonly lockFile: string;
  readonly logFile: string;
  readonly policyFile: string;
}

export function daemonPaths(home: string): DaemonPaths {
  const runDir = join(home, RUN_DIRECTORY);
  return {
    home,
    runDir,
    socketPath: join(runDir, SOCKET_FILE),
    stateFile: join(runDir, STATE_FILE),
    lockFile: join(runDir, LOCK_FILE),
    logFile: join(runDir, LOG_FILE),
    policyFile: join(home, "policy.yaml"),
  };
}

export interface DaemonHealth {
  readonly version: string;
  readonly pid: number | undefined;
  readonly uptimeMs: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type DaemonProbe =
  | { readonly state: "running"; readonly health: DaemonHealth }
  | { readonly state: "down" };

/** What `daemon.json` remembers. Advisory: the socket is the truth. */
export interface DaemonState {
  readonly version: 1;
  readonly pid: number;
  readonly daemonVersion: string;
  readonly startedAt: string;
  readonly startedBy: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function probeDaemon(
  paths: DaemonPaths,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<DaemonProbe> {
  if (!existsSync(paths.socketPath)) {
    return { state: "down" };
  }
  const result = await requestOverSocket({
    socketPath: paths.socketPath,
    method: "GET",
    path: "/v1/health",
    timeoutMs,
  });
  if (!result.ok || result.response.status !== 200) {
    return { state: "down" };
  }
  const body = result.response.json;
  if (!isRecord(body) || typeof body.version !== "string") {
    return { state: "down" };
  }
  return {
    state: "running",
    health: {
      version: body.version,
      pid: typeof body.pid === "number" ? body.pid : undefined,
      uptimeMs: typeof body.uptimeMs === "number" ? body.uptimeMs : 0,
      raw: body,
    },
  };
}

export function readDaemonState(paths: DaemonPaths): DaemonState | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.stateFile, "utf8"));
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      typeof parsed.pid === "number" &&
      typeof parsed.daemonVersion === "string" &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.startedBy === "string"
    ) {
      return parsed as unknown as DaemonState;
    }
  } catch {
    // Absent or unreadable: not trusted.
  }
  return undefined;
}

/** Where the daemon's entry point is: the gateway this installation ships. */
export function daemonEntry(): string {
  return fileURLToPath(import.meta.resolve("@reflex/decision-gateway/main.js"));
}

/** The version the gateway this installation ships declares in its manifest. */
export function shippedDaemonVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(
      fileURLToPath(
        import.meta.resolve("@reflex/decision-gateway/package.json"),
      ),
      "utf8",
    ),
  );
  return isRecord(manifest) && typeof manifest.version === "string"
    ? manifest.version
    : "0.0.0";
}

export interface EnsureDaemonOptions {
  readonly home: string;
  readonly nodePath: string;
  /** The version the daemon must report; another one is replaced. */
  readonly expectedVersion?: string;
  readonly deadlineMs?: number;
  /** For tests: the entry point and extra arguments. */
  readonly entry?: string;
  readonly extraArguments?: readonly string[];
  readonly startedBy?: string;
}

export type EnsureDaemonResult =
  | {
      readonly ok: true;
      readonly health: DaemonHealth;
      /** This call started it. */
      readonly started: boolean;
      /** This call stopped another version first. */
      readonly replaced: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: "start-failed" | "no-answer" | "lock-held";
    };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitForAnswer(
  paths: DaemonPaths,
  deadlineAt: number,
): Promise<DaemonHealth | undefined> {
  while (Date.now() < deadlineAt) {
    const probe = await probeDaemon(paths);
    if (probe.state === "running") {
      return probe.health;
    }
    await sleep(POLL_MS);
  }
  return undefined;
}

type Lock =
  | { readonly held: true; release: () => void }
  | { readonly held: false; readonly stale: boolean };

function takeLock(paths: DaemonPaths, now: number): Lock {
  try {
    const fd = openSync(paths.lockFile, "wx", FILE_MODE);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now }));
    closeSync(fd);
    return {
      held: true,
      release: () => {
        try {
          unlinkSync(paths.lockFile);
        } catch {
          // Already gone.
        }
      },
    };
  } catch {
    let stale = false;
    try {
      stale = now - statSync(paths.lockFile).mtimeMs > STALE_LOCK_MS;
    } catch {
      // Raced away between the open and the stat: try again next round.
    }
    return { held: false, stale };
  }
}

function readIfExists(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function startProcess(
  options: EnsureDaemonOptions,
  paths: DaemonPaths,
): number | undefined {
  const args = [
    options.entry ?? daemonEntry(),
    "--socket",
    paths.socketPath,
    "--home",
    paths.home,
  ];
  if (existsSync(paths.policyFile)) {
    args.push("--policy", paths.policyFile);
  }
  // RFX-123: a remote provider is passed only with the consent that covers
  // it, and the consent file goes along so that the daemon checks it too.
  const consent = parseConsentRecord(readIfExists(consentPath(paths.home)));
  const { config } = withConsent(
    parseConfig(readIfExists(configPath(paths.home))),
    consent,
  );
  args.push(
    ...daemonArguments(
      config,
      consent === undefined ? undefined : consentPath(paths.home),
    ),
  );
  args.push(...(options.extraArguments ?? []));

  const log = openSync(paths.logFile, "a", FILE_MODE);
  try {
    const child = spawn(options.nodePath, args, {
      detached: true,
      stdio: ["ignore", log, log],
      cwd: paths.home,
      env: { ...process.env, REFLEX_HOME: paths.home },
    });
    child.on("error", () => {
      // Reported through the missing answer, not through an exception.
    });
    child.unref();
    return child.pid;
  } catch {
    return undefined;
  } finally {
    closeSync(log);
  }
}

function writeState(paths: DaemonPaths, state: DaemonState): void {
  try {
    writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, {
      mode: FILE_MODE,
    });
  } catch {
    // Advisory only.
  }
}

async function prepareRunDirectory(paths: DaemonPaths): Promise<void> {
  await mkdir(paths.runDir, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(paths.runDir, DIRECTORY_MODE).catch(() => undefined);
}

/**
 * Finds the daemon or starts it, once, however many callers arrive at the
 * same moment; replaces one of another version first. Never throws.
 */
export async function ensureDaemon(
  options: EnsureDaemonOptions,
): Promise<EnsureDaemonResult> {
  const paths = daemonPaths(options.home);
  const deadlineAt =
    Date.now() + (options.deadlineMs ?? DEFAULT_START_DEADLINE_MS);
  const expected = options.expectedVersion ?? shippedDaemonVersion();
  let replaced = false;

  try {
    await prepareRunDirectory(paths);
    const probe = await probeDaemon(paths);
    if (probe.state === "running") {
      if (probe.health.version === expected) {
        return { ok: true, health: probe.health, started: false, replaced };
      }
      // Another version answers. Stop it gracefully (the gateway finishes
      // what is in flight before it exits) and start the shipped one.
      await stopDaemon(options.home, {
        graceMs: Math.max(500, deadlineAt - Date.now() - 500),
      });
      replaced = true;
    }

    while (Date.now() < deadlineAt) {
      const lock = takeLock(paths, Date.now());
      if (lock.held) {
        try {
          const again = await probeDaemon(paths);
          if (again.state === "running" && again.health.version === expected) {
            return { ok: true, health: again.health, started: false, replaced };
          }
          const pid = startProcess(options, paths);
          if (pid === undefined) {
            return { ok: false, reason: "start-failed" };
          }
          const health = await waitForAnswer(paths, deadlineAt);
          if (health === undefined) {
            return { ok: false, reason: "no-answer" };
          }
          writeState(paths, {
            version: 1,
            pid: health.pid ?? pid,
            daemonVersion: health.version,
            startedAt: new Date().toISOString(),
            startedBy: options.startedBy ?? "rfx",
          });
          return { ok: true, health, started: true, replaced };
        } finally {
          lock.release();
        }
      }
      if (lock.stale) {
        try {
          unlinkSync(paths.lockFile);
        } catch {
          // Someone else removed it first.
        }
        continue;
      }
      // Another caller is starting it: wait for the answer.
      const health = await waitForAnswer(
        paths,
        Math.min(deadlineAt, Date.now() + 200),
      );
      if (health !== undefined) {
        return { ok: true, health, started: false, replaced };
      }
    }
    return { ok: false, reason: "lock-held" };
  } catch {
    return { ok: false, reason: "start-failed" };
  }
}

export interface StopDaemonOptions {
  readonly graceMs?: number;
}

export interface StopDaemonResult {
  readonly wasRunning: boolean;
  /** True when it exited within the grace period; false when it was killed. */
  readonly gracefully: boolean;
}

/**
 * Stops the daemon that answers on the socket, and only that one: the PID
 * signalled is the one it reports. A stale socket or state file with nobody
 * behind it is simply removed. Never throws.
 */
export async function stopDaemon(
  home: string,
  options: StopDaemonOptions = {},
): Promise<StopDaemonResult> {
  const paths = daemonPaths(home);
  const graceMs = options.graceMs ?? DEFAULT_STOP_GRACE_MS;
  const probe = await probeDaemon(paths, HUMAN_PROBE_TIMEOUT_MS);
  const remembered = readDaemonState(paths);
  const cleanup = async (): Promise<void> => {
    await unlink(paths.socketPath).catch(() => undefined);
    await unlink(paths.stateFile).catch(() => undefined);
  };
  if (probe.state === "down") {
    await cleanup();
    return { wasRunning: false, gracefully: true };
  }
  const pid = probe.health.pid ?? remembered?.pid;
  if (pid === undefined) {
    await cleanup();
    return { wasRunning: true, gracefully: false };
  }
  const signal = (name: NodeJS.Signals): boolean => {
    try {
      process.kill(pid, name);
      return true;
    } catch {
      return false;
    }
  };
  signal("SIGTERM");
  const deadlineAt = Date.now() + graceMs;
  while (Date.now() < deadlineAt) {
    if ((await probeDaemon(paths)).state === "down") {
      await cleanup();
      return { wasRunning: true, gracefully: true };
    }
    await sleep(POLL_MS);
  }
  signal("SIGKILL");
  await sleep(POLL_MS);
  await cleanup();
  return { wasRunning: true, gracefully: false };
}

export interface DaemonStatus {
  readonly running: boolean;
  readonly socketPath: string;
  readonly version?: string;
  readonly pid?: number;
  readonly uptimeMs?: number;
  readonly startedAt?: string;
}

/** What `rfx status` shows. Reads the socket, then the advisory state. */
export async function daemonStatus(home: string): Promise<DaemonStatus> {
  const paths = daemonPaths(home);
  const probe = await probeDaemon(paths, HUMAN_PROBE_TIMEOUT_MS);
  if (probe.state === "down") {
    return { running: false, socketPath: paths.socketPath };
  }
  const remembered = readDaemonState(paths);
  return {
    running: true,
    socketPath: paths.socketPath,
    version: probe.health.version,
    ...(probe.health.pid === undefined ? {} : { pid: probe.health.pid }),
    uptimeMs: probe.health.uptimeMs,
    ...(remembered === undefined ? {} : { startedAt: remembered.startedAt }),
  };
}
