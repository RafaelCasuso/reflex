import type {
  ActionOutcome,
  HumanResponse,
  ObservationState,
} from "@reflex-control/contracts";

import type {
  ObservationRecord,
  ObservedActionRecord,
  OutcomeSignal,
  OutcomeSignalRecord,
} from "./records.js";

/**
 * Turns the signals recorded for each action into one `ActionOutcome`
 * (ADR-013). Pure: records in, outcomes out.
 *
 * Every rule below is an implication, not a guess. Where the records do not
 * imply an answer the field is `unknown`, and `unknown` is never read as `no`.
 *
 * | Observed                                   | prompted | humanResponse | executed |
 * | ------------------------------------------ | -------- | ------------- | -------- |
 * | executed, no prompt seen                   | no       | none          | yes      |
 * | prompt seen, then executed                 | yes      | approved      | yes      |
 * | prompt seen, turn ended, never executed    | yes      | rejected      | no       |
 * | prompt seen, nothing after it yet          | yes      | unknown       | unknown  |
 * | host refused the call itself               | no       | none          | no       |
 * | host reported a failure                    | as above | as above      | yes      |
 * | the action alone, nothing else             | unknown  | unknown       | unknown  |
 *
 * The rows were checked against a live host (RFX-087, Claude Code 2.1.276):
 *
 * - **A reported failure means the tool ran.** `PostToolUseFailure` fired for
 *   a command that executed and exited non-zero, and for no refused call. Its
 *   side effects may have happened, so `executed` is `yes`.
 * - **A call that is not approved leaves no completion event.** The host fires
 *   the permission event, then nothing, then the end of the turn. That is the
 *   only trace of a refusal, hence the third row.
 * - **"No prompt seen" means `no`** only because the adapter subscribes to the
 *   host's permission event for every tool: a completed call with no such
 *   event was not prompted. With no completion signal at all it stays unknown.
 *
 * ## Signals without an action
 *
 * The host's permission event does not say which call it is about. Such a
 * signal is attributed to the most recent action of the same session and the
 * same tool that has not been prompted and has not completed. Nothing derived
 * from the arguments takes part. Two identical-tool calls running in parallel
 * can therefore swap a prompt between them; counts stay right, and a signal
 * with no plausible owner is dropped, never forced onto an action.
 */
interface Pending {
  readonly action: ObservedActionRecord;
  readonly signals: Set<OutcomeSignal>;
  observedAt: string;
  turnEndedAt: string | undefined;
}

const COMPLETIONS: readonly OutcomeSignal[] = [
  "executed",
  "failed",
  "denied-by-host",
];

const isComplete = (pending: Pending): boolean =>
  COMPLETIONS.some((signal) => pending.signals.has(signal));

function ownerOf(
  pendings: readonly Pending[],
  record: OutcomeSignalRecord,
): Pending | undefined {
  if (record.actionId !== undefined) {
    return pendings.findLast(
      (pending) => pending.action.actionId === record.actionId,
    );
  }
  if (record.sessionId === undefined || record.toolName === undefined) {
    return undefined;
  }
  return pendings.findLast(
    (pending) =>
      pending.action.sessionId === record.sessionId &&
      pending.action.toolName === record.toolName &&
      pending.action.toolNamespace === record.toolNamespace &&
      !pending.signals.has(record.signal) &&
      !isComplete(pending) &&
      pending.turnEndedAt === undefined,
  );
}

export function assembleOutcomes(
  records: readonly ObservationRecord[],
): ActionOutcome[] {
  const pendings: Pending[] = [];

  for (const record of records) {
    switch (record.kind) {
      case "action":
        pendings.push({
          action: record,
          signals: new Set(),
          observedAt: record.recordedAt,
          turnEndedAt: undefined,
        });
        break;

      case "signal": {
        // Only an action recorded earlier can own a signal.
        const owner = ownerOf(pendings, record);
        if (owner !== undefined) {
          owner.signals.add(record.signal);
          owner.observedAt = record.recordedAt;
        }
        break;
      }

      case "turn-ended":
        if (record.sessionId === undefined) {
          break;
        }
        for (const pending of pendings) {
          if (
            pending.action.sessionId === record.sessionId &&
            pending.turnEndedAt === undefined &&
            !isComplete(pending)
          ) {
            pending.turnEndedAt = record.recordedAt;
          }
        }
        break;
    }
  }

  return pendings.map((pending) => {
    const { signals } = pending;
    const prompted = signals.has("permission-requested");
    const complete = isComplete(pending);
    const endedWithoutRunning =
      prompted && !complete && pending.turnEndedAt !== undefined;

    const promptedState: ObservationState = prompted
      ? "yes"
      : complete
        ? "no"
        : "unknown";

    const executed: ObservationState =
      signals.has("executed") || signals.has("failed")
        ? "yes"
        : signals.has("denied-by-host") || endedWithoutRunning
          ? "no"
          : "unknown";

    let humanResponse: HumanResponse;
    switch (promptedState) {
      case "no":
        humanResponse = "none";
        break;
      case "unknown":
        humanResponse = "unknown";
        break;
      case "yes":
        humanResponse =
          executed === "yes"
            ? "approved"
            : endedWithoutRunning
              ? "rejected"
              : "unknown";
        break;
    }

    return {
      actionId: pending.action.actionId,
      prompted: promptedState,
      humanResponse,
      executed,
      observedAt:
        endedWithoutRunning && pending.turnEndedAt !== undefined
          ? pending.turnEndedAt
          : pending.observedAt,
    };
  });
}
