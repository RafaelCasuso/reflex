/**
 * @reflex/telemetry — what REFLEX observed, kept locally.
 *
 * In Gate G1.5 this is the local observation log, the argument shape (keys,
 * types and sizes, never values) and the pure assembly of `ActionOutcome`s
 * from host signals. Nothing in this package sends anything anywhere.
 */
export {
  DEFAULT_SHAPE_LIMITS,
  describeShape,
  type ArgumentShape,
  type ShapeLimits,
} from "./argument-shape.js";

export { assembleOutcomes } from "./assemble-outcomes.js";

export {
  ObservationLog,
  defaultObservationDirectory,
  type AppendResult,
  type ObservationLogOptions,
} from "./observation-log.js";

export {
  OUTCOME_SIGNALS,
  RECORD_VERSION,
  type ObservationRecord,
  type ObservedActionRecord,
  type OutcomeSignal,
  type OutcomeSignalRecord,
  type TurnEndedRecord,
} from "./records.js";
