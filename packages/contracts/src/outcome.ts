import type { ActionId } from "./ids.js";
import type { IsoTimestamp } from "./primitives.js";

/**
 * What the host did with an action (ADR-013).
 *
 * A `CanonicalAction` is what the agent intended and a `ReflexDecision` is what
 * REFLEX decided. Neither says whether the host prompted the human, what the
 * human answered, or whether the action ran. Without that, the north-star
 * metric, "approval prompts eliminated" and Approval Learning (which mines the
 * host's native approvals) have nothing to be computed from.
 *
 * An outcome is a separate record keyed by `actionId`, written by the adapter
 * after the fact. It carries no tool output and no argument values.
 *
 * `unknown` means the host exposed no signal. It is never a guess, and a
 * consumer must never read it as `no`.
 */
export const OBSERVATION_STATES = ["yes", "no", "unknown"] as const;
export type ObservationState = (typeof OBSERVATION_STATES)[number];

/** `none` means the human was not asked. It is only valid with `prompted: "no"`. */
export const HUMAN_RESPONSES = [
  "approved",
  "rejected",
  "none",
  "unknown",
] as const;
export type HumanResponse = (typeof HUMAN_RESPONSES)[number];

export interface ActionOutcome {
  actionId: ActionId;
  /** Did the host show its native approval prompt for this action? */
  prompted: ObservationState;
  /** What the human answered. */
  humanResponse: HumanResponse;
  /** Did the host run the action? */
  executed: ObservationState;
  /** When the last contributing signal was observed. */
  observedAt: IsoTimestamp;
}
