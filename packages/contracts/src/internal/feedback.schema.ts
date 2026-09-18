import { z } from "zod";

import { DECISION_FEEDBACK_VALUES } from "../feedback.js";
import {
  nameSchema,
  opaqueIdSchema,
  textSchema,
  timestampSchema,
} from "./schemas.js";

/** Strict: feedback is an input to policy suggestions. */
export const decisionFeedbackSchema = z.strictObject({
  decisionId: opaqueIdSchema("dec"),
  value: z.enum(DECISION_FEEDBACK_VALUES),
  actorId: nameSchema.exactOptional(),
  note: textSchema.exactOptional(),
  createdAt: timestampSchema,
});
