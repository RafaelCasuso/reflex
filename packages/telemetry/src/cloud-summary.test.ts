import {
  parseDecisionSummary,
  type AgentId,
  type CanonicalAction,
  type ReflexDecision,
} from "@reflex-control/contracts";
import { describe, expect, it } from "vitest";

import { decisionSummaryOf, summaryFromEvent } from "./cloud-summary.js";
import { decisionEventsOf, type DecisionEvent } from "./decision-events.js";

/**
 * ADR-019 §4 — a summary is a decision by name. The canaries are every
 * place content could hide in an action; none may come out in a summary,
 * even when the builder is handed the whole action.
 */
const CANARIES = {
  argument: "canary-argument-value-0011",
  cwd: "/home/dev/canary-project",
  root: "/home/dev/canary-project/.git",
  objective: "canary objective: ship the release",
  summary: "canary task summary",
  metadata: "canary-adapter-metadata",
  path: "/home/dev/canary-project/notes.txt",
} as const;

const AGENT: AgentId = "agt_0f1e2d3c4b5a69788796a5b4c3d2e1f0";

/** The action without its project: what an unclaimed install sends. */
function anonymous(
  source: CanonicalAction,
): Omit<CanonicalAction, "projectId"> {
  const copy: Partial<CanonicalAction> = { ...source };
  delete copy.projectId;
  return copy as Omit<CanonicalAction, "projectId">;
}

const action: CanonicalAction = {
  id: "act_01J8ZC2N6Q4T7V9X3B5D8F0H2M",
  projectId: "prj_00112233445566778899aabbccddeeff",
  sessionId: "ses_01J8ZC2M4P6R8T0V2X4Z6B8D0F",
  agent: { host: "claude-code", hostVersion: "2.1.276" },
  userObjective: CANARIES.objective,
  taskSummary: CANARIES.summary,
  tool: { name: "Bash" },
  operation: "git",
  arguments: { command: `git add ${CANARIES.argument}` },
  operands: {
    command: { raw: `git add ${CANARIES.argument}` },
    paths: [CANARIES.path],
  },
  resource: { environment: "unknown", isProduction: true },
  sideEffectClass: "local-write",
  cwd: CANARIES.cwd,
  repository: { root: CANARIES.root, branch: "main", remoteHost: "github.com" },
  adapterMetadata: { raw: CANARIES.metadata },
  createdAt: "2026-10-10T10:00:00.000Z",
};

const decision: ReflexDecision = {
  id: "dec_01J8ZC2P0R3S5U7W9Y1A3C5E7H",
  actionId: action.id,
  effect: "ask",
  effectiveEffect: "ask",
  mode: "assist",
  risk: 62,
  confidence: 0.71,
  reasonCodes: ["external_side_effect"],
  policyMatches: [
    {
      policyId: "pol_org-baseline",
      ruleId: "external-writes-ask",
      ruleName: "External writes need approval",
      effect: "ask",
      mandatory: true,
      precedence: 100,
    },
  ],
  semanticAssessment: {
    objectiveAlignment: { value: 88, confidence: 0.9 },
    destructiveRisk: { value: 5, confidence: 0.95 },
    reversibility: { value: 80, confidence: 0.8 },
    externalSideEffect: { value: true, confidence: 0.99 },
    privilegeEscalation: { value: 0, confidence: 0.97 },
    secretAccess: { value: 2, confidence: 0.9 },
    sensitiveDataExposure: { value: 10, confidence: 0.6 },
    financialConsequence: { value: 0, confidence: 0.99 },
    productionMutation: { value: 4, confidence: 0.85 },
    unusualScope: { value: 12, confidence: 0.7 },
    untrustedInput: { value: 20, confidence: 0.55 },
    provider: "example-provider",
    model: "example-model-1",
    latencyMs: 142,
  },
  policySetHash:
    "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  cached: false,
  fallback: { used: true, reason: "timeout", configuredMode: "fail-ask" },
  latency: { totalMs: 171, policyMs: 1, semanticMs: 142 },
  decidedAt: "2026-10-10T10:00:00.421Z",
};

describe("ADR-019 decision summary", () => {
  it("carries the ids, the facts by name, and what was decided", () => {
    const summary = decisionSummaryOf({ decision, action, agentId: AGENT });
    expect(summary).toEqual({
      decisionId: decision.id,
      actionId: action.id,
      agentId: AGENT,
      projectId: action.projectId,
      sessionId: action.sessionId,
      decidedAt: decision.decidedAt,
      action: {
        host: "claude-code",
        hostVersion: "2.1.276",
        toolName: "Bash",
        operation: "git",
        sideEffectClass: "local-write",
        // `isProduction` wins over `unknown` (ADR-001 §4).
        environment: "production",
        branch: "main",
        remoteHost: "github.com",
      },
      effect: "ask",
      effectiveEffect: "ask",
      mode: "assist",
      risk: 62,
      confidence: 0.71,
      reasonCodes: ["external_side_effect"],
      matchedRuleIds: ["external-writes-ask"],
      policySetHash: decision.policySetHash,
      cached: false,
      fallback: { used: true, reason: "timeout", configuredMode: "fail-ask" },
      provider: "example-provider",
      model: "example-model-1",
      latency: { totalMs: 171, policyMs: 1, semanticMs: 142 },
    });
    expect(parseDecisionSummary(summary).ok).toBe(true);
  });

  it("prefers the agent id the action carries, and falls back to the installation's", () => {
    const own = decisionSummaryOf({
      decision,
      action: { ...action, agent: { ...action.agent, id: "agt_own" } },
      agentId: AGENT,
    });
    expect(own?.agentId).toBe("agt_own");
    expect(
      decisionSummaryOf({ decision, action, agentId: AGENT })?.agentId,
    ).toBe(AGENT);
  });

  it("has no summary for an action that names no project", () => {
    expect(
      decisionSummaryOf({
        decision,
        action: anonymous(action),
        agentId: AGENT,
      }),
    ).toBeUndefined();
  });

  // Adversarial: the whole action, canaries in every content field.
  it("lets no content through, whatever the action carries", () => {
    const text = JSON.stringify(
      decisionSummaryOf({ decision, action, agentId: AGENT }),
    );
    for (const [name, canary] of Object.entries(CANARIES)) {
      expect(text, name).not.toContain(canary);
    }
    expect(text).not.toContain("arguments");
    expect(text).not.toContain("operands");
    expect(text).not.toContain("cwd");
  });
});

describe("ADR-019 summary from a local event", () => {
  const [event] = decisionEventsOf({
    decision,
    action,
    at: decision.decidedAt,
  });

  it("rebuilds the same summary from the event this version writes", () => {
    expect(event?.kind).toBe("decision");
    const fromEvent = summaryFromEvent(event as DecisionEvent, AGENT);
    const direct = decisionSummaryOf({ decision, action, agentId: AGENT });
    // The event keeps whether a fallback was used, not why.
    expect(fromEvent).toEqual({ ...direct, fallback: { used: true } });
    expect(parseDecisionSummary(fromEvent).ok).toBe(true);
  });

  it("has no summary for an event written before the facts were recorded", () => {
    const older = { ...(event as DecisionEvent) } as Record<string, unknown>;
    delete older.sideEffectClass;
    delete older.environment;
    expect(
      summaryFromEvent(older as unknown as DecisionEvent, AGENT),
    ).toBeUndefined();
  });

  it("has no summary for an event of an action that named no project", () => {
    const [unclaimed] = decisionEventsOf({
      decision,
      action: anonymous(action),
      at: decision.decidedAt,
    });
    expect(summaryFromEvent(unclaimed as DecisionEvent, AGENT)).toBeUndefined();
  });

  it("writes the facts into the local event, and no content", () => {
    const text = JSON.stringify(event);
    expect(event).not.toHaveProperty("agentId");
    expect(event).toMatchObject({
      projectId: action.projectId,
      sessionId: action.sessionId,
      operation: "git",
      sideEffectClass: "local-write",
      environment: "production",
      branch: "main",
      remoteHost: "github.com",
    });
    for (const [name, canary] of Object.entries(CANARIES)) {
      expect(text, name).not.toContain(canary);
    }
  });
});
