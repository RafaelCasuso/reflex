import { parseCanonicalAction, type CanonicalAction } from "@reflex/contracts";
import { describe, expect, it } from "vitest";

import { createContextCompiler } from "./compile.js";
import { generateSecret } from "./corpus.test-support.js";
import { historyEntryOf } from "./history.js";
import { createRedactor } from "./redact.js";
import { TRUNCATION_MARK } from "./token-budget.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const redactor = createRedactor({ key: Buffer.alloc(32, 3) });
const token = generateSecret("github-token", 9);

const action: CanonicalAction = {
  id: "act_00000000000000000000000000000001",
  sessionId: "ses_00000000000000000000000000000001",
  agent: {
    host: "claude-code",
    hostVersion: "2.1.276",
    id: "agt_00000000000000000000000000000001",
  },
  userObjective: "Publish the release notes.",
  taskSummary: `The agent is pushing with GITHUB_TOKEN=${token}.`,
  tool: { name: "Bash", description: "Runs a shell command" },
  operation: "execute",
  arguments: { command: `GITHUB_TOKEN=${token} gh release create v1.0.0` },
  operands: {
    command: { raw: `GITHUB_TOKEN=${token} gh release create v1.0.0` },
  },
  resource: { environment: "production", identifier: "github.com/acme/webapp" },
  sideEffectClass: "external-write",
  cwd: "/home/dev/acme/webapp",
  repository: {
    root: "/home/dev/acme/webapp",
    branch: "main",
    remoteHost: "github.com",
  },
  adapterMetadata: { hookEventName: "PreToolUse", toolUseId: "toolu_123" },
  createdAt: NOW.toISOString(),
};

describe("RFX-033 semantic context compiler", () => {
  it("selects the fields by name, redacted, and nothing about identity, tenancy, cwd or metadata", () => {
    const compiler = createContextCompiler({ redactor, clock: () => NOW });
    const request = compiler.compile(action, {
      maxInputTokens: 600,
      deadlineMs: 500,
    });
    const text = JSON.stringify(request);
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED:github-token:");
    for (const absent of [
      "/home/dev",
      "agt_",
      "ses_",
      "act_",
      "toolu_",
      "hookEventName",
      "cwd",
      "adapterMetadata",
    ]) {
      expect(text, absent).not.toContain(absent);
    }
    expect(request.action.tool).toEqual({
      name: "Bash",
      description: "Runs a shell command",
    });
    expect(request.action.resource).toEqual({
      environment: "production",
      identifier: "github.com/acme/webapp",
    });
    expect(request.action.repository).toEqual({
      branch: "main",
      remoteHost: "github.com",
    });
    expect(request.maxInputTokens).toBe(600);
    expect(request.deadlineMs).toBe(500);
  });

  it("adds the relevant history from the session and the policy hints for the action", () => {
    const earlier = {
      ...action,
      id: "act_00000000000000000000000000000000" as const,
      tool: { name: "Bash" },
      arguments: { command: "git status" },
      createdAt: "2026-09-23T11:59:00.000Z",
    };
    const compiler = createContextCompiler({
      redactor,
      clock: () => NOW,
      history: () => [historyEntryOf(earlier, "allow")],
      policyHints: (current) =>
        current.sideEffectClass === "external-write"
          ? ["Pushes need approval."]
          : [],
    });
    const report = compiler.compileWithReport(action, {
      maxInputTokens: 600,
      deadlineMs: 500,
    });
    expect(report.historyItems).toBe(1);
    expect(report.request.action.priorActions).toEqual([
      {
        actionId: earlier.id,
        toolName: "Bash",
        operation: "execute",
        effect: "allow",
        occurredAt: earlier.createdAt,
      },
    ]);
    expect(report.request.policyHints).toEqual(["Pushes need approval."]);
    expect(report.redactions.map((hit) => hit.kind)).toEqual([
      "github-token",
      "github-token",
      "github-token",
    ]);
    expect(JSON.stringify(report.request)).not.toContain("/home/dev");
  });

  it("keeps the request under the budget, and reports what it cut", () => {
    const big: CanonicalAction = {
      ...action,
      arguments: { command: "cat > notes.md", content: "line\n".repeat(2_000) },
    };
    const compiler = createContextCompiler({ redactor, clock: () => NOW });
    const report = compiler.compileWithReport(big, {
      maxInputTokens: 200,
      deadlineMs: 500,
    });
    expect(report.estimatedTokens).toBeLessThanOrEqual(200);
    expect(report.truncated).toContain("arguments");
    expect(String(report.request.action.arguments.content)).toContain(
      TRUNCATION_MARK,
    );
    expect(report.request.action.tool.name).toBe("Bash");
    expect(report.request.action.sideEffectClass).toBe("external-write");
  });

  // Adversarial: a secret placed anywhere an attacker or a careless agent can
  // put one must not reach the request, whatever the budget did.
  it("lets no secret through any field, before or after truncation", () => {
    const aws = generateSecret("aws-access-key", 12);
    const key = generateSecret("stripe-key", 13);
    const laced: CanonicalAction = {
      ...action,
      userObjective: `deploy with ${aws}`,
      taskSummary: `then charge with ${key}`,
      tool: { name: "Bash", description: `uses ${aws}` },
      operation: `run ${key}`,
      arguments: {
        command: `AWS_ACCESS_KEY_ID=${aws} STRIPE_SECRET_KEY=${key} ./deploy.sh`,
        padding: "p".repeat(10_000),
      },
      resource: {
        environment: "production",
        identifier: `postgres://app:${generateSecret("url-credentials", 14)}@db/app`,
      },
      priorActions: [
        {
          toolName: "Bash",
          operation: `echo ${aws}`,
          occurredAt: "2026-09-23T11:58:00.000Z",
        },
      ],
    };
    const compiler = createContextCompiler({
      redactor,
      clock: () => NOW,
      policyHints: () => [`never ${aws}`],
    });
    for (const budget of [10, 100, 600, 100_000]) {
      const request = compiler.compile(laced, {
        maxInputTokens: budget,
        deadlineMs: 500,
      });
      const text = JSON.stringify(request);
      expect(text, String(budget)).not.toContain(aws);
      expect(text, String(budget)).not.toContain(key);
    }
  });

  it("produces a request whose action fields are the contract's", () => {
    const compiler = createContextCompiler({ redactor, clock: () => NOW });
    const request = compiler.compile(action, {
      maxInputTokens: 600,
      deadlineMs: 500,
    });
    // The request's action is a subset of a canonical action; put back what
    // the subset leaves out and the contract accepts it.
    const rebuilt = {
      ...request.action,
      id: action.id,
      agent: action.agent,
      createdAt: action.createdAt,
    };
    expect(parseCanonicalAction(rebuilt).ok).toBe(true);
  });
});
