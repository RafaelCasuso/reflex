import type {
  DecisionRequest,
  ReflexDecision,
  SemanticAssessment,
} from "@reflex/contracts";
import {
  createFakeProvider,
  providerError,
  type FakeBehavior,
  type FakeProvider,
  type SemanticDecisionProvider,
} from "@reflex/semantic-provider";
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
import type {
  ShadowObservation,
  ShadowProvider,
  ShadowSample,
} from "./semantic-stage.js";

/**
 * RFX-142 — shadow evaluation (ADR-016 §3). A shadow is recorded and never
 * used: every field of a decision is the same with and without one, for a
 * shadow that answers the opposite, hangs, throws or fails, with and
 * without the cache; a shadow that would allow a deny leaves deny; only a
 * provider on this machine may be sampled on resolved actions; the
 * caller's signal is the primary's alone.
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

const DENY_CAT = `
version: 1
defaults:
  unresolved: semantic
rules:
  - id: deny-cat
    name: Deny cat
    effect: deny
    conditions:
      - { field: command.name, operator: equals, value: cat }
`;

/** Everything dangerous and sure: an aggregator would deny on it. */
const OPPOSITE: SemanticAssessment = assessment({
  objectiveAlignment: { value: 0, confidence: 0.95 },
  destructiveRisk: { value: 100, confidence: 0.95 },
  reversibility: { value: 0, confidence: 0.95 },
  secretAccess: { value: 100, confidence: 0.95 },
});

interface Built {
  readonly decide: (
    action: ReturnType<typeof shell>,
    overrides?: Partial<Omit<DecisionRequest, "action">>,
    signal?: AbortSignal,
  ) => Promise<ReflexDecision>;
  readonly primary: FakeProvider;
  readonly shadows: readonly FakeProvider[];
  readonly observations: ShadowObservation[];
}

interface BuildOptions {
  readonly policy?: string;
  readonly primary?: FakeBehavior;
  readonly shadows?: readonly {
    readonly behavior?: FakeBehavior;
    readonly provider?: SemanticDecisionProvider;
    readonly deadlineMs?: number;
    readonly sample?: ShadowSample;
  }[];
  readonly cache?: boolean;
  readonly observe?: boolean;
}

/** Two engines built alike decide alike: fixed clock, time, ids and key. */
function build(options: BuildOptions = {}): Built {
  const primary = createFakeProvider({
    behavior: options.primary ?? { kind: "fixed", assessment: assessment() },
  });
  const shadowFakes: FakeProvider[] = [];
  const shadow: ShadowProvider[] = (options.shadows ?? []).map((entry) => {
    const provider =
      entry.provider ??
      (() => {
        const fake = createFakeProvider({
          behavior: entry.behavior ?? { kind: "fixed", assessment: OPPOSITE },
        });
        shadowFakes.push(fake);
        return fake;
      })();
    return {
      provider,
      deadlineMs: entry.deadlineMs ?? 50,
      sample: entry.sample ?? "unresolved",
    };
  });
  const observations: ShadowObservation[] = [];
  let ids = 0;
  const set = compiled(local(options.policy ?? SEMANTIC_ONLY));
  const engine = createDecisionEngine({
    policy: () => set,
    semantic: {
      provider: primary,
      compiler: passThroughCompiler,
      aggregator: createRiskAggregator(),
      maxInputTokens: 600,
      ...(shadow.length === 0 ? {} : { shadow }),
    },
    failureMode: "fail-ask",
    deadline: { defaultMs: 200, maxMs: 1_000 },
    paths: { home: HOME },
    ...(options.cache === false
      ? {}
      : { cache: new DecisionCache({ maxEntries: 100, ttlMs: 60_000 }) }),
    clock: () => new Date(Date.UTC(2026, 8, 25, 10, 0, 0)),
    monotonic: () => 1_000,
    fingerprintKey: new Uint8Array(32).fill(5),
    newDecisionId: () => {
      ids += 1;
      return `dec_${String(ids).padStart(32, "0")}`;
    },
    ...(options.observe === false
      ? {}
      : {
          onShadow: (observation) => {
            observations.push(observation);
          },
        }),
  });
  return {
    decide: (action, overrides, signal) =>
      engine.decide(request(action, overrides), signal),
    primary,
    shadows: shadowFakes,
    observations,
  };
}

/**
 * `latency.policyMs` is the policy engine's own wall clock, read inside
 * `evaluatePolicy` and rounded to a millisecond; no shadow touches it, and
 * two runs can still straddle a millisecond. Everything else is fixed.
 */
const withoutPolicyClock = (decision: ReflexDecision): ReflexDecision => ({
  ...decision,
  latency: { ...decision.latency, policyMs: 0 },
});

const settled = (built: Built, count: number) =>
  vi.waitFor(() => {
    expect(built.observations).toHaveLength(count);
  });

describe("RFX-142 a shadow is recorded and never used", () => {
  const SHADOWS: readonly [string, FakeBehavior][] = [
    ["answers the opposite", { kind: "fixed", assessment: OPPOSITE }],
    ["hangs", { kind: "hang" }],
    ["throws", { kind: "throw" }],
    ["fails", { kind: "error", error: "unavailable" }],
    ["is slow", { kind: "slow", ms: 30 }],
  ];

  describe.each([true, false])("with the cache: %s", (cache) => {
    it.each(SHADOWS)(
      "every field of the decision is the same with a shadow that %s",
      async (_label, behavior) => {
        const alone = build({ cache });
        const shadowed = build({ cache, shadows: [{ behavior }] });
        for (const action of [
          shell("cat README.md"),
          shell("cat README.md"),
          shell("rm -rf ~"),
          shell("git status"),
        ]) {
          const expected = await alone.decide(action);
          const actual = await shadowed.decide(action);
          expect(JSON.stringify(withoutPolicyClock(actual))).toBe(
            JSON.stringify(withoutPolicyClock(expected)),
          );
        }
        expect(shadowed.primary.calls).toEqual(alone.primary.calls);
      },
    );
  });

  it("gives the shadow the primary's request, now, and records what it came to", async () => {
    const built = build({ shadows: [{}] });
    const decision = await built.decide(shell("cat README.md"));
    expect(decision.effect).toBe("allow");
    await settled(built, 1);
    const [observation] = built.observations;
    expect(observation).toMatchObject({
      decisionId: decision.id,
      actionId: decision.actionId,
      role: "shadow",
      provider: "fake",
      model: "fake-1",
      sampledOn: "unresolved",
      result: { ok: true, assessment: OPPOSITE },
    });
    expect(observation?.request).toEqual(built.primary.calls[0]);
    expect(Number.isInteger(observation?.latencyMs)).toBe(true);
    // Nothing of the shadow reached the decision.
    expect(decision.semanticAssessment).toEqual(assessment());
  });

  it("leaves a deny alone when the shadow would allow it", async () => {
    const built = build({
      primary: { kind: "fixed", assessment: OPPOSITE },
      shadows: [{ behavior: { kind: "fixed", assessment: assessment() } }],
    });
    const decision = await built.decide(shell("cat README.md"));
    expect(decision.effect).toBe("deny");
    await settled(built, 1);
    expect(built.observations[0]?.result).toEqual({
      ok: true,
      assessment: assessment(),
    });
  });

  it("counts a shadow that never answers as a timeout on its own deadline, after the decision", async () => {
    const built = build({
      shadows: [{ behavior: { kind: "hang" }, deadlineMs: 20 }],
    });
    const decision = await built.decide(shell("cat README.md"));
    expect(built.observations).toHaveLength(0);
    expect(decision.fallback).toBeUndefined();
    await settled(built, 1);
    expect(built.observations[0]?.result).toMatchObject({
      ok: false,
      error: { kind: "timeout", providerName: "fake" },
    });
  });

  it("records a shadow that throws as unavailable, and one that fails as it failed", async () => {
    const built = build({
      shadows: [
        { behavior: { kind: "throw" } },
        { behavior: { kind: "error", error: "rate-limited" } },
      ],
    });
    await built.decide(shell("cat README.md"));
    await settled(built, 2);
    expect(
      built.observations.map((observation) =>
        observation.result.ok ? "ok" : observation.result.error.kind,
      ),
    ).toEqual(expect.arrayContaining(["unavailable", "rate-limited"]));
  });

  it("does not run a shadow on a decision served from the cache", async () => {
    const built = build({ shadows: [{}] });
    const first = await built.decide(shell("cat README.md"));
    const second = await built.decide(shell("cat README.md"));
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    await settled(built, 1);
    expect(built.shadows[0]?.calls).toHaveLength(1);
  });

  it("keeps the caller's signal for the primary: a cancelled decision still lets the shadow settle", async () => {
    const built = build({
      primary: { kind: "hang" },
      shadows: [{ behavior: { kind: "slow", ms: 20 } }],
    });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 5);
    const decision = await built.decide(
      shell("cat README.md"),
      {},
      controller.signal,
    );
    expect(decision.fallback?.used).toBe(true);
    expect(built.primary.signals[0]?.aborted).toBe(true);
    await settled(built, 1);
    // The shadow got its own signal, not the caller's, and answered.
    expect(built.shadows[0]?.signals[0]).not.toBe(controller.signal);
    expect(built.observations[0]?.result.ok).toBe(true);
  });

  it("changes nothing without an observer", async () => {
    const built = build({ shadows: [{}], observe: false });
    const decision = await built.decide(shell("cat README.md"));
    expect(decision.effect).toBe("allow");
    await vi.waitFor(() => {
      expect(built.shadows[0]?.calls).toHaveLength(1);
    });
    expect(built.observations).toHaveLength(0);
  });

  it("survives an observer that throws", async () => {
    const primary = createFakeProvider();
    const shadow = createFakeProvider();
    const set = compiled(local(SEMANTIC_ONLY));
    const engine = createDecisionEngine({
      policy: () => set,
      semantic: {
        provider: primary,
        compiler: passThroughCompiler,
        aggregator: createRiskAggregator(),
        maxInputTokens: 600,
        shadow: [{ provider: shadow, deadlineMs: 50, sample: "unresolved" }],
      },
      failureMode: "fail-ask",
      deadline: { defaultMs: 200, maxMs: 1_000 },
      paths: { home: HOME },
      onShadow: () => {
        throw new Error("an observer's own bug");
      },
    });
    const decision = await engine.decide(request(shell("cat README.md")));
    expect(decision.effect).toBe("allow");
    await vi.waitFor(() => {
      expect(shadow.calls).toHaveLength(1);
    });
  });
});

describe("RFX-142 sampling on resolved actions", () => {
  it("runs a shadow sampled on everything over an action a rule resolved, off the path, and the decision is unchanged", async () => {
    const alone = build({ policy: ALLOW_GIT_STATUS });
    const built = build({
      policy: ALLOW_GIT_STATUS,
      shadows: [{ sample: "all" }],
    });
    const expected = await alone.decide(shell("git status"));
    const decision = await built.decide(shell("git status"));
    expect(JSON.stringify(withoutPolicyClock(decision))).toBe(
      JSON.stringify(withoutPolicyClock(expected)),
    );
    expect(decision.effect).toBe("allow");
    expect(built.primary.calls).toHaveLength(0);
    await settled(built, 1);
    expect(built.observations[0]).toMatchObject({
      decisionId: decision.id,
      sampledOn: "resolved",
      result: { ok: true },
    });
    expect(built.observations[0]?.request.action.arguments).toEqual({
      command: "git status",
    });
  });

  it("runs it over a denied action too, and deny stays deny", async () => {
    const built = build({
      policy: DENY_CAT,
      shadows: [
        {
          sample: "all",
          behavior: { kind: "fixed", assessment: assessment() },
        },
      ],
    });
    const decision = await built.decide(shell("cat README.md"));
    expect(decision.effect).toBe("deny");
    await settled(built, 1);
    expect(built.observations[0]?.sampledOn).toBe("resolved");
  });

  it("does not sample a shadow of unresolved actions on a resolved one", async () => {
    const built = build({
      policy: ALLOW_GIT_STATUS,
      shadows: [{ sample: "unresolved" }, { sample: "all" }],
    });
    await built.decide(shell("git status"));
    await settled(built, 1);
    expect(built.shadows[0]?.calls).toHaveLength(0);
    expect(built.shadows[1]?.calls).toHaveLength(1);
  });

  it("refuses to sample everything with a provider that is not on this machine", () => {
    const remote: SemanticDecisionProvider = {
      providerName: "remote",
      model: "remote-1.0.0",
      evaluate: () =>
        Promise.resolve({
          ok: false,
          error: providerError("unavailable", "remote", 0),
        }),
    };
    expect(() =>
      build({ shadows: [{ provider: remote, sample: "all" }] }),
    ).toThrow(/only a provider that runs on this machine/);
    // On unresolved actions it may run: that is where the primary runs too.
    expect(() =>
      build({ shadows: [{ provider: remote, sample: "unresolved" }] }),
    ).not.toThrow();
  });

  it("refuses a deadline that is not a whole positive number, and takes one millisecond", () => {
    for (const deadlineMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => build({ shadows: [{ deadlineMs }] })).toThrow(
        /whole, positive deadline/,
      );
    }
    expect(() => build({ shadows: [{ deadlineMs: 1 }] })).not.toThrow();
  });

  it("compiles for the shadows sampled on everything with the longest of their deadlines", async () => {
    const built = build({
      policy: ALLOW_GIT_STATUS,
      shadows: [
        { sample: "unresolved", deadlineMs: 50 },
        { sample: "all", deadlineMs: 100 },
        { sample: "all", deadlineMs: 300 },
      ],
    });
    await built.decide(shell("git status"));
    await settled(built, 2);
    for (const observation of built.observations) {
      expect(observation.sampledOn).toBe("resolved");
      expect(observation.request.deadlineMs).toBe(300);
    }
  });

  it("measures a shadow's latency on the clock, never below zero", async () => {
    const primary = createFakeProvider();
    const shadow = createFakeProvider({ behavior: { kind: "slow", ms: 20 } });
    const observations: ShadowObservation[] = [];
    const set = compiled(local(SEMANTIC_ONLY));
    const engine = createDecisionEngine({
      policy: () => set,
      semantic: {
        provider: primary,
        compiler: passThroughCompiler,
        aggregator: createRiskAggregator(),
        maxInputTokens: 600,
        shadow: [{ provider: shadow, deadlineMs: 500, sample: "unresolved" }],
      },
      failureMode: "fail-ask",
      deadline: { defaultMs: 200, maxMs: 1_000 },
      paths: { home: HOME },
      onShadow: (observation) => {
        observations.push(observation);
      },
    });
    await engine.decide(request(shell("cat README.md")));
    await vi.waitFor(() => {
      expect(observations).toHaveLength(1);
    });
    expect(observations[0]?.latencyMs).toBeGreaterThanOrEqual(15);
  });
});
