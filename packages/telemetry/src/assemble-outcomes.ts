import type {
  ActionOutcome,
  HumanResponse,
  ObservationState,
} from "@reflex/contracts";

import type { ObservationRecord, OutcomeSignal } from "./records.js";

/**
 * Turns the signals recorded for each action into one `ActionOutcome`
 * (ADR-013). Pure: records in, outcomes out.
 *
 * Every rule below is an implication, not a guess. Where the records do not
 * imply an answer the field is `unknown`, and `unknown` is never read as `no`.
 *
 * | Observed                                        | prompted | humanResponse | executed |
 * | ----------------------------------------------- | -------- | ------------- | -------- |
 * | executed, no prompt seen                        | no       | none          | yes      |
 * | prompt seen, then executed                      | yes      | approved      | yes      |
 * | prompt seen, turn ended, never executed         | yes      | rejected      | no       |
 * | prompt seen, nothing after it yet               | yes      | unknown       | unknown  |
 * | host refused the call itself                    | no       | none          | no       |
 * | host reported a failure                         | (as above) | (as above)  | unknown  |
 * | the action alone, nothing else                  | unknown  | unknown       | unknown  |
 *
 * "failed" leaves `executed` unknown on purpose: whether a failed call ran far
 * enough to have a side effect is not something the signal tells us.
 *
 * "no prompt seen" means `no` only because the adapter subscribes to the
 * host's permission event for every tool: a completed call with no such event
 * was not prompted. An action with no completion signal at all stays unknown.
 */
export function assembleOutcomes(
  records: readonly ObservationRecord[],
): ActionOutcome[] {
  const outcomes: ActionOutcome[] = [];

  for (const [index, record] of records.entries()) {
    if (record.kind !== "action") {
      continue;
    }
    const later = records.slice(index + 1);
    const signals = new Set<OutcomeSignal>();
    let observedAt = record.recordedAt;

    for (const candidate of later) {
      if (
        candidate.kind === "signal" &&
        candidate.actionId === record.actionId
      ) {
        signals.add(candidate.signal);
        observedAt = candidate.recordedAt;
      }
    }

    const turnEnded = later.find(
      (candidate) =>
        candidate.kind === "turn-ended" &&
        candidate.sessionId !== undefined &&
        candidate.sessionId === record.sessionId,
    );

    const prompted = signals.has("permission-requested");
    const completed =
      signals.has("executed") ||
      signals.has("failed") ||
      signals.has("denied-by-host");
    const endedWithoutRunning =
      prompted && !completed && turnEnded !== undefined;
    if (endedWithoutRunning) {
      observedAt = turnEnded.recordedAt;
    }

    const promptedState: ObservationState = prompted
      ? "yes"
      : completed
        ? "no"
        : "unknown";

    const executed: ObservationState = signals.has("executed")
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

    outcomes.push({
      actionId: record.actionId,
      prompted: promptedState,
      humanResponse,
      executed,
      observedAt,
    });
  }

  return outcomes;
}
