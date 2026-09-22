import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ALLOW_GIT_STATUS,
  decisionRequest,
  shell,
} from "./gateway.test-support.js";

/**
 * The daemon as a process: the real entry point, started the way the CLI
 * will start it (RFX-138), talked to over its socket, stopped with a signal.
 */
const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

interface Daemon {
  readonly child: ChildProcess;
  readonly socketPath: string;
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
}

let directory: string;
let daemon: Daemon | undefined;

beforeAll(() => {
  if (!existsSync(MAIN)) {
    throw new Error(`${MAIN} does not exist. Run "pnpm build" first.`);
  }
});

afterEach(async () => {
  if (daemon?.child.exitCode === null) {
    daemon.child.kill("SIGKILL");
    await daemon.exited;
  }
  daemon = undefined;
  await rm(directory, { recursive: true, force: true });
});

async function start(args: readonly string[]): Promise<Daemon> {
  directory = await mkdtemp(join(tmpdir(), "reflex-daemon-"));
  const socketPath = join(directory, "reflex.sock");
  const child = spawn(
    process.execPath,
    [MAIN, "--socket", socketPath, "--home", directory, ...args],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
  });
  const listening = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("\n")) {
        resolve(stdout);
      }
    });
    child.once("exit", () => {
      reject(new Error(`exited before listening: ${stderr}`));
    });
  });
  expect(JSON.parse(listening.trim())).toMatchObject({
    listening: { kind: "socket", path: socketPath },
  });
  daemon = { child, socketPath, stderr: () => stderr, exited };
  return daemon;
}

function call(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  body?: string,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        method,
        path,
        headers: { "content-type": "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

describe("the decision daemon as a process", () => {
  it("starts, serves a policy from a file, and stops cleanly on SIGTERM", async () => {
    const home = await mkdtemp(join(tmpdir(), "reflex-daemon-policy-"));
    const policyFile = join(home, "policy.yaml");
    await writeFile(policyFile, ALLOW_GIT_STATUS);
    try {
      const running = await start(["--policy", policyFile]);

      const health = await call(running.socketPath, "GET", "/v1/health");
      expect(health.status).toBe(200);
      expect(health.json).toMatchObject({ status: "ok", policyProblems: 0 });
      expect((health.json as { policySetHash: string }).policySetHash).toMatch(
        /^sha256:/,
      );

      const decided = await call(
        running.socketPath,
        "POST",
        "/v1/decisions",
        JSON.stringify(decisionRequest(shell("git status"))),
      );
      expect(decided.status).toBe(200);
      expect(decided.json).toMatchObject({ effect: "allow" });

      running.child.kill("SIGTERM");
      expect(await running.exited).toBe(0);
      await expect(stat(running.socketPath)).rejects.toThrow();
      expect(running.stderr()).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("starts with REFLEX's own rules only when the policy does not load, and says so", async () => {
    const running = await start(["--policy", join(tmpdir(), "missing.yaml")]);
    const health = await call(running.socketPath, "GET", "/v1/health");
    expect(health.json).toMatchObject({ status: "ok", policyLoadedAt: null });
    expect(running.stderr()).toContain("REFLEX's own rules only");
    const decided = await call(
      running.socketPath,
      "POST",
      "/v1/decisions",
      JSON.stringify(decisionRequest(shell("git status"))),
    );
    // Nothing allows it and nothing assesses it: ask.
    expect(decided.json).toMatchObject({ effect: "ask" });
    running.child.kill("SIGTERM");
    expect(await running.exited).toBe(0);
  });

  it("exits 2 on a command line it does not understand", async () => {
    directory = await mkdtemp(join(tmpdir(), "reflex-daemon-args-"));
    const child = spawn(process.execPath, [MAIN, "--verbose"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
    });
    expect(code).toBe(2);
    expect(stderr).toContain("unknown argument: --verbose");
  });
});
