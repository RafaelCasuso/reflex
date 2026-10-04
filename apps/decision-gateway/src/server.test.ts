import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  parseReflexDecision,
  type ReflexDecision,
} from "@reflex-control/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  decisionRequest,
  harness,
  shell,
  type Harness,
} from "./gateway.test-support.js";

const ACT_2 = "act_00000000000000000000000000000002";
const ACT_3 = "act_00000000000000000000000000000003";

let running: Harness | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(...args: Parameters<typeof harness>): Promise<Harness> {
  running = await harness(...args);
  return running;
}

function decisionOf(json: unknown): ReflexDecision {
  const parsed = parseReflexDecision(json);
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.issues));
  }
  return parsed.value;
}

describe("RFX-021 POST /v1/decisions", () => {
  it("answers a valid request with a canonical decision and a correlation id", async () => {
    const { client } = await start();
    const response = await client.decide(decisionRequest(shell("git status")), {
      "x-request-id": "hook-0001",
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["x-request-id"]).toBe("hook-0001");
    const decision = decisionOf(response.json);
    expect(response.headers["x-reflex-decision-id"]).toBe(decision.id);
    expect(decision).toMatchObject({
      effect: "allow",
      effectiveEffect: "allow",
      mode: "autopilot",
      actionId: "act_00000000000000000000000000000001",
      cached: false,
    });
  });

  it("makes up a correlation id when the client sends none or an unusable one", async () => {
    const { client } = await start();
    const none = await client.decide(decisionRequest(shell("git status")));
    expect(none.headers["x-request-id"]).toMatch(/^req_[0-9a-f]{16}$/);
    const hostile = await client.decide(decisionRequest(shell("git status")), {
      "x-request-id": "x".repeat(200),
    });
    expect(hostile.headers["x-request-id"]).toMatch(/^req_[0-9a-f]{16}$/);
  });

  it("decides the same way the engine does, mode included", async () => {
    const { client } = await start();
    const observe = decisionOf(
      (
        await client.decide(
          decisionRequest(shell("rm -rf build", ACT_2), { mode: "observe" }),
        )
      ).json,
    );
    expect(observe).toMatchObject({
      effect: "ask",
      effectiveEffect: "ask",
      mode: "observe",
    });
    const autopilot = decisionOf(
      (await client.decide(decisionRequest(shell("rm -rf build", ACT_3)))).json,
    );
    expect(autopilot).toMatchObject({ effect: "ask", effectiveEffect: "ask" });
  });

  it("reports the health of the daemon", async () => {
    const { client } = await start({
      server: { health: () => ({ version: "test" }) },
    });
    const response = await client.get("/v1/health");
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ status: "ok", version: "test" });
    expect(
      (response.json as { uptimeMs: number }).uptimeMs,
    ).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ["an unknown route", "GET", "/v1/nothing", 404, "not-found"],
    ["a GET on decisions", "GET", "/v1/decisions", 405, "method-not-allowed"],
    ["a POST on health", "POST", "/v1/health", 405, "method-not-allowed"],
  ] as const)(
    "rejects %s with a typed problem",
    async (_label, method, path, status, code) => {
      const { client } = await start();
      const response =
        method === "GET"
          ? await client.get(path)
          : await client.post(path, "{}");
      expect(response.status).toBe(status);
      expect(response.json).toMatchObject({ error: { code } });
      expect((response.json as { requestId: string }).requestId).toMatch(
        /^req_/,
      );
    },
  );

  describe("strict validation at the boundary (ADR-009)", () => {
    it("rejects a body that is not JSON", async () => {
      const { client } = await start();
      const response = await client.post("/v1/decisions", "{not json");
      expect(response.status).toBe(400);
      expect(response.json).toMatchObject({
        error: { code: "invalid-request" },
      });
    });

    it("rejects a request that does not validate, naming the paths and never a value", async () => {
      const { client } = await start();
      const secret = "sk-live-0123456789ab";
      const response = await client.post(
        "/v1/decisions",
        JSON.stringify({
          action: {
            ...shell(`curl -H 'Authorization: ${secret}'`),
            sideEffectClass: "harmless",
          },
          mode: "autopilot",
          failureMode: "fail-ask",
          preApproved: true,
        }),
      );
      expect(response.status).toBe(400);
      const body = response.json as {
        error: { code: string; issues: { path: string }[] };
      };
      expect(body.error.code).toBe("invalid-request");
      const paths = body.error.issues.map((issue) => issue.path);
      expect(paths).toContain("action.sideEffectClass");
      expect(paths.some((path) => path === "" || path === "preApproved")).toBe(
        true,
      );
      expect(response.text).not.toContain(secret);
      expect(response.text).not.toContain("harmless");
    });

    it("rejects a body that is not application/json without reading it", async () => {
      const { client } = await start();
      const response = await client.post(
        "/v1/decisions",
        JSON.stringify(decisionRequest(shell("git status"))),
        { "content-type": "text/plain" },
      );
      expect(response.status).toBe(415);
    });

    // Adversarial: a decision-shaped body is not a decision.
    it("does not accept a decision in place of a request", async () => {
      const { client } = await start();
      const first = decisionOf(
        (await client.decide(decisionRequest(shell("git status")))).json,
      );
      const response = await client.post(
        "/v1/decisions",
        JSON.stringify(first),
      );
      expect(response.status).toBe(400);
    });
  });

  it("listens on a socket only the user can reach, in a directory only the user can enter", async () => {
    const { target } = await start();
    if (target.kind !== "socket") {
      throw new Error("expected a socket");
    }
    expect((await stat(target.path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(target.path))).mode & 0o777).toBe(0o700);
  });

  it("refuses to listen on a network interface without an authenticator", async () => {
    await expect(
      start({ listen: { kind: "tcp", host: "0.0.0.0", port: 0 } }),
    ).rejects.toThrow("needs-authentication");
  });

  it("serves the same handler on loopback TCP", async () => {
    const { client, target } = await start({
      listen: { kind: "tcp", host: "127.0.0.1", port: 0 },
    });
    expect(target.kind === "tcp" && target.port > 0).toBe(true);
    const response = await client.decide(decisionRequest(shell("git status")));
    expect(response.status).toBe(200);
  });

  it("refuses to start twice on the same socket, and replaces a stale one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reflex-gw-stale-"));
    const path = join(directory, "reflex.sock");
    try {
      const first = await harness({ listen: { kind: "socket", path } });
      await expect(
        harness({ listen: { kind: "socket", path } }),
      ).rejects.toThrow("already-running");
      await first.close();

      // A daemon that died without cleaning up leaves the file behind.
      await writeFile(path, "");
      running = await harness({ listen: { kind: "socket", path } });
      expect((await running.client.get("/v1/health")).status).toBe(200);
    } finally {
      await running?.close();
      running = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
