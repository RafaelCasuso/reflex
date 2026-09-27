import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { requestOverSocket } from "./client.js";
import {
  daemonEntry,
  daemonPaths,
  daemonStatus,
  ensureDaemon,
  probeDaemon,
  readDaemonState,
  shippedDaemonVersion,
  stopDaemon,
} from "./lifecycle.js";

/**
 * RFX-138 — the daemon's lifecycle against the real gateway, in a
 * temporary REFLEX home: started once however many ask at once, found when
 * it answers, replaced when it is another version without losing a
 * decision in flight, stopped on uninstall, never joined when stale.
 */
let home: string;

const POLICY = `version: 1
defaults:
  unresolved: ask
rules:
  - id: allow-git-status
    name: Allow git status
    effect: allow
    conditions:
      - { field: command.name, operator: equals, value: git }
      - { field: command.args, operator: equals, value: status }
`;

const decisionBody = (command: string, id = "1") =>
  JSON.stringify({
    action: {
      id: `act_${id.padStart(32, "0")}`,
      agent: { host: "claude-code" },
      tool: { name: "Bash" },
      arguments: { command },
      operands: { command: { raw: command } },
      sideEffectClass: "unknown",
      cwd: "/work/project",
      repository: { root: "/work/project" },
      createdAt: "2026-09-27T10:00:00.000Z",
    },
    mode: "autopilot",
    failureMode: "fail-ask",
  });

const ensure = (overrides: Partial<Parameters<typeof ensureDaemon>[0]> = {}) =>
  ensureDaemon({
    home,
    nodePath: process.execPath,
    deadlineMs: 5_000,
    startedBy: "test",
    ...overrides,
  });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "reflex-daemon-life-"));
  await writeFile(join(home, "policy.yaml"), POLICY);
});

afterEach(async () => {
  await stopDaemon(home, { graceMs: 2_000 });
  await rm(home, { recursive: true, force: true });
});

describe("RFX-138 the daemon's lifecycle", () => {
  it("resolves the shipped gateway and its version", () => {
    expect(daemonEntry()).toMatch(/decision-gateway\/dist\/main\.js$/);
    expect(shippedDaemonVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("starts the daemon once, in a private directory, and finds it afterwards", async () => {
    const paths = daemonPaths(home);
    expect(await probeDaemon(paths)).toEqual({ state: "down" });
    const first = await ensure();
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.started).toBe(true);
      expect(first.replaced).toBe(false);
      expect(first.health.version).toBe(shippedDaemonVersion());
      expect(first.health.pid).toBeGreaterThan(0);
    }
    expect((await stat(paths.runDir)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.socketPath)).mode & 0o777).toBe(0o600);
    expect(readDaemonState(paths)).toMatchObject({
      version: 1,
      startedBy: "test",
      daemonVersion: shippedDaemonVersion(),
    });
    await expect(stat(paths.lockFile)).rejects.toThrow();
    const second = await ensure();
    expect(second.ok && !second.started).toBe(true);
    expect(second.ok && second.health.pid).toBe(
      first.ok ? first.health.pid : -1,
    );
    // It decides, with the policy from the home.
    const decided = await requestOverSocket({
      socketPath: paths.socketPath,
      method: "POST",
      path: "/v1/decisions",
      body: decisionBody("git status"),
      timeoutMs: 2_000,
    });
    expect(decided.ok && decided.response.status).toBe(200);
    expect(
      decided.ok && (decided.response.json as { effect: string }).effect,
    ).toBe("allow");
  });

  it("starts one daemon when several callers find it down at the same moment", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ensure()),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const pids = new Set(
      results.map((result) => (result.ok ? result.health.pid : -1)),
    );
    expect(pids.size).toBe(1);
    expect(
      results.filter((result) => result.ok && result.started),
    ).toHaveLength(1);
  });

  it("never joins a stale socket or a stale state file: it starts fresh", async () => {
    const paths = daemonPaths(home);
    await ensure();
    const { pid: firstPid } = readDaemonState(paths) ?? { pid: -1 };
    // Kill the daemon behind its back: what is left is a socket file nobody
    // answers on and a state file naming a dead process.
    process.kill(firstPid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await probeDaemon(paths)).toEqual({ state: "down" });
    const again = await ensure();
    expect(again.ok && again.started).toBe(true);
    expect(again.ok && again.health.pid).not.toBe(firstPid);
    expect(readDaemonState(paths)?.pid).not.toBe(firstPid);
  });

  it("replaces a daemon of another version without losing a decision in flight", async () => {
    const paths = daemonPaths(home);
    const first = await ensure();
    const firstPid = first.ok ? first.health.pid : -1;
    // A decision leaves just as the replacement starts.
    const inFlight = requestOverSocket({
      socketPath: paths.socketPath,
      method: "POST",
      path: "/v1/decisions",
      body: decisionBody("git status", "2"),
      timeoutMs: 4_000,
    });
    // The client expects a version the running daemon does not report: it
    // stops that daemon gracefully and starts the shipped one.
    const replaced = await ensure({ expectedVersion: "9.9.9" });
    expect(replaced.ok && replaced.replaced && replaced.started).toBe(true);
    expect(replaced.ok && replaced.health.pid).not.toBe(firstPid);
    const decided = await inFlight;
    expect(decided.ok && decided.response.status).toBe(200);
    expect(
      decided.ok && (decided.response.json as { effect: string }).effect,
    ).toBe("allow");
    // With the shipped version expected, as in production, nothing moves:
    // the shipped binary reports the shipped version (held by the gateway's
    // own test), so a replacement can never loop.
    const again = await ensure();
    expect(again.ok && !again.started && !again.replaced).toBe(true);
    expect(again.ok && again.health.pid).toBe(
      replaced.ok ? replaced.health.pid : -1,
    );
  }, 15_000);

  it("stops the daemon it can see and removes the socket; stopping twice is nothing", async () => {
    const paths = daemonPaths(home);
    await ensure();
    const stopped = await stopDaemon(home, { graceMs: 3_000 });
    expect(stopped).toEqual({ wasRunning: true, gracefully: true });
    await expect(stat(paths.socketPath)).rejects.toThrow();
    await expect(stat(paths.stateFile)).rejects.toThrow();
    expect(await stopDaemon(home)).toEqual({
      wasRunning: false,
      gracefully: true,
    });
    expect(await daemonStatus(home)).toEqual({
      running: false,
      socketPath: paths.socketPath,
    });
  });

  it("reports the running daemon's version, pid and uptime", async () => {
    await ensure();
    const status = await daemonStatus(home);
    expect(status.running).toBe(true);
    expect(status.version).toBe(shippedDaemonVersion());
    expect(status.pid).toBeGreaterThan(0);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(status.startedAt).toMatch(/^\d{4}-/);
  });

  it("gives up in time when the entry point cannot start, and says so", async () => {
    const paths = daemonPaths(home);
    const missing = await ensure({
      entry: join(home, "no-such-daemon.js"),
      deadlineMs: 1_200,
    });
    expect(missing).toEqual({ ok: false, reason: "no-answer" });
    await expect(stat(paths.lockFile)).rejects.toThrow();
    expect((await readFile(paths.logFile, "utf8")).length).toBeGreaterThan(0);
  });

  it("waits on a lock another starter holds, and takes over a stale one", async () => {
    const paths = daemonPaths(home);
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(paths.runDir, { recursive: true, mode: 0o700 }),
    );
    // A lock nobody will release, dated long ago: stale, taken over.
    await writeFile(paths.lockFile, JSON.stringify({ pid: 1, at: 0 }));
    const old = new Date(Date.now() - 60_000);
    await import("node:fs/promises").then(({ utimes }) =>
      utimes(paths.lockFile, old, old),
    );
    const taken = await ensure();
    expect(taken.ok && taken.started).toBe(true);
  });
});

describe("RFX-138 the socket client", () => {
  it("reads a typed answer, a timeout and an unreachable socket apart", async () => {
    const paths = daemonPaths(home);
    expect(
      await requestOverSocket({
        socketPath: paths.socketPath,
        method: "GET",
        path: "/v1/health",
        timeoutMs: 200,
      }),
    ).toEqual({ ok: false, reason: "unreachable" });
    await ensure();
    const health = await requestOverSocket({
      socketPath: paths.socketPath,
      method: "GET",
      path: "/v1/health",
      timeoutMs: 1_000,
    });
    expect(health.ok && health.response.status).toBe(200);
    expect(
      health.ok && (health.response.json as { status: string }).status,
    ).toBe("ok");
    const rejected = await requestOverSocket({
      socketPath: paths.socketPath,
      method: "POST",
      path: "/v1/decisions",
      body: "not json",
      timeoutMs: 1_000,
    });
    expect(rejected.ok && rejected.response.status).toBe(400);
    // A server that never answers is a timeout, not a hang.
    const silent = join(home, "silent.sock");
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => {
      server.listen(silent, resolve);
    });
    try {
      const started = Date.now();
      expect(
        await requestOverSocket({
          socketPath: silent,
          method: "GET",
          path: "/v1/health",
          timeoutMs: 150,
        }),
      ).toEqual({ ok: false, reason: "timeout" });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      server.close();
    }
  });
});
