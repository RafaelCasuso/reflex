import type {
  ActionId,
  HostKind,
  IsoTimestamp,
  SessionId,
  SideEffectClass,
} from "@reflex/contracts";

import type { ArgumentShape } from "./argument-shape.js";

/**
 * Records of the local observation log.
 *
 * This is a local file format, not a wire contract: in G1.5 nothing leaves the
 * machine. It deliberately has no field that could hold an argument value, a
 * tool output, a user objective or a transcript.
 */
export const RECORD_VERSION = 1;

/**
 * Milliseconds the hook process had been alive when it built the record, as
 * measured from inside it. A lower bound on what the host waited: it cannot
 * see the time the operating system took to start the process.
 */
export type HookMs = number;

export interface ObservedActionRecord {
  readonly kind: "action";
  readonly recordVersion: typeof RECORD_VERSION;
  readonly recordedAt: IsoTimestamp;
  readonly hookMs?: HookMs;

  readonly actionId: ActionId;
  readonly sessionId?: SessionId;
  readonly host: HostKind;
  readonly hostVersion?: string;
  readonly toolName: string;
  readonly toolNamespace?: string;
  readonly operation?: string;
  readonly sideEffectClass: SideEffectClass;
  /** Where the agent was working. Context, not an argument. */
  readonly projectRoot?: string;
  readonly createdAt: IsoTimestamp;

  /** Keys, types and sizes. Never a value (RFX-086). */
  readonly argumentShape: ArgumentShape;
}

/**
 * What the host was seen doing, in host-agnostic terms. Adapters map their own
 * events onto these; `assembleOutcomes` turns them into `ActionOutcome`s.
 */
export const OUTCOME_SIGNALS = [
  /** The host is about to show its native approval prompt. */
  "permission-requested",
  /** The tool call completed. */
  "executed",
  /** The host reported that the tool call failed. */
  "failed",
  /** The host itself refused the call, without asking the human. */
  "denied-by-host",
] as const;
export type OutcomeSignal = (typeof OUTCOME_SIGNALS)[number];

export interface OutcomeSignalRecord {
  readonly kind: "signal";
  readonly recordVersion: typeof RECORD_VERSION;
  readonly recordedAt: IsoTimestamp;
  readonly hookMs?: HookMs;
  readonly actionId: ActionId;
  readonly sessionId?: SessionId;
  readonly signal: OutcomeSignal;
}

/** The agent's turn ended. Session-level: it names no action. */
export interface TurnEndedRecord {
  readonly kind: "turn-ended";
  readonly recordVersion: typeof RECORD_VERSION;
  readonly recordedAt: IsoTimestamp;
  readonly sessionId?: SessionId;
}

export type ObservationRecord =
  ObservedActionRecord | OutcomeSignalRecord | TurnEndedRecord;
