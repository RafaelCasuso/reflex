import type { DecisionEffect } from "@reflex-control/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";

/**
 * RFX-002 smoke test: this package resolves the canonical contracts through
 * its own manifest, at runtime and at the type level.
 */
describe("@reflex-control/adapter-claude-code workspace wiring", () => {
  it("resolves @reflex-control/contracts at runtime", async () => {
    await expect(import("@reflex-control/contracts")).resolves.toBeTypeOf(
      "object",
    );
  });

  it("resolves @reflex-control/contracts types", () => {
    expectTypeOf<DecisionEffect>().toEqualTypeOf<"allow" | "ask" | "deny">();
  });
});
