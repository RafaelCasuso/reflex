import { randomBytes } from "node:crypto";

import type { CanonicalAction } from "@reflex-control/contracts";
import { describe, expect, it } from "vitest";

import { PROJECT, shell } from "./engine.test-support.js";
import { decisionCacheKey, fingerprintAction } from "./fingerprint.js";

const KEY = Buffer.alloc(32, 7);
const fp = (action: CanonicalAction, key: Uint8Array = KEY) =>
  fingerprintAction(action, key);

describe("RFX-106 action fingerprint", () => {
  const action = shell("git status");

  it("is a keyed hash in the contract's hash format", () => {
    expect(fp(action)).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(fp(action)).toBe(fp(action));
  });

  it("changes with the key, so nothing outside the daemon can confirm a guess", () => {
    expect(fp(action, randomBytes(32))).not.toBe(fp(action));
  });

  // ADR-001 §3.4: what varies per call without changing the decision.
  it.each<[string, Partial<CanonicalAction>]>([
    ["the action id", { id: "act_00000000000000000000000000000002" }],
    ["the session", { sessionId: "ses_00000000000000000000000000000009" }],
    ["the timestamp", { createdAt: "2027-01-01T00:00:00.000Z" }],
    ["the adapter's metadata", { adapterMetadata: { preApproved: true } }],
    [
      "the organization",
      { organizationId: "org_0000000000000000000000000000000a" },
    ],
    ["the project id", { projectId: "prj_0000000000000000000000000000000b" }],
    [
      "the prior actions",
      {
        priorActions: [
          { toolName: "Bash", occurredAt: "2026-09-22T09:59:00.000Z" },
        ],
      },
    ],
    [
      "the agent's id",
      {
        agent: {
          host: "claude-code",
          id: "agt_0000000000000000000000000000000c",
        },
      },
    ],
  ])("ignores %s", (_label, change) => {
    expect(fp({ ...action, ...change })).toBe(fp(action));
  });

  it.each<[string, Partial<CanonicalAction>]>([
    ["the command", { arguments: { command: "git push --force" } }],
    ["an operand", { operands: { command: { raw: "git status " } } }],
    ["the tool", { tool: { name: "Write" } }],
    ["the namespace", { tool: { name: "Bash", namespace: "helper" } }],
    ["the class", { sideEffectClass: "destructive" }],
    ["the working directory", { cwd: "/elsewhere" }],
    ["the repository", { repository: { root: PROJECT, branch: "main" } }],
    ["the environment", { resource: { environment: "production" } }],
    ["the host", { agent: { host: "codex" } }],
    ["the objective", { userObjective: "ship it" }],
  ])("changes with %s", (_label, change) => {
    expect(fp({ ...action, ...change })).not.toBe(fp(action));
  });

  it("does not depend on the order of keys, at any depth", () => {
    const ordered = {
      ...action,
      arguments: { command: "ls", extra: { b: 1, a: [{ y: 2, x: 1 }] } },
    };
    const reordered = {
      ...action,
      arguments: { extra: { a: [{ x: 1, y: 2 }], b: 1 }, command: "ls" },
    };
    expect(fp(reordered)).toBe(fp(ordered));
  });

  it("tells an absent member from an empty one", () => {
    expect(fp({ ...action, arguments: {} })).not.toBe(
      fp({ ...action, arguments: { command: "" } }),
    );
  });

  // Adversarial: two commands that print alike must not hash alike.
  it("is exact about the text", () => {
    expect(fp(shell("rm -rf ./build"))).not.toBe(fp(shell("rm -rf ./build ")));
    expect(fp(shell("rm -rf ./build"))).not.toBe(fp(shell("rm -rf .​/build")));
  });
});

describe("RFX-106 cache key", () => {
  const base = {
    fingerprint: "hmac-sha256:aa",
    policySetHash: "sha256:11",
  };

  it("is a hash of the fingerprint, the policy set, the project and the environment", () => {
    expect(decisionCacheKey(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(decisionCacheKey(base)).toBe(decisionCacheKey({ ...base }));
    expect(decisionCacheKey({ ...base, policySetHash: "sha256:22" })).not.toBe(
      decisionCacheKey(base),
    );
    expect(
      decisionCacheKey({ ...base, fingerprint: "hmac-sha256:ab" }),
    ).not.toBe(decisionCacheKey(base));
    expect(
      decisionCacheKey({
        ...base,
        projectId: "prj_0000000000000000000000000000000b",
      }),
    ).not.toBe(decisionCacheKey(base));
    expect(decisionCacheKey({ ...base, environment: "production" })).not.toBe(
      decisionCacheKey(base),
    );
    expect(decisionCacheKey({ ...base, provider: "jev" })).not.toBe(
      decisionCacheKey(base),
    );
    expect(
      decisionCacheKey({ ...base, provider: "jev", model: "jev-1.13.0" }),
    ).not.toBe(decisionCacheKey({ ...base, provider: "jev" }));
  });
});
