import type { DecisionEffect } from "@reflex/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";

/**
 * RFX-002 smoke test: this package resolves the canonical contracts through
 * its own manifest, at runtime and at the type level.
 */
describe("@reflex/command-classifier workspace wiring", () => {
  it("resolves @reflex/contracts at runtime", async () => {
    await expect(import("@reflex/contracts")).resolves.toBeTypeOf("object");
  });

  it("resolves @reflex/contracts types", () => {
    expectTypeOf<DecisionEffect>().toEqualTypeOf<"allow" | "ask" | "deny">();
  });
});
