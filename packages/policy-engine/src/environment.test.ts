import { describe, expect, it } from "vitest";

import { canonicalizePolicySet } from "./canonical.js";
import { CONTEXT, policy, shell } from "./engine.test-support.js";
import {
  compilePolicySet,
  evaluatePolicy,
  type PolicySourceDocument,
} from "./evaluator.js";

/**
 * RFX-084 — an `environment` source applies only to the environment it
 * names, and its deny is a floor (ADR-018). Held at the engine; the daemon
 * resolves the environment of an action before asking (RFX-084, gateway).
 */
const RM = policy(`
version: 1
rules:
  - id: env-no-rm
    name: No rm here
    effect: deny
    conditions:
      - { field: command.name, operator: equals, value: rm }
  - id: env-ask-git
    name: Ask about git here
    effect: ask
    conditions:
      - { field: command.name, operator: equals, value: git }
`);

const LOCAL = policy(`
version: 1
rules:
  - id: me-rm
    name: rm is mine
    effect: allow
    conditions:
      - { field: command.name, operator: equals, value: rm }
  - id: me-git
    name: git is mine
    effect: allow
    conditions:
      - { field: command.name, operator: equals, value: git }
`);

const production: PolicySourceDocument = {
  source: "environment",
  trusted: true,
  environment: "production",
  document: RM,
};
const local: PolicySourceDocument = {
  source: "local",
  trusted: true,
  document: LOCAL,
};

function effectOf(
  sources: readonly PolicySourceDocument[],
  command: string,
  environment?: "production" | "staging" | "unknown",
): { effect: string | undefined; mandatory: boolean[] } {
  const compiled = compilePolicySet(sources);
  if (!compiled.ok) {
    throw new Error(compiled.problems.join("; "));
  }
  const base = shell(command);
  const action =
    environment === undefined ? base : { ...base, resource: { environment } };
  const result = evaluatePolicy(compiled.set, action, CONTEXT);
  return {
    effect: result.evaluation.effect,
    mandatory: result.evaluation.matches.map((match) => match.mandatory),
  };
}

describe("RFX-084 environment sources", () => {
  it("apply only to actions resolved to their environment", () => {
    expect(effectOf([production, local], "rm -rf x", "production").effect).toBe(
      "deny",
    );
    expect(effectOf([production, local], "rm -rf x", "staging").effect).toBe(
      "allow",
    );
    expect(effectOf([production, local], "rm -rf x", "unknown").effect).toBe(
      "allow",
    );
    expect(effectOf([production, local], "rm -rf x").effect).toBe("allow");
  });

  it("make their deny a floor whatever the file says, and leave their ask a default", () => {
    const inProduction = effectOf(
      [production, local],
      "rm -rf x",
      "production",
    );
    expect(inProduction.effect).toBe("deny");
    expect(inProduction.mandatory[0]).toBe(true);
    // A non-mandatory ask of the environment is a default a more specific
    // source overrides (ADR-004 §3): the local allow wins.
    expect(
      effectOf([production, local], "git status", "production").effect,
    ).toBe("allow");
  });

  it("hold a mandatory ask against a local allow", () => {
    const strict: PolicySourceDocument = {
      ...production,
      document: policy(`
version: 1
rules:
  - id: env-ask-git
    name: Ask about git here
    effect: ask
    mandatory: true
    conditions:
      - { field: command.name, operator: equals, value: git }
`),
    };
    expect(effectOf([strict, local], "git status", "production").effect).toBe(
      "ask",
    );
  });

  it("are refused without an environment, with unknown, or on another source", () => {
    expect(
      compilePolicySet([{ source: "environment", trusted: true, document: RM }])
        .ok,
    ).toBe(false);
    expect(
      compilePolicySet([
        {
          source: "environment",
          trusted: true,
          environment: "unknown",
          document: RM,
        },
      ]).ok,
    ).toBe(false);
    expect(
      compilePolicySet([
        {
          source: "organization",
          trusted: true,
          environment: "production",
          document: RM,
        },
      ]).ok,
    ).toBe(false);
  });

  it("may reuse a rule id across environments, which the canonical form tells apart", () => {
    const staging: PolicySourceDocument = {
      ...production,
      environment: "staging",
    };
    const compiled = compilePolicySet([production, staging]);
    expect(compiled.ok).toBe(true);
    const a = canonicalizePolicySet([
      {
        source: "environment",
        trusted: true,
        environment: "production",
        rules: RM.rules,
      },
    ]);
    const b = canonicalizePolicySet([
      {
        source: "environment",
        trusted: true,
        environment: "staging",
        rules: RM.rules,
      },
    ]);
    expect(a.hash).not.toBe(b.hash);
    expect(a.payload).toContain('"environment":"production"');
  });

  it("leave every set without an environment source hashing as before", () => {
    const plain = canonicalizePolicySet([
      { source: "local", trusted: true, rules: LOCAL.rules },
    ]);
    expect(plain.payload).not.toContain("environment");
  });
});
