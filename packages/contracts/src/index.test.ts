import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  CanonicalAction,
  DecisionEffect,
  FailureMode,
  ReflexMode,
  SemanticDecisionRequest,
} from "./index.js";

/**
 * G0 smoke test only: proves the toolchain compiles, lints and runs this
 * package. Contract behaviour (IDs, validation, round-trips) is Gate G1.
 */
describe("@reflex/contracts", () => {
  it("loads as an ES module", async () => {
    await expect(import("./index.js")).resolves.toBeTypeOf("object");
  });

  it("keeps the canonical decision vocabulary closed", () => {
    // Verified by `pnpm typecheck`: widening any of these unions is a
    // decision-semantics change (CLAUDE.md) and must fail loudly.
    expectTypeOf<DecisionEffect>().toEqualTypeOf<"allow" | "ask" | "deny">();
    expectTypeOf<ReflexMode>().toEqualTypeOf<
      "observe" | "assist" | "autopilot"
    >();
    expectTypeOf<FailureMode>().toEqualTypeOf<
      "fail-open" | "fail-ask" | "fail-closed"
    >();
  });

  // Adversarial (ADR-001 §3): adapter metadata is attacker-influenced and
  // must never reach a semantic provider. Adding it to the request's field
  // selection has to fail `pnpm typecheck`.
  it("keeps adapter metadata out of semantic provider requests", () => {
    expectTypeOf<CanonicalAction>().toHaveProperty("adapterMetadata");
    expectTypeOf<SemanticDecisionRequest["action"]>().not.toHaveProperty(
      "adapterMetadata",
    );
  });
});
