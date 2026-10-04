import type { ReflexDecision } from "@reflex-control/contracts";
import { describe, expect, it } from "vitest";

import { DecisionCache } from "./cache.js";
import { createDecisionEngine } from "./decision-engine.js";
import { compiled, local, request, shell } from "./engine.test-support.js";
import { OverrideStore } from "./overrides.js";
import type { DecisionObservation } from "./semantic-stage.js";

/**
 * RFX-125 — the engine and the override store together: a denied action is
 * let through once after a human's grant, never a mandatory deny, never
 * another action, never twice, and the cache cannot outlive the override.
 */
const POLICY = `
version: 1
defaults:
  unresolved: ask
rules:
  - id: deny-status
    name: Deny git status (cacheable class, for the cache test)
    effect: deny
    conditions:
      - { field: command.name, operator: equals, value: git }
      - { field: command.args, operator: equals, value: status }
  - id: deny-rm
    name: Deny rm
    effect: deny
    conditions:
      - { field: command.name, operator: equals, value: rm }
  - id: deny-force-push
    name: Deny a force push
    effect: deny
    mandatory: true
    conditions:
      - { field: command.name, operator: equals, value: git }
      - { field: command.args, operator: equals, value: --force }
`;

function harness(options: { cache?: boolean } = {}) {
  const store = new OverrideStore();
  const observed: DecisionObservation[] = [];
  let now = 1_000;
  const engine = createDecisionEngine({
    policy: () => compiled(local(POLICY)),
    failureMode: "fail-ask",
    deadline: { defaultMs: 1_000, maxMs: 5_000 },
    ...(options.cache === true ? { cache: new DecisionCache() } : {}),
    overrides: store,
    monotonic: () => now,
    clock: () => new Date(Date.UTC(2026, 8, 27, 10, 0, 0)),
    onDecision: (observation) => {
      observed.push(observation);
    },
  });
  return {
    store,
    engine,
    observed,
    tick: (ms: number) => {
      now += ms;
    },
    now: () => now,
    settled: () => new Promise((resolve) => setImmediate(resolve)),
    decide: (command: string): Promise<ReflexDecision> =>
      engine.decide(request(shell(command))),
  };
}

describe("RFX-125 overriding a deny", () => {
  it("lets the denied action through once, as the human's decision, and denies it again after", async () => {
    const h = harness();
    const denied = await h.decide("rm -rf build");
    expect(denied.effectiveEffect).toBe("deny");

    expect(h.store.grant(denied.id, h.now()).ok).toBe(true);
    const allowed = await h.decide("rm -rf build");
    expect(allowed).toMatchObject({
      effect: "allow",
      effectiveEffect: "allow",
      confidence: 1,
      reasonCodes: ["human_override", "destructive"],
      cached: false,
      // The rule that denied is still on the record: the human overrode it.
      policyMatches: expect.arrayContaining([
        expect.objectContaining({ ruleId: "deny-rm", effect: "deny" }),
      ]) as unknown,
    });
    expect(allowed.id).not.toBe(denied.id);

    const again = await h.decide("rm -rf build");
    expect(again.effectiveEffect).toBe("deny");
    expect(again.reasonCodes).not.toContain("human_override");

    await h.settled();
    const override = h.observed.find((o) => o.decision.id === allowed.id);
    expect(override).toMatchObject({
      humanOverride: true,
      resolvedByPolicy: false,
    });
    expect(h.observed.find((o) => o.decision.id === denied.id)).toMatchObject({
      humanOverride: false,
      resolvedByPolicy: true,
    });
  });

  it("is for one action: a grant does not let a different denied action through", async () => {
    const h = harness();
    const denied = await h.decide("rm -rf build");
    expect(h.store.grant(denied.id, h.now()).ok).toBe(true);
    const other = await h.decide("rm -rf dist");
    expect(other.effectiveEffect).toBe("deny");
    // The grant is still waiting for its own action.
    expect(h.store.counters(h.now()).pending).toBe(1);
  });

  // Adversarial: the store refuses to grant a mandatory deny; and if a grant
  // for its fingerprint is planted anyway, the engine still denies.
  it("never lets a mandatory deny through, even with a planted grant", async () => {
    const h = harness();
    const action = shell("git push --force");
    const denied = await h.engine.decide(request(action));
    expect(denied.effectiveEffect).toBe("deny");
    expect(h.store.grant(denied.id, h.now())).toEqual({
      ok: false,
      reason: "mandatory-deny",
    });

    const planted = "dec_00000000000000000000000000000bad";
    h.store.remember(
      {
        decisionId: planted,
        fingerprint: h.engine.fingerprint(action),
        effectiveEffect: "deny",
        mandatoryDeny: false,
      },
      h.now(),
    );
    expect(h.store.grant(planted, h.now()).ok).toBe(true);
    const still = await h.engine.decide(request(action));
    expect(still.effectiveEffect).toBe("deny");
    expect(still.reasonCodes).not.toContain("human_override");
    // The planted grant was consumed by the attempt and bought nothing.
    expect(h.store.counters(h.now()).pending).toBe(0);
  });

  it("overrides nothing that did not deny: an allow, an ask, or a deny in a mode that did not enforce it", async () => {
    const h = harness();
    const asked = await h.decide("ls");
    expect(asked.effectiveEffect).toBe("ask");
    expect(h.store.grant(asked.id, h.now())).toEqual({
      ok: false,
      reason: "not-a-deny",
    });
    const observed = await h.engine.decide(
      request(shell("rm -rf build"), { mode: "observe" }),
    );
    expect(observed).toMatchObject({ effect: "deny", effectiveEffect: "ask" });
    expect(h.store.grant(observed.id, h.now())).toEqual({
      ok: false,
      reason: "not-a-deny",
    });
    const assisted = await h.engine.decide(
      request(shell("rm -rf build"), { mode: "assist" }),
    );
    expect(assisted.effectiveEffect).toBe("ask");
    expect(h.store.grant(assisted.id, h.now())).toEqual({
      ok: false,
      reason: "not-a-deny",
    });
  });

  // Adversarial for the cache: the deny is cached; the override must not be
  // answered from the cache, and the override itself must not be cached.
  it("is checked before the cache, and the allow it produces is never cached", async () => {
    const h = harness({ cache: true });
    const first = await h.decide("git status");
    expect(first).toMatchObject({ effectiveEffect: "deny", cached: false });
    const second = await h.decide("git status");
    expect(second).toMatchObject({ effectiveEffect: "deny", cached: true });

    expect(h.store.grant(second.id, h.now()).ok).toBe(true);
    const overridden = await h.decide("git status");
    expect(overridden).toMatchObject({
      effect: "allow",
      cached: false,
      reasonCodes: ["human_override"],
    });
    const after = await h.decide("git status");
    expect(after).toMatchObject({ effectiveEffect: "deny", cached: true });
  });

  it("remembers a cached decision too, so that it can be overridden", async () => {
    const h = harness({ cache: true });
    await h.decide("git status");
    const cached = await h.decide("git status");
    expect(cached.cached).toBe(true);
    expect(h.store.grant(cached.id, h.now()).ok).toBe(true);
  });
});
