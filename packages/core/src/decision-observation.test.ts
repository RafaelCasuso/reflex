import type { ReflexDecision } from "@reflex-control/contracts";
import {
  createFakeProvider,
  type FakeBehavior,
} from "@reflex-control/semantic-provider";
import { describe, expect, it, vi } from "vitest";

import { DecisionCache } from "./cache.js";
import { createDecisionEngine } from "./decision-engine.js";
import {
  HOME,
  SEMANTIC_ONLY,
  assessment,
  compiled,
  local,
  passThroughCompiler,
  request,
  shell,
} from "./engine.test-support.js";
import { createRiskAggregator } from "./risk-aggregator.js";
import type { DecisionObservation } from "./semantic-stage.js";

/**
 * RFX-143 — what a decision was made of, handed to the record's observer
 * after the answer and off the decision path: the redacted request the
 * primary got, the primary's answer or failure, every shadow started, and
 * whether a rule or a policy default decided.
 */
const ALLOW_GIT_STATUS = `
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

function build(
  options: {
    readonly policy?: string;
    readonly primary?: FakeBehavior;
    readonly shadow?: boolean;
    readonly shadowSample?: "unresolved" | "all";
    readonly cache?: boolean;
    readonly semantic?: boolean;
  } = {},
) {
  const primary = createFakeProvider({
    behavior: options.primary ?? { kind: "fixed", assessment: assessment() },
  });
  const shadow = createFakeProvider();
  const observations: DecisionObservation[] = [];
  const set = compiled(local(options.policy ?? SEMANTIC_ONLY));
  const engine = createDecisionEngine({
    policy: () => set,
    ...(options.semantic === false
      ? {}
      : {
          semantic: {
            provider: primary,
            compiler: passThroughCompiler,
            aggregator: createRiskAggregator(),
            maxInputTokens: 600,
            ...(options.shadow === true
              ? {
                  shadow: [
                    {
                      provider: shadow,
                      deadlineMs: 200,
                      sample: options.shadowSample ?? "unresolved",
                    },
                  ],
                }
              : {}),
          },
        }),
    failureMode: "fail-ask",
    deadline: { defaultMs: 200, maxMs: 1_000 },
    paths: { home: HOME },
    ...(options.cache === true
      ? { cache: new DecisionCache({ maxEntries: 10, ttlMs: 60_000 }) }
      : {}),
    onDecision: (observation) => {
      observations.push(observation);
    },
  });
  return { engine, primary, shadow, observations };
}

const observed = (built: ReturnType<typeof build>, count: number) =>
  vi.waitFor(() => {
    expect(built.observations).toHaveLength(count);
  });

describe("RFX-143 the decision observer", () => {
  it("is told after the answer, not before", async () => {
    const built = build();
    const decision = await built.engine.decide(request(shell("cat README.md")));
    expect(built.observations).toHaveLength(0);
    await observed(built, 1);
    expect(built.observations[0]?.decision).toBe(decision);
  });

  it("carries the request the primary got and the primary's answer", async () => {
    const built = build();
    const decision = await built.engine.decide(request(shell("cat README.md")));
    await observed(built, 1);
    const [observation] = built.observations;
    expect(observation?.request).toEqual(built.primary.calls[0]);
    expect(observation?.primary).toMatchObject({
      provider: "fake",
      model: "fake-1",
      result: { ok: true, assessment: decision.semanticAssessment },
    });
    expect(Number.isInteger(observation?.primary?.latencyMs)).toBe(true);
    expect(observation?.resolvedByPolicy).toBe(false);
    expect(observation?.shadows).toEqual([]);
  });

  it("carries the primary's failure when the decision fell back", async () => {
    const built = build({ primary: { kind: "error", error: "rate-limited" } });
    const decision = await built.engine.decide(request(shell("cat README.md")));
    expect(decision.fallback?.used).toBe(true);
    await observed(built, 1);
    expect(built.observations[0]?.primary?.result).toMatchObject({
      ok: false,
      error: { kind: "rate-limited" },
    });
    expect(built.observations[0]?.request).toBeDefined();
  });

  it("says a rule decided, and carries no request or primary then", async () => {
    const built = build({ policy: ALLOW_GIT_STATUS });
    await built.engine.decide(request(shell("git status")));
    await observed(built, 1);
    expect(built.observations[0]).toMatchObject({ resolvedByPolicy: true });
    expect(built.observations[0]?.request).toBeUndefined();
    expect(built.observations[0]?.primary).toBeUndefined();
    expect(built.primary.calls).toHaveLength(0);
  });

  it("says a policy default decided too, and an ask for want of a provider did not", async () => {
    const asks = build({
      policy: `
version: 1
defaults:
  unresolved: ask
rules: []
`,
    });
    await asks.engine.decide(request(shell("cat README.md")));
    await observed(asks, 1);
    expect(asks.observations[0]?.resolvedByPolicy).toBe(true);
    const unassessed = build({ semantic: false });
    const decision = await unassessed.engine.decide(
      request(shell("cat README.md")),
    );
    expect(decision.effect).toBe("ask");
    await observed(unassessed, 1);
    expect(unassessed.observations[0]?.resolvedByPolicy).toBe(false);
    expect(unassessed.observations[0]?.primary).toBeUndefined();
  });

  it("hands over every shadow as a promise that settles with its observation", async () => {
    const built = build({ shadow: true });
    const decision = await built.engine.decide(request(shell("cat README.md")));
    await observed(built, 1);
    const shadows = built.observations[0]?.shadows ?? [];
    expect(shadows).toHaveLength(1);
    const [settled] = await Promise.all(shadows);
    expect(settled).toMatchObject({
      decisionId: decision.id,
      role: "shadow",
      sampledOn: "unresolved",
      result: { ok: true },
    });
  });

  it("includes the shadows sampled on a resolved action, started after the answer", async () => {
    const built = build({
      policy: ALLOW_GIT_STATUS,
      shadow: true,
      shadowSample: "all",
    });
    await built.engine.decide(request(shell("git status")));
    await observed(built, 1);
    expect(built.observations[0]?.resolvedByPolicy).toBe(true);
    const shadows = built.observations[0]?.shadows ?? [];
    expect(shadows).toHaveLength(1);
    expect((await shadows[0])?.sampledOn).toBe("resolved");
  });

  it("observes a decision served from the cache, with nothing evaluated", async () => {
    const built = build({ cache: true });
    await built.engine.decide(request(shell("cat README.md")));
    const second = await built.engine.decide(request(shell("cat README.md")));
    expect(second.cached).toBe(true);
    await observed(built, 2);
    const cached = built.observations.find(
      (observation) => observation.decision.cached,
    );
    expect(cached?.primary).toBeUndefined();
    expect(cached?.request).toBeUndefined();
    expect(cached?.shadows).toEqual([]);
    expect(cached?.resolvedByPolicy).toBe(false);
  });

  it("measures the primary's latency on the clock, never below zero", async () => {
    const built = build({ primary: { kind: "slow", ms: 20 } });
    await built.engine.decide(request(shell("cat README.md")));
    await observed(built, 1);
    expect(built.observations[0]?.primary?.latencyMs).toBeGreaterThanOrEqual(
      15,
    );
  });

  it("changes nothing when the observer throws", async () => {
    const set = compiled(local(SEMANTIC_ONLY));
    const engine = createDecisionEngine({
      policy: () => set,
      semantic: {
        provider: createFakeProvider(),
        compiler: passThroughCompiler,
        aggregator: createRiskAggregator(),
        maxInputTokens: 600,
      },
      failureMode: "fail-ask",
      deadline: { defaultMs: 200, maxMs: 1_000 },
      paths: { home: HOME },
      onDecision: () => {
        throw new Error("the observer's own bug");
      },
    });
    const decision: ReflexDecision = await engine.decide(
      request(shell("cat README.md")),
    );
    expect(decision.effect).toBe("allow");
    await new Promise((resolve) => setImmediate(resolve));
    expect(decision.effect).toBe("allow");
  });
});
