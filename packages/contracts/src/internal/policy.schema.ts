import { z } from "zod";

import { DECISION_EFFECTS } from "../primitives.js";
import { nameSchema, opaqueIdSchema } from "./schemas.js";

/** Read as part of a decision, so unknown keys are ignored (ADR-009). */
export const policyMatchSchema = z.object({
  policyId: opaqueIdSchema("pol").exactOptional(),
  ruleId: nameSchema,
  ruleName: nameSchema.exactOptional(),
  effect: z.enum(DECISION_EFFECTS),
  mandatory: z.boolean(),
  precedence: z.int(),
});
