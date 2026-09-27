import type { ReflexDecision } from "@reflex/contracts";
import { describe, expect, it } from "vitest";

import {
  answerFor,
  describeDecision,
  fallbackAnswer,
  fallbackEffect,
} from "./decide.js";

/**
 * RFX-043 — the mapping to the host's permission decision, and the client's
 * own answer when the daemon is out of reach. Adversarial: no argument value
 * may reach the reason line, and the client never answers with silence.
 */
const decision = (overrides: Partial<ReflexDecision> = {}): ReflexDecision => ({
  id: "dec_00000000000000000000000000000001",
  actionId: "act_00000000000000000000000000000001",
  effect: "allow",
  effectiveEffect: "allow",
  mode: "assist",
  risk: 5,
  confidence: 1,
  reasonCodes: ["explicit_allow"],
  policyMatches: [
    {
      ruleId: "allow-touch",
      ruleName: "Allow touch",
      effect: "allow",
      mandatory: false,
      precedence: 50,
    },
  ],
  cached: false,
  latency: { totalMs: 1, policyMs: 1 },
  decidedAt: "2026-09-27T10:00:00.000Z",
  ...overrides,
});

describe("RFX-043 the answer to the host", () => {
  it("is the PreToolUse permission decision the host understands", () => {
    expect(answerFor("deny", "REFLEX: denied by rule x")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "REFLEX: denied by rule x",
      },
    });
  });

  it("maps the effective effect, so Assist never blocks and Autopilot does", () => {
    const denied = decision({
      effect: "deny",
      effectiveEffect: "ask",
      mode: "assist",
      reasonCodes: ["explicit_deny"],
      policyMatches: [
        {
          ruleId: "deny-rm",
          ruleName: "Deny rm",
          effect: "deny",
          mandatory: false,
          precedence: 50,
        },
      ],
    });
    expect(describeDecision(denied)).toBe(
      "REFLEX: needs your approval, rule deny-rm",
    );
    expect(
      describeDecision({
        ...denied,
        effectiveEffect: "deny",
        mode: "autopilot",
      }),
    ).toBe("REFLEX: denied by rule deny-rm");
    expect(describeDecision(decision())).toBe(
      "REFLEX: allowed by rule allow-touch",
    );
  });

  it("names the default, the assessment or the fallback when no rule decided, and the reason codes", () => {
    expect(
      describeDecision(
        decision({
          effect: "ask",
          effectiveEffect: "ask",
          reasonCodes: ["unknown_risk"],
          policyMatches: [],
        }),
      ),
    ).toBe("REFLEX: needs your approval, policy default (unknown_risk)");
    expect(
      describeDecision(
        decision({
          effect: "ask",
          effectiveEffect: "ask",
          reasonCodes: ["destructive", "low_confidence"],
          policyMatches: [],
          semanticAssessment: {
            objectiveAlignment: { value: 67, confidence: 0.9 },
            destructiveRisk: { value: 67, confidence: 0.4 },
            reversibility: { value: 33, confidence: 0.9 },
            externalSideEffect: { value: false, confidence: 0.9 },
            privilegeEscalation: { value: 0, confidence: 0.9 },
            secretAccess: { value: 0, confidence: 0.9 },
            sensitiveDataExposure: { value: 0, confidence: 0.9 },
            financialConsequence: { value: 0, confidence: 0.9 },
            productionMutation: { value: 0, confidence: 0.9 },
            unusualScope: { value: 0, confidence: 0.9 },
            untrustedInput: { value: 0, confidence: 0.9 },
            provider: "fake",
            latencyMs: 1,
          },
        }),
      ),
    ).toBe(
      "REFLEX: needs your approval, assessment by fake (destructive, low_confidence)",
    );
    expect(
      describeDecision(
        decision({
          effect: "ask",
          effectiveEffect: "ask",
          reasonCodes: ["provider_unavailable"],
          policyMatches: [],
          fallback: {
            used: true,
            reason: "provider-error",
            configuredMode: "fail-ask",
          },
        }),
      ),
    ).toBe(
      "REFLEX: needs your approval, fallback (provider-error) (provider_unavailable)",
    );
  });

  // Adversarial: the reason line is shown to the user and may be fed to the
  // model; nothing from the arguments may be in it.
  it("never puts an argument value in the reason", () => {
    const secret = ["canary", "token", "9f8e7d6c"].join("-");
    const withSecret = decision({
      policyMatches: [
        {
          ruleId: "allow-touch",
          ruleName: `Allow ${secret}`,
          effect: "allow",
          mandatory: false,
          precedence: 50,
        },
      ],
    });
    // Rule ids and reason codes only: not the rule's name, not the action.
    expect(describeDecision(withSecret)).not.toContain(secret);
  });

  it("answers by itself when nothing can be reached: ask, or deny under fail-closed in Autopilot", () => {
    expect(fallbackEffect("assist", "fail-open")).toBe("ask");
    expect(fallbackEffect("assist", "fail-closed")).toBe("ask");
    expect(fallbackEffect("autopilot", "fail-ask")).toBe("ask");
    expect(fallbackEffect("autopilot", "fail-closed")).toBe("deny");
    expect(
      fallbackAnswer("autopilot", "fail-closed", "daemon-timeout"),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "REFLEX: the local daemon did not answer in time; blocked as configured (fail-closed)",
      },
    });
    expect(
      fallbackAnswer("assist", "fail-ask", "daemon-unavailable")
        .hookSpecificOutput,
    ).toMatchObject({ permissionDecision: "ask" });
  });
});
