import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTRACT_VERSION, parseDecisionRecord } from "@reflex/contracts";
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

async function start(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<Daemon> {
  directory = await mkdtemp(join(tmpdir(), "reflex-daemon-"));
  const socketPath = join(directory, "reflex.sock");
  const child = spawn(
    process.execPath,
    [MAIN, "--socket", socketPath, "--home", directory, ...args],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } },
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
      // RFX-138: the lifecycle replaces a daemon whose version is not the
      // shipped manifest's; the binary must report exactly that version, or
      // every hook call would restart it.
      const manifest = JSON.parse(
        readFileSync(
          fileURLToPath(new URL("../package.json", import.meta.url)),
          "utf8",
        ),
      ) as { version: string };
      expect(health.json).toMatchObject({
        version: manifest.version,
        pid: running.child.pid,
      });
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

  it("exits 2 when the provider it was asked for cannot be built, and says why", async () => {
    directory = await mkdtemp(join(tmpdir(), "reflex-daemon-provider-"));
    const child = spawn(
      process.execPath,
      [
        MAIN,
        "--socket",
        join(directory, "r.sock"),
        "--home",
        directory,
        "--semantic-provider",
        "jev",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TYPESAFE_API_KEY: "" },
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
    });
    expect(code).toBe(2);
    expect(stderr).toContain("needs an API key in TYPESAFE_API_KEY");
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

const SEMANTIC_BY_DEFAULT = `
version: 1
defaults:
  unresolved: semantic
rules:
  - id: allow-git-status
    name: Allow git status
    effect: allow
    conditions:
      - { field: command.name, operator: equals, value: git }
      - { field: command.args, operator: equals, value: status }
`;

describe("RFX-141 the daemon with a semantic provider", () => {
  it("names the provider in health and assesses what policy leaves open, with the provider and model recorded", async () => {
    const home = await mkdtemp(join(tmpdir(), "reflex-daemon-semantic-"));
    const policyFile = join(home, "policy.yaml");
    await writeFile(policyFile, SEMANTIC_BY_DEFAULT);
    try {
      const running = await start([
        "--policy",
        policyFile,
        "--semantic-provider",
        "fake",
      ]);
      const health = await call(running.socketPath, "GET", "/v1/health");
      expect(health.json).toMatchObject({
        status: "ok",
        semanticProvider: { id: "fake", name: "fake", model: "fake-1" },
      });
      // Resolved by a rule: no provider is asked (ADR-002 §1).
      const resolved = await call(
        running.socketPath,
        "POST",
        "/v1/decisions",
        JSON.stringify(decisionRequest(shell("git status"))),
      );
      expect(resolved.json).toMatchObject({ effect: "allow" });
      expect(resolved.json).not.toHaveProperty("semanticAssessment");
      // Left open by policy: the provider assesses, and the decision says
      // which one, pinned.
      const assessed = await call(
        running.socketPath,
        "POST",
        "/v1/decisions",
        JSON.stringify(
          decisionRequest(
            shell("cat README.md", "act_00000000000000000000000000000002"),
          ),
        ),
      );
      expect(assessed.status).toBe(200);
      expect(assessed.json).toMatchObject({
        effect: "allow",
        semanticAssessment: { provider: "fake", model: "fake-1" },
      });
      expect(assessed.json).not.toHaveProperty("fallback");
      running.child.kill("SIGTERM");
      expect(await running.exited).toBe(0);
      expect(running.stderr()).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("with no provider, decides as before: health says none and an open action asks", async () => {
    const home = await mkdtemp(join(tmpdir(), "reflex-daemon-none-"));
    const policyFile = join(home, "policy.yaml");
    await writeFile(policyFile, SEMANTIC_BY_DEFAULT);
    try {
      const running = await start(["--policy", policyFile]);
      const health = await call(running.socketPath, "GET", "/v1/health");
      expect(health.json).toMatchObject({ semanticProvider: { id: "none" } });
      const decided = await call(
        running.socketPath,
        "POST",
        "/v1/decisions",
        JSON.stringify(decisionRequest(shell("cat README.md"))),
      );
      expect(decided.json).toMatchObject({ effect: "ask" });
      expect(decided.json).not.toHaveProperty("semanticAssessment");
      running.child.kill("SIGTERM");
      expect(await running.exited).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("runs a shadow behind the primary: health names it, the decision does not change, telemetry records it", async () => {
    const home = await mkdtemp(join(tmpdir(), "reflex-daemon-shadow-"));
    const policyFile = join(home, "policy.yaml");
    await writeFile(policyFile, SEMANTIC_BY_DEFAULT);
    try {
      const running = await start([
        "--policy",
        policyFile,
        "--semantic-provider",
        "fake",
        "--shadow-provider",
        "fake",
        "--shadow-deadline",
        "500",
      ]);
      const health = await call(running.socketPath, "GET", "/v1/health");
      expect(health.json).toMatchObject({
        semanticProvider: { id: "fake" },
        shadowProviders: [
          { id: "fake", name: "fake", model: "fake-1", sample: "unresolved" },
        ],
      });
      const decided = await call(
        running.socketPath,
        "POST",
        "/v1/decisions",
        JSON.stringify(decisionRequest(shell("cat README.md"))),
      );
      expect(decided.json).toMatchObject({
        effect: "allow",
        semanticAssessment: { provider: "fake" },
      });
      // The decision carries nothing of the shadow (ADR-016 §3).
      expect(JSON.stringify(decided.json)).not.toContain("shadow");
      const telemetry = join(directory, "decisions", "decisions.jsonl");
      let lines: string[] = [];
      for (
        let attempt = 0;
        attempt < 50 && !lines.some((line) => line.includes('"shadow"'));
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        lines = existsSync(telemetry)
          ? (await readFile(telemetry, "utf8")).split("\n").filter(Boolean)
          : [];
      }
      const shadowEvent = lines
        .map((line) => JSON.parse(line) as { kind: string })
        .find((event) => event.kind === "shadow");
      expect(shadowEvent).toMatchObject({
        kind: "shadow",
        provider: "fake",
        model: "fake-1",
        sampledOn: "unresolved",
        outcome: "assessed",
      });
      running.child.kill("SIGTERM");
      expect(await running.exited).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("writes a decision record per decision, after the answer, with the redacted request and every evaluation, and never a secret", async () => {
    const home = await mkdtemp(join(tmpdir(), "reflex-daemon-records-"));
    const policyFile = join(home, "policy.yaml");
    await writeFile(policyFile, SEMANTIC_BY_DEFAULT);
    // A GitHub-token-shaped value, assembled here so that no secret-shaped
    // literal exists in the repository.
    const token =
      ["ghp", "_"].join("") + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
    try {
      const running = await start([
        "--policy",
        policyFile,
        "--semantic-provider",
        "fake",
        "--shadow-provider",
        "fake",
      ]);
      const assessed = await call(
        running.socketPath,
        "POST",
        "/v1/decisions",
        JSON.stringify(
          decisionRequest(
            shell(
              `curl -H 'Authorization: Bearer ${token}' https://api.example.test/x`,
            ),
          ),
        ),
      );
      expect(assessed.status).toBe(200);
      const resolved = await call(
        running.socketPath,
        "POST",
        "/v1/decisions",
        JSON.stringify(
          decisionRequest(
            shell("git status", "act_00000000000000000000000000000002"),
          ),
        ),
      );
      expect(resolved.json).toMatchObject({ effect: "allow" });
      running.child.kill("SIGTERM");
      expect(await running.exited).toBe(0);
      const file = join(directory, "records", "records.jsonl");
      const text = await readFile(file, "utf8");
      expect(text).not.toContain(token);
      expect(text).toContain("[REDACTED:");
      const records = text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
      expect(records).toHaveLength(2);
      const parsed = records.map((record) => parseDecisionRecord(record));
      expect(parsed.every((result) => result.ok)).toBe(true);
      const [first, second] = parsed.map((result) =>
        result.ok ? result.value : undefined,
      );
      expect(first).toMatchObject({
        actionId: "act_00000000000000000000000000000001",
        contractVersion: `${String(CONTRACT_VERSION.major)}.${String(CONTRACT_VERSION.minor)}`,
        decision: { effect: (assessed.json as { effect: string }).effect },
        labels: [],
      });
      expect(first?.request?.action.tool).toEqual({ name: "Bash" });
      expect(first?.evaluations.map((entry) => entry.role)).toEqual([
        "primary",
        "shadow",
      ]);
      expect(first?.evaluations[0]).toMatchObject({
        provider: "fake",
        model: "fake-1",
        assessment: { provider: "fake" },
      });
      expect(second).toMatchObject({
        actionId: "act_00000000000000000000000000000002",
        evaluations: [],
        labels: [
          { kind: "effect", value: "allow", source: "deterministic_rule" },
        ],
      });
      expect(second).not.toHaveProperty("request");
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("assesses with a local inference server on the loopback, named and pinned", async () => {
    const home = await mkdtemp(join(tmpdir(), "reflex-daemon-local-"));
    const policyFile = join(home, "policy.yaml");
    await writeFile(policyFile, SEMANTIC_BY_DEFAULT);
    const signal = (value: number) => ({ value, confidence: 0.7 });
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            objectiveAlignment: signal(67),
            destructiveRisk: signal(0),
            reversibility: signal(100),
            externalSideEffect: { value: false, confidence: 0.7 },
            privilegeEscalation: signal(0),
            secretAccess: signal(0),
            sensitiveDataExposure: signal(0),
            financialConsequence: signal(0),
            productionMutation: signal(0),
            unusualScope: signal(0),
            untrustedInput: signal(0),
            provider: "fake-inference-server",
            model: "laya-1.0.0",
            latencyMs: 2,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    try {
      const running = await start([
        "--policy",
        policyFile,
        "--semantic-provider",
        "local",
        "--semantic-model",
        "laya-1.0.0",
        "--semantic-endpoint",
        `http://127.0.0.1:${String(port)}/v1/assess`,
      ]);
      const health = await call(running.socketPath, "GET", "/v1/health");
      expect(health.json).toMatchObject({
        semanticProvider: { id: "local", name: "local", model: "laya-1.0.0" },
      });
      const decided = await call(
        running.socketPath,
        "POST",
        "/v1/decisions",
        JSON.stringify(decisionRequest(shell("cat README.md"))),
      );
      expect(decided.json).toMatchObject({
        effect: "allow",
        semanticAssessment: { provider: "local", model: "laya-1.0.0" },
      });
      running.child.kill("SIGTERM");
      expect(await running.exited).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("exits 2 when asked to sample everything with a shadow that is not local", async () => {
    directory = await mkdtemp(join(tmpdir(), "reflex-daemon-shadow-all-"));
    const child = spawn(
      process.execPath,
      [
        MAIN,
        "--socket",
        join(directory, "r.sock"),
        "--home",
        directory,
        "--semantic-provider",
        "fake",
        "--shadow-provider",
        "fake",
        "--shadow-sample",
        "all",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
    });
    expect(code).toBe(2);
    expect(stderr).toContain("local shadows only");
  });

  // Adversarial: the key is given to the provider and must come out nowhere:
  // not in health, not in a decision, not on stderr, not in telemetry.
  it("never lets the provider's key out, even when the provider is unreachable", async () => {
    const home = await mkdtemp(join(tmpdir(), "reflex-daemon-key-"));
    const policyFile = join(home, "policy.yaml");
    await writeFile(policyFile, SEMANTIC_BY_DEFAULT);
    // Assembled at run time: no secret-shaped literal in the repository.
    const secret = ["canary", "jev", "key", "0a1b2c3d4e"].join("-");
    try {
      const running = await start(
        [
          "--policy",
          policyFile,
          "--semantic-provider",
          "jev",
          // Nothing listens on port 1: the provider fails fast, and the
          // decision falls back (ADR-003).
          "--semantic-endpoint",
          "http://127.0.0.1:1/v1/systemone",
        ],
        { TYPESAFE_API_KEY: secret },
      );
      const health = await call(running.socketPath, "GET", "/v1/health");
      expect(health.json).toMatchObject({
        semanticProvider: { id: "jev", name: "jev", model: "jev-1.13.0" },
      });
      expect(JSON.stringify(health.json)).not.toContain(secret);
      expect(JSON.stringify(health.json)).not.toContain("127.0.0.1:1");
      const decided = await call(
        running.socketPath,
        "POST",
        "/v1/decisions",
        JSON.stringify(decisionRequest(shell("cat README.md"))),
      );
      expect(decided.status).toBe(200);
      expect(decided.json).toMatchObject({
        effect: "ask",
        fallback: { used: true },
      });
      expect(JSON.stringify(decided.json)).not.toContain(secret);
      running.child.kill("SIGTERM");
      expect(await running.exited).toBe(0);
      expect(running.stderr()).not.toContain(secret);
      const telemetry = join(directory, "decisions", "decisions.jsonl");
      if (existsSync(telemetry)) {
        expect(await readFile(telemetry, "utf8")).not.toContain(secret);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
