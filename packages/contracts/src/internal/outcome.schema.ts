import { z } from "zod";

import { HUMAN_RESPONSES, OBSERVATION_STATES } from "../outcome.js";
import { opaqueIdSchema, timestampSchema } from "./schemas.js";

function inconsistent(
  input: unknown,
  path: string,
  expected: string,
): z.core.$ZodRawIssue {
  return {
    code: "custom",
    input,
    path: [path],
    params: { reflexCode: "invalid_value", expected },
  };
}

/**
 * Strict: an outcome is an input to metrics and to Approval Learning
 * (ADR-013, ADR-009 §2).
 *
 * The fields are not independent. A record that contradicts itself would let
 * a metric count the same action as both interrupted and autonomous, so it is
 * rejected, never reconciled.
 */
export const actionOutcomeSchema = z
  .strictObject({
    actionId: opaqueIdSchema("act"),
    prompted: z.enum(OBSERVATION_STATES),
    humanResponse: z.enum(HUMAN_RESPONSES),
    executed: z.enum(OBSERVATION_STATES),
    observedAt: timestampSchema,
  })
  .check((context) => {
    const { prompted, humanResponse, executed } = context.value;

    if (prompted === "no" && humanResponse !== "none") {
      context.issues.push(
        inconsistent(
          context.value,
          "humanResponse",
          '"none" when the host did not prompt',
        ),
      );
    }
    if (prompted === "yes" && humanResponse === "none") {
      context.issues.push(
        inconsistent(
          context.value,
          "humanResponse",
          'an answer or "unknown" when the host prompted',
        ),
      );
    }
    // Knowing the answer implies knowing there was a question.
    if (prompted === "unknown" && humanResponse !== "unknown") {
      context.issues.push(
        inconsistent(
          context.value,
          "humanResponse",
          '"unknown" when it is not known whether the host prompted',
        ),
      );
    }
    if (humanResponse === "rejected" && executed === "yes") {
      context.issues.push(
        inconsistent(
          context.value,
          "executed",
          'anything but "yes" when the human rejected the action',
        ),
      );
    }
  });
