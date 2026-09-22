/**
 * @reflex/telemetry — what REFLEX observed and decided, kept locally.
 *
 * The local observation log (G1.5), the argument shape (keys, types and
 * sizes, never values), the pure assembly of `ActionOutcome`s from host
 * signals, and since G3 the structured decision events (RFX-023). Nothing in
 * this package sends anything anywhere.
 */
export {
  DEFAULT_SHAPE_LIMITS,
  describeShape,
  type ArgumentShape,
  type ShapeLimits,
} from "./argument-shape.js";

export { assembleOutcomes } from "./assemble-outcomes.js";

export {
  DECISION_EVENT_VERSION,
  REJECTION_CODES,
  decisionEventsOf,
  rejectedRequestEvent,
  riskBucketOf,
  type DecisionEvent,
  type DecisionEventInput,
  type FallbackEvent,
  type RejectedRequestEvent,
  type RejectionCode,
  type RiskBucket,
  type TelemetryEvent,
  type TelemetrySink,
} from "./decision-events.js";

export {
  DecisionLog,
  defaultDecisionLogDirectory,
  type DecisionLogOptions,
} from "./decision-log.js";

export { RotatingJsonlLog, type RotatingLogOptions } from "./rotating-log.js";

export {
  ObservationLog,
  defaultObservationDirectory,
  type AppendResult,
  type ObservationLogOptions,
} from "./observation-log.js";

export {
  OUTCOME_SIGNALS,
  RECORD_VERSION,
  type HookMs,
  type ObservationRecord,
  type ObservedActionRecord,
  type OutcomeSignal,
  type OutcomeSignalRecord,
  type TurnEndedRecord,
} from "./records.js";
