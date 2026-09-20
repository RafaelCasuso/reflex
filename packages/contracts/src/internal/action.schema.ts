import { z } from "zod";

import { CONTRACT_LIMITS } from "../limits.js";
import {
  DECISION_EFFECTS,
  ENVIRONMENT_KINDS,
  HOST_KINDS,
  SIDE_EFFECT_CLASSES,
} from "../primitives.js";
import {
  jsonObjectSchema,
  nameSchema,
  opaqueIdSchema,
  pathSchema,
  textSchema,
  timestampSchema,
} from "./schemas.js";

const agentIdentitySchema = z.strictObject({
  id: opaqueIdSchema("agt").exactOptional(),
  name: nameSchema.exactOptional(),
  host: z.enum(HOST_KINDS),
  hostVersion: nameSchema.exactOptional(),
  model: nameSchema.exactOptional(),
});

const actionToolSchema = z.strictObject({
  name: nameSchema,
  namespace: nameSchema.exactOptional(),
  description: textSchema.exactOptional(),
});

const actionResourceSchema = z.strictObject({
  type: nameSchema.exactOptional(),
  identifier: pathSchema.exactOptional(),
  environment: z.enum(ENVIRONMENT_KINDS),
  isProduction: z.boolean().exactOptional(),
});

const actionRepositorySchema = z.strictObject({
  root: pathSchema.exactOptional(),
  branch: nameSchema.exactOptional(),
  remoteHost: nameSchema.exactOptional(),
});

const priorActionSummarySchema = z.strictObject({
  actionId: opaqueIdSchema("act").exactOptional(),
  toolName: nameSchema,
  operation: nameSchema.exactOptional(),
  effect: z.enum(DECISION_EFFECTS).exactOptional(),
  occurredAt: timestampSchema,
});

const commandOperandSchema = z
  .strictObject({
    raw: z.string().min(1).max(CONTRACT_LIMITS.commandLength).exactOptional(),
    argv: z
      .array(z.string().max(CONTRACT_LIMITS.commandLength))
      .min(1)
      .max(CONTRACT_LIMITS.operandItems)
      .readonly()
      .exactOptional(),
  })
  .check((context) => {
    const { raw, argv } = context.value;
    if (raw === undefined && argv === undefined) {
      context.issues.push({
        code: "custom",
        input: context.value,
        path: ["raw"],
        params: { reflexCode: "missing", expected: "raw or argv" },
      });
    }
  });

const actionOperandsSchema = z.strictObject({
  command: commandOperandSchema.exactOptional(),
  paths: z
    .array(pathSchema)
    .max(CONTRACT_LIMITS.operandItems)
    .readonly()
    .exactOptional(),
  networkHosts: z
    .array(nameSchema)
    .max(CONTRACT_LIMITS.operandItems)
    .readonly()
    .exactOptional(),
});

/**
 * Strict at every level: an action is an input to a safety decision, and the
 * decision-maker does not ignore what it does not understand. Host- or
 * provider-shaped keys are rejected, never stripped (ADR-001 §2).
 */
export const canonicalActionSchema = z.strictObject({
  id: opaqueIdSchema("act"),
  organizationId: opaqueIdSchema("org").exactOptional(),
  projectId: opaqueIdSchema("prj").exactOptional(),
  sessionId: opaqueIdSchema("ses").exactOptional(),

  agent: agentIdentitySchema,

  userObjective: textSchema.exactOptional(),
  taskSummary: textSchema.exactOptional(),

  tool: actionToolSchema,
  operation: nameSchema.exactOptional(),

  arguments: jsonObjectSchema,
  operands: actionOperandsSchema.exactOptional(),

  resource: actionResourceSchema.exactOptional(),
  sideEffectClass: z.enum(SIDE_EFFECT_CLASSES),

  cwd: pathSchema.exactOptional(),
  repository: actionRepositorySchema.exactOptional(),

  priorActions: z
    .array(priorActionSummarySchema)
    .max(CONTRACT_LIMITS.priorActions)
    .readonly()
    .exactOptional(),

  adapterMetadata: jsonObjectSchema.exactOptional(),

  createdAt: timestampSchema,
});
