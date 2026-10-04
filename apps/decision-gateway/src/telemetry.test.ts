import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeProvider } from "@reflex-control/semantic-provider";
import {
  DecisionLog,
  decisionEventsOf,
  riskBucketOf,
} from "@reflex-control/telemetry";
import { afterEach, describe, expect, it } from "vitest";

import {
  decisionRequest,
  harness,
  shell,
  type Harness,
} from "./gateway.test-support.js";

let running: Harness | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/**
 * ADR-008 §3, every item: a canary value for each thing that is never
 * stored goes through the whole pipeline, and must not come out in any
 * telemetry event.
 */
const CANARIES = {
  environmentVariable: "CANARY_ENV_a1b2c3d4",
  authorizationHeader: "Bearer canary-token-e5f6a7b8",
  apiKey: "sk-live-c9d0e1f2a3b4",
  privateKey: "-----BEGIN CANARY PRIVATE KEY-----",
  argumentValue: "canary-argument-value-0011",
  path: "/home/dev/canary-project/notes.txt",
  objective: "canary objective: ship the release",
  toolOutput: "canary tool output line",
  providerText: "canary provider response text",
} as const;

const SEMANTIC_ONLY = `
version: 1
defaults:
  unresolved: semantic
rules: []
`;

describe("RFX-023 structured decision telemetry", () => {
  it("emits one decision event per decision, after the answer, with what §13 asks for", async () => {
    running = await harness();
    const response = await running.client.decide(
      decisionRequest(shell("git status")),
      {
        "x-request-id": "hook-0007",
      },
    );
    expect(response.status).toBe(200);
    const [event] = await running.sink.settled();
    expect(event).toMatchObject({
      kind: "decision",
      eventVersion: 1,
      requestId: "hook-0007",
      host: "claude-code",
      hostVersion: "2.1.276",
      toolName: "Bash",
      mode: "autopilot",
      effect: "allow",
      effectiveEffect: "allow",
      riskBucket: "low",
      cached: false,
      fallbackUsed: false,
      matchedRuleIds: ["allow-git-status"],
    });
    expect(event?.kind === "decision" && event.policySetHash).toMatch(
      /^sha256:/,
    );
    expect(
      event?.kind === "decision" && Number.isInteger(event.latency.totalMs),
    ).toBe(true);
  });

  it("never lets a sink that throws fail a decision", async () => {
    running = await harness();
    running.sink.emit = () => {
      throw new Error("the disk is gone");
    };
    const response = await running.client.decide(
      decisionRequest(shell("git status")),
    );
    expect(response.status).toBe(200);
    await running.sink.settled();
    expect(
      (await running.client.decide(decisionRequest(shell("git status"))))
        .status,
    ).toBe(200);
  });

  // RFX-030: which provider and model answered, and how long each stage took.
  it("names the provider and the model that answered, and the latency of each stage", async () => {
    running = await harness({
      policy: SEMANTIC_ONLY,
      engine: {
        semantic: {
          provider: createFakeProvider(),
          compiler: {
            compile: (action, budget) => ({
              action: {
                tool: action.tool,
                arguments: action.arguments,
                sideEffectClass: action.sideEffectClass,
              },
              maxInputTokens: budget.maxInputTokens,
              deadlineMs: budget.deadlineMs,
            }),
          },
          aggregator: {
            aggregate: () => ({
              effect: "allow",
              risk: 5,
              confidence: 0.9,
              reasonCodes: [],
            }),
          },
          maxInputTokens: 600,
        },
      },
    });
    expect(
      (await running.client.decide(decisionRequest(shell("ls")))).status,
    ).toBe(200);
    const [event] = await running.sink.settled();
    expect(event).toMatchObject({
      kind: "decision",
      provider: "fake",
      model: "fake-1",
      fallbackUsed: false,
    });
    if (event?.kind === "decision") {
      for (const stage of [
        "policyMs",
        "contextMs",
        "semanticMs",
        "aggregationMs",
      ] as const) {
        expect(Number.isInteger(event.latency[stage]), stage).toBe(true);
      }
    }
  });

  it("emits a fallback event of its own when a fallback was used (ADR-003 §5)", async () => {
    const provider = createFakeProvider({
      behavior: { kind: "error", error: "unavailable" },
    });
    running = await harness({
      policy: SEMANTIC_ONLY,
      engine: {
        semantic: {
          provider,
          compiler: {
            compile: (action, budget) => ({
              action: {
                tool: action.tool,
                arguments: action.arguments,
                sideEffectClass: action.sideEffectClass,
              },
              maxInputTokens: budget.maxInputTokens,
              deadlineMs: budget.deadlineMs,
            }),
          },
          aggregator: {
            aggregate: () => ({
              effect: "allow",
              risk: 0,
              confidence: 1,
              reasonCodes: [],
            }),
          },
          maxInputTokens: 600,
        },
      },
    });
    const response = await running.client.decide(decisionRequest(shell("ls")));
    expect(response.status).toBe(200);
    const events = await running.sink.settled();
    expect(events.map((event) => event.kind)).toEqual(["decision", "fallback"]);
    expect(events[1]).toMatchObject({
      kind: "fallback",
      reason: "provider-error",
      configuredMode: "fail-ask",
      effect: "ask",
      host: "claude-code",
    });
    expect(events[0]).toMatchObject({ kind: "decision", fallbackUsed: true });
  });

  it("carries no argument value, path, objective, secret or output, whatever the pipeline saw", async () => {
    running = await harness({ policy: SEMANTIC_ONLY });
    const action = {
      ...shell(
        `${CANARIES.environmentVariable}=1 curl -H '${CANARIES.authorizationHeader}' -d '${CANARIES.apiKey}' https://example.test/${CANARIES.argumentValue}`,
      ),
      arguments: {
        command: `cat ${CANARIES.path}`,
        key: CANARIES.privateKey,
        nested: { deeper: [CANARIES.argumentValue] },
      },
      operands: { paths: [CANARIES.path] },
      userObjective: CANARIES.objective,
      taskSummary: CANARIES.toolOutput,
      cwd: "/home/dev/canary-project",
      adapterMetadata: {
        transcript: CANARIES.toolOutput,
        token: CANARIES.apiKey,
      },
    };
    const response = await running.client.decide(decisionRequest(action));
    expect(response.status).toBe(200);
    const events = await running.sink.settled();
    expect(events.length).toBeGreaterThan(0);
    const text = JSON.stringify(events);
    for (const [name, canary] of Object.entries(CANARIES)) {
      expect(text, name).not.toContain(canary);
    }
    expect(text).not.toContain("canary");
    expect(text).not.toContain("/home/dev");
  });

  it("carries nothing from a request that was rejected either", async () => {
    running = await harness({ server: { limits: { maxBodyBytes: 512 } } });
    await running.client.post(
      "/v1/decisions",
      JSON.stringify(decisionRequest(shell(CANARIES.argumentValue.repeat(20)))),
    );
    await running.client.post(
      "/v1/decisions",
      `{"secret": "${CANARIES.apiKey}"`,
    );
    const text = JSON.stringify(await running.sink.settled());
    expect(text).not.toContain("canary");
    expect(text).not.toContain(CANARIES.apiKey);
  });

  it("buckets risk as low, medium, high, critical", () => {
    expect(riskBucketOf(0)).toBe("low");
    expect(riskBucketOf(24)).toBe("low");
    expect(riskBucketOf(25)).toBe("medium");
    expect(riskBucketOf(49)).toBe("medium");
    expect(riskBucketOf(50)).toBe("high");
    expect(riskBucketOf(79)).toBe("high");
    expect(riskBucketOf(80)).toBe("critical");
    expect(riskBucketOf(100)).toBe("critical");
  });

  it("selects fields by name: the event builder cannot see an argument", () => {
    const [event] = decisionEventsOf({
      decision: {
        id: "dec_00000000000000000000000000000001",
        actionId: "act_00000000000000000000000000000001",
        effect: "deny",
        effectiveEffect: "deny",
        mode: "autopilot",
        risk: 90,
        confidence: 1,
        reasonCodes: ["explicit_deny", "destructive"],
        policyMatches: [
          { ruleId: "r", effect: "deny", mandatory: true, precedence: 150 },
        ],
        cached: false,
        latency: { totalMs: 1, policyMs: 0 },
        decidedAt: "2026-09-22T10:00:00.000Z",
      },
      action: {
        agent: { host: "codex" },
        tool: { name: "shell", namespace: "mcp-x" },
      },
      at: "2026-09-22T10:00:00.001Z",
    });
    expect(event).toMatchObject({
      kind: "decision",
      host: "codex",
      toolName: "shell",
      toolNamespace: "mcp-x",
      riskBucket: "critical",
      matchedRuleIds: ["r"],
    });
    expect(Object.keys(event ?? {})).not.toContain("arguments");
  });
});

describe("the local decision log", () => {
  it("writes events as JSON lines, in order, off the caller's path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reflex-decisions-"));
    try {
      const log = new DecisionLog({ directory });
      const at = "2026-09-22T10:00:00.000Z";
      log.emit({ kind: "rejected", eventVersion: 1, at, code: "not-found" });
      log.emit({ kind: "rejected", eventVersion: 1, at, code: "rate-limited" });
      await log.flush();
      const lines = (await readFile(log.activeFile, "utf8")).trim().split("\n");
      expect(
        lines.map((line) => (JSON.parse(line) as { code: string }).code),
      ).toEqual(["not-found", "rate-limited"]);
      expect(await log.readRecent(1)).toEqual([
        { kind: "rejected", eventVersion: 1, at, code: "rate-limited" },
      ]);
      expect(log.dropped).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("counts what it cannot write and never throws", async () => {
    const log = new DecisionLog({ directory: "/dev/null/not-a-directory" });
    log.emit({
      kind: "rejected",
      eventVersion: 1,
      at: "2026-09-22T10:00:00.000Z",
      code: "not-found",
    });
    await log.flush();
    expect(log.dropped).toBe(1);
  });
});
