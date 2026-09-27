import { describe, expect, it } from "vitest";

import { OverrideStore } from "./overrides.js";

/** RFX-125 — one denied decision, one grant, one use; a mandatory deny never. */
const DEC_1 = "dec_00000000000000000000000000000001";
const DEC_2 = "dec_00000000000000000000000000000002";
const DEC_3 = "dec_00000000000000000000000000000003";
const FP = "fp-rm-rf-build";

function remembered(store: OverrideStore, now = 1_000): OverrideStore {
  store.remember(
    {
      decisionId: DEC_1,
      fingerprint: FP,
      effectiveEffect: "deny",
      mandatoryDeny: false,
    },
    now,
  );
  store.remember(
    {
      decisionId: DEC_2,
      fingerprint: "fp-git-status",
      effectiveEffect: "allow",
      mandatoryDeny: false,
    },
    now,
  );
  store.remember(
    {
      decisionId: DEC_3,
      fingerprint: "fp-force-push",
      effectiveEffect: "deny",
      mandatoryDeny: true,
    },
    now,
  );
  return store;
}

describe("the override store", () => {
  it("grants a remembered deny once, and the grant is taken once", () => {
    const store = remembered(new OverrideStore());
    const granted = store.grant(DEC_1, 2_000);
    expect(granted).toEqual({
      ok: true,
      grant: {
        decisionId: DEC_1,
        fingerprint: FP,
        grantedAt: 2_000,
        expiresAt: 602_000,
      },
    });
    expect(store.grant(DEC_1, 2_001)).toEqual({
      ok: false,
      reason: "already-granted",
    });
    expect(store.take(FP, 3_000)?.decisionId).toBe(DEC_1);
    expect(store.take(FP, 3_001)).toBeUndefined();
    expect(store.counters(3_002)).toEqual({
      granted: 1,
      consumed: 1,
      refused: 1,
      pending: 0,
    });
  });

  it("refuses what it does not remember, what did not deny, and what is mandatory", () => {
    const store = remembered(new OverrideStore());
    expect(store.grant("dec_00000000000000000000000000000009", 2_000)).toEqual({
      ok: false,
      reason: "unknown-decision",
    });
    expect(store.grant(DEC_2, 2_000)).toEqual({
      ok: false,
      reason: "not-a-deny",
    });
    // Adversarial: the mandatory deny is remembered like any other and is
    // still refused; nothing about it becomes a grant.
    expect(store.grant(DEC_3, 2_000)).toEqual({
      ok: false,
      reason: "mandatory-deny",
    });
    expect(store.take("fp-force-push", 2_001)).toBeUndefined();
    expect(store.counters(2_002).refused).toBe(3);
  });

  it("forgets a decision after its time, and a grant after its own", () => {
    const store = remembered(
      new OverrideStore({ decisionTtlMs: 10_000, grantTtlMs: 5_000 }),
    );
    expect(store.grant(DEC_1, 11_001)).toEqual({
      ok: false,
      reason: "unknown-decision",
    });
    const store2 = remembered(
      new OverrideStore({ decisionTtlMs: 10_000, grantTtlMs: 5_000 }),
    );
    expect(store2.grant(DEC_1, 2_000).ok).toBe(true);
    expect(store2.take(FP, 7_000)).toBeUndefined();
    expect(store2.counters(7_000).pending).toBe(0);
  });

  it("keeps a bounded number of decisions, the newest", () => {
    const store = new OverrideStore({ maxDecisions: 2 });
    remembered(store);
    expect(store.grant(DEC_1, 2_000)).toEqual({
      ok: false,
      reason: "unknown-decision",
    });
    expect(store.grant(DEC_3, 2_000)).toEqual({
      ok: false,
      reason: "mandatory-deny",
    });
  });

  it("is keyed by the action's fingerprint: another action is not let through", () => {
    const store = remembered(new OverrideStore());
    expect(store.grant(DEC_1, 2_000).ok).toBe(true);
    expect(store.take("fp-rm-rf-slash", 2_001)).toBeUndefined();
    expect(store.take(FP, 2_002)).toBeDefined();
  });
});
