import type { CanonicalAction } from "./action.js";
import type {
  ClaimRequest,
  ClaimResult,
  DecisionSummary,
  IngestRequest,
  IngestResult,
} from "./cloud.js";
import type { DecisionRequest, ReflexDecision } from "./decision.js";
import type { DecisionFeedback } from "./feedback.js";
import { canonicalActionSchema } from "./internal/action.schema.js";
import {
  claimRequestSchema,
  claimResultSchema,
  decisionSummarySchema,
  ingestRequestSchema,
  ingestResultSchema,
} from "./internal/cloud.schema.js";
import {
  decisionRequestSchema,
  reflexDecisionSchema,
} from "./internal/decision.schema.js";
import { decisionFeedbackSchema } from "./internal/feedback.schema.js";
import { actionOutcomeSchema } from "./internal/outcome.schema.js";
import { decisionRecordSchema } from "./internal/record.schema.js";
import { semanticAssessmentSchema } from "./internal/semantic.schema.js";
import { validate } from "./internal/validate.js";
import type { ActionOutcome } from "./outcome.js";
import type { DecisionRecord } from "./record.js";
import type { SemanticAssessment } from "./semantic.js";
import type { ValidationResult } from "./validation.js";

/**
 * Boundary parsers. The only public module that touches the validation
 * machinery, and its signatures mention none of it: a consumer that imports
 * types from this package never loads the validation library's declarations.
 *
 * Every parser returns a typed result and never throws. Use them where data
 * enters a process (HTTP body, hook stdin, provider response) and nowhere
 * else: inside a process, trust the types.
 */

/** Strict: an action is an input to a safety decision (ADR-001, ADR-009). */
export function parseCanonicalAction(
  input: unknown,
): ValidationResult<CanonicalAction> {
  return validate(canonicalActionSchema, input);
}

/** Strict. */
export function parseDecisionRequest(
  input: unknown,
): ValidationResult<DecisionRequest> {
  return validate(decisionRequestSchema, input);
}

/**
 * Tolerant, within limits: unknown keys and unknown informational enum
 * members are ignored; `effect`, `effectiveEffect` and `mode` are closed
 * (ADR-009 §2). A failed parse is a gateway failure: apply the failure mode.
 */
export function parseReflexDecision(
  input: unknown,
): ValidationResult<ReflexDecision> {
  return validate(reflexDecisionSchema, input);
}

/** Strict: a partial assessment must never become an implicit allow. */
export function parseSemanticAssessment(
  input: unknown,
): ValidationResult<SemanticAssessment> {
  return validate(semanticAssessmentSchema, input);
}

/** Strict: feedback is an input to policy suggestions. */
export function parseDecisionFeedback(
  input: unknown,
): ValidationResult<DecisionFeedback> {
  return validate(decisionFeedbackSchema, input);
}

/** Strict: an outcome is an input to metrics and Approval Learning (ADR-013). */
export function parseActionOutcome(
  input: unknown,
): ValidationResult<ActionOutcome> {
  return validate(actionOutcomeSchema, input);
}

/** Strict: a record is training data and an audit trail (ADR-016 §4). */
export function parseDecisionRecord(
  input: unknown,
): ValidationResult<DecisionRecord> {
  return validate(decisionRecordSchema, input);
}

/** Strict: a summary is an input to storage (ADR-019 §4). */
export function parseDecisionSummary(
  input: unknown,
): ValidationResult<DecisionSummary> {
  return validate(decisionSummarySchema, input);
}

/** Strict: what a claimed installation uploads (ADR-019 §4). */
export function parseIngestRequest(
  input: unknown,
): ValidationResult<IngestRequest> {
  return validate(ingestRequestSchema, input);
}

/** Tolerant: the control plane's answer, read by older daemons. */
export function parseIngestResult(
  input: unknown,
): ValidationResult<IngestResult> {
  return validate(ingestResultSchema, input);
}

/** Strict: a claim links an installation to an organization (ADR-019 §3). */
export function parseClaimRequest(
  input: unknown,
): ValidationResult<ClaimRequest> {
  return validate(claimRequestSchema, input);
}

/** Tolerant: the control plane's answer, read by older CLIs. */
export function parseClaimResult(
  input: unknown,
): ValidationResult<ClaimResult> {
  return validate(claimResultSchema, input);
}
