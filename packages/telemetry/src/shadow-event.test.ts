import { describe, expect, it } from "vitest";

import { shadowEventOf } from "./decision-events.js";

/** RFX-142 — the shadow event carries an outcome and a duration, no content. */
describe("shadowEventOf", () => {
  const base = {
    decisionId: "dec_00000000000000000000000000000001",
    actionId: "act_00000000000000000000000000000001",
    provider: "local",
    model: "rdm-0.1.0",
    sampledOn: "unresolved",
    latencyMs: 12.6,
    at: "2026-09-25T10:00:00.000Z",
  } as const;

  it("says a shadow assessed, with its provider and model, pinned", () => {
    expect(shadowEventOf({ ...base, result: { ok: true } })).toEqual({
      kind: "shadow",
      eventVersion: 1,
      at: base.at,
      decisionId: base.decisionId,
      actionId: base.actionId,
      provider: "local",
      model: "rdm-0.1.0",
      sampledOn: "unresolved",
      outcome: "assessed",
      latencyMs: 13,
    });
  });

  it("says how a shadow failed and nothing else of what it returned", () => {
    const withoutModel: Record<string, unknown> = { ...base };
    delete withoutModel.model;
    const event = shadowEventOf({
      ...(withoutModel as Omit<typeof base, "model">),
      sampledOn: "resolved",
      latencyMs: -3,
      result: {
        ok: false,
        error: { kind: "timeout", detail: "canary provider text" },
      } as unknown as { ok: false; error: { kind: string } },
    });
    expect(event).toEqual({
      kind: "shadow",
      eventVersion: 1,
      at: base.at,
      decisionId: base.decisionId,
      actionId: base.actionId,
      provider: "local",
      sampledOn: "resolved",
      outcome: "failed",
      errorKind: "timeout",
      latencyMs: 0,
    });
    expect(JSON.stringify(event)).not.toContain("canary");
  });
});
