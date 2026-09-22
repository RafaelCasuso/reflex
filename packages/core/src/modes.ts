import type { DecisionEffect, ReflexMode } from "@reflex/contracts";

/**
 * ADR-002 §2 — what the adapter enforces under each mode.
 *
 * `effect` is computed the same way in every mode; the mode changes what
 * REFLEX does about it, never what it concludes. `ask` has one meaning
 * everywhere: the host's native approval flow decides.
 *
 * - Observe is `ask`, and the adapter emits nothing: the host's own flow
 *   decides everything. The worst a consumer that ignores `mode` can do with
 *   it is prompt.
 * - Assist never blocks: a `deny` becomes a request for native approval.
 * - Autopilot enforces all three.
 */
export function effectiveEffectOf(
  mode: ReflexMode,
  effect: DecisionEffect,
): DecisionEffect {
  switch (mode) {
    case "observe":
      return "ask";
    case "assist":
      return effect === "deny" ? "ask" : effect;
    case "autopilot":
      return effect;
  }
}
