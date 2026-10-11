import { z } from "zod";

import {
  CLAIM_CODE_FORM,
  CLOUD_KEY_FORM,
  CLOUD_KEY_SCOPES,
  INGEST_REJECTION_REASONS,
} from "../cloud.js";
import { FALLBACK_REASONS, REASON_CODES } from "../decision.js";
import { CONTRACT_LIMITS } from "../limits.js";
import {
  DECISION_EFFECTS,
  ENVIRONMENT_KINDS,
  FAILURE_MODES,
  HOST_KINDS,
  REFLEX_MODES,
  SIDE_EFFECT_CLASSES,
} from "../primitives.js";
import { decisionFeedbackSchema } from "./feedback.schema.js";
import { actionOutcomeSchema } from "./outcome.schema.js";
import { decisionRecordSchema } from "./record.schema.js";
import {
  confidenceSchema,
  durationMsSchema,
  hashSchema,
  nameSchema,
  opaqueIdSchema,
  scoreSchema,
  timestampSchema,
} from "./schemas.js";

/**
 * ADR-019. Inputs to storage are strict at every level: a summary with a
 * field this schema does not name (an argument, a path, a working
 * directory) is refused, never stripped. The two answers are tolerant,
 * because a daemon is often older than the control plane it talks to.
 */
const actionSummarySchema = z.strictObject({
  host: z.enum(HOST_KINDS),
  hostVersion: nameSchema.exactOptional(),
  toolName: nameSchema,
  toolNamespace: nameSchema.exactOptional(),
  operation: nameSchema.exactOptional(),
  sideEffectClass: z.enum(SIDE_EFFECT_CLASSES),
  environment: z.enum(ENVIRONMENT_KINDS),
  branch: nameSchema.exactOptional(),
  remoteHost: nameSchema.exactOptional(),
});

const decisionLatencySchema = z.strictObject({
  totalMs: durationMsSchema,
  policyMs: durationMsSchema,
  contextMs: durationMsSchema.exactOptional(),
  semanticMs: durationMsSchema.exactOptional(),
  aggregationMs: durationMsSchema.exactOptional(),
});

export const decisionSummarySchema = z.strictObject({
  decisionId: opaqueIdSchema("dec"),
  actionId: opaqueIdSchema("act"),
  agentId: opaqueIdSchema("agt"),
  projectId: opaqueIdSchema("prj"),
  sessionId: opaqueIdSchema("ses").exactOptional(),
  decidedAt: timestampSchema,
  action: actionSummarySchema,
  effect: z.enum(DECISION_EFFECTS),
  effectiveEffect: z.enum(DECISION_EFFECTS),
  mode: z.enum(REFLEX_MODES),
  risk: scoreSchema,
  confidence: confidenceSchema,
  reasonCodes: z
    .array(z.enum(REASON_CODES))
    .max(CONTRACT_LIMITS.reasonCodes)
    .readonly(),
  matchedRuleIds: z
    .array(nameSchema)
    .max(CONTRACT_LIMITS.policyMatches)
    .readonly(),
  policySetHash: hashSchema.exactOptional(),
  cached: z.boolean(),
  fallback: z
    .strictObject({
      used: z.boolean(),
      reason: z.enum(FALLBACK_REASONS).exactOptional(),
      configuredMode: z.enum(FAILURE_MODES).exactOptional(),
    })
    .exactOptional(),
  provider: nameSchema.exactOptional(),
  model: nameSchema.exactOptional(),
  latency: decisionLatencySchema,
});

const decisionEntrySchema = z
  .strictObject({
    kind: z.literal("decision"),
    summary: decisionSummarySchema,
    record: decisionRecordSchema.exactOptional(),
  })
  .check((context) => {
    const { summary, record } = context.value;
    if (
      record !== undefined &&
      (record.decisionId !== summary.decisionId ||
        record.actionId !== summary.actionId)
    ) {
      context.issues.push({
        code: "custom",
        input: context.value,
        path: ["record", "decisionId"],
        params: {
          reflexCode: "invalid_value",
          expected: "the record of the summary's own decision",
        },
      });
    }
  });

export const ingestEntrySchema = z.discriminatedUnion("kind", [
  decisionEntrySchema,
  z.strictObject({
    kind: z.literal("outcome"),
    projectId: opaqueIdSchema("prj"),
    outcome: actionOutcomeSchema,
  }),
  z.strictObject({
    kind: z.literal("feedback"),
    projectId: opaqueIdSchema("prj"),
    feedback: decisionFeedbackSchema,
  }),
]);

export const ingestRequestSchema = z.strictObject({
  agentId: opaqueIdSchema("agt"),
  sentAt: timestampSchema,
  entries: z
    .array(ingestEntrySchema)
    .max(CONTRACT_LIMITS.ingestEntries)
    .readonly(),
});

export const ingestResultSchema = z.object({
  accepted: z.int().min(0),
  duplicates: z.int().min(0),
  rejected: z
    .array(
      z.object({
        index: z.int().min(0),
        reason: z.enum(INGEST_REJECTION_REASONS),
      }),
    )
    .max(CONTRACT_LIMITS.ingestEntries)
    .readonly(),
});

export const claimRequestSchema = z.strictObject({
  code: z
    .string()
    .min(1)
    .max(CONTRACT_LIMITS.claimCodeLength)
    .check((context) => {
      if (!CLAIM_CODE_FORM.test(context.value)) {
        context.issues.push({
          code: "custom",
          input: context.value,
          params: {
            reflexCode: "invalid_format",
            expected: "a claim code of the form RFX-XXXX-XXXX-XXXX",
          },
        });
      }
    }),
  agent: z.strictObject({
    id: opaqueIdSchema("agt"),
    createdAt: timestampSchema,
  }),
  project: z.strictObject({
    id: opaqueIdSchema("prj"),
    name: nameSchema,
  }),
  hosts: z.array(z.enum(HOST_KINDS)).max(HOST_KINDS.length).readonly(),
  requestedAt: timestampSchema,
});

export const claimResultSchema = z.object({
  organization: z.object({
    id: opaqueIdSchema("org"),
    name: nameSchema,
  }),
  project: z.object({
    id: opaqueIdSchema("prj"),
  }),
  key: z.object({
    id: opaqueIdSchema("key"),
    secret: z
      .string()
      .max(CONTRACT_LIMITS.nameLength)
      .check((context) => {
        if (!CLOUD_KEY_FORM.test(context.value)) {
          context.issues.push({
            code: "custom",
            input: context.value,
            params: {
              reflexCode: "invalid_format",
              expected: "a key of the form rfk_<key id>_<secret>",
            },
          });
        }
      }),
    scope: z.enum(CLOUD_KEY_SCOPES),
  }),
  claimedAt: timestampSchema,
});
