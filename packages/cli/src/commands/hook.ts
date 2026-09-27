import {
  readHookInput,
  toObservationRecord,
  type ClaudeHookEvent,
} from "@reflex/adapter-claude-code/hook";
import { ObservationLog } from "@reflex/telemetry";

/**
 * RFX-086 — the Observe hook for Claude Code.
 *
 * One rule governs this file: **the hook never changes what the host does.**
 * In Observe, REFLEX may record and may not influence. Concretely:
 *
 * - it writes nothing to stdout, because stdout is how a hook answers the host
 *   (any JSON there could be read as a permission decision);
 * - it writes nothing to stderr, which the host may show to the user or feed
 *   back to the model;
 * - it always finishes normally. Exit code 2 would block the tool call, and
 *   any other non-zero code shows the user an error for something that is not
 *   their problem.
 *
 * So every failure in here (unreadable payload, full disk, a bug) ends the
 * same way as success: silently. What is lost is one observation.
 */
export interface HookDependencies {
  readonly log: Pick<ObservationLog, "append">;
  readonly now: () => Date;
}

/** Stdin is bounded by the host; this only guards against a runaway pipe. */
const MAX_STDIN_BYTES = 32 * 1024 * 1024;

export async function readStdin(
  stream: AsyncIterable<Buffer | string>,
): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > MAX_STDIN_BYTES) {
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type HookOutcome =
  | "recorded"
  | "nothing-to-record"
  | "unreadable-payload"
  | "record-failed"
  | "internal-error";

export interface HookResult {
  readonly outcome: HookOutcome;
  /** The event that was read, when one was, for the decision path (RFX-043). */
  readonly event?: ClaudeHookEvent;
}

/** Never throws. The return value exists for the decision path and tests. */
export async function runClaudeCodeHook(
  stdin: string | undefined,
  dependencies: HookDependencies,
): Promise<HookResult> {
  try {
    if (stdin === undefined) {
      return { outcome: "unreadable-payload" };
    }
    const input = readHookInput(stdin);
    if (!input.ok) {
      return { outcome: "unreadable-payload" };
    }
    const record = toObservationRecord(input.event, {
      now: dependencies.now,
    });
    if (record === undefined) {
      return { outcome: "nothing-to-record", event: input.event };
    }
    const appended = await dependencies.log.append(record);
    return {
      outcome: appended.ok ? "recorded" : "record-failed",
      event: input.event,
    };
  } catch {
    return { outcome: "internal-error" };
  }
}
