import type { DecisionEffect, ReflexMode } from "@reflex-control/contracts";
import { describe, expect, it } from "vitest";

import { effectiveEffectOf } from "./modes.js";

/** ADR-002 §2, every cell. Enforcement item for RFX-019. */
describe("effectiveEffect by mode (ADR-002 §2)", () => {
  it.each<[ReflexMode, DecisionEffect, DecisionEffect]>([
    ["observe", "allow", "ask"],
    ["observe", "ask", "ask"],
    ["observe", "deny", "ask"],
    ["assist", "allow", "allow"],
    ["assist", "ask", "ask"],
    ["assist", "deny", "ask"],
    ["autopilot", "allow", "allow"],
    ["autopilot", "ask", "ask"],
    ["autopilot", "deny", "deny"],
  ])("%s + %s enforces %s", (mode, effect, expected) => {
    expect(effectiveEffectOf(mode, effect)).toBe(expected);
  });

  it("never enforces more than autopilot, and autopilot enforces exactly the effect", () => {
    for (const effect of ["allow", "ask", "deny"] as const) {
      expect(effectiveEffectOf("autopilot", effect)).toBe(effect);
      // Assist never blocks; Observe never does anything.
      expect(effectiveEffectOf("assist", effect)).not.toBe("deny");
      expect(effectiveEffectOf("observe", effect)).toBe("ask");
    }
  });
});
