import type { DecisionId } from "./ids.js";
import type { IsoTimestamp } from "./primitives.js";

/**
 * Human feedback on a decision. It feeds Approval Learning, which may propose
 * policy changes and may never silently alter enforcement (CLAUDE.md
 * principle 8). Feedback is therefore evidence, exactly like a semantic
 * assessment: it carries no effect of its own.
 */
export const DECISION_FEEDBACK_VALUES = [
  "correct",
  "should-allow",
  "should-ask",
  "should-deny",
] as const;
export type DecisionFeedbackValue = (typeof DECISION_FEEDBACK_VALUES)[number];

export interface DecisionFeedback {
  decisionId: DecisionId;
  value: DecisionFeedbackValue;
  actorId?: string;
  note?: string;
  createdAt: IsoTimestamp;
}
