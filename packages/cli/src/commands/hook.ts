import * as claude from "@reflex-control/adapter-claude-code/hook";
import * as codex from "@reflex-control/adapter-codex/hook";
import type {
  ObservationLog,
  ObservationRecord,
} from "@reflex-control/telemetry";

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

export interface HookResult<Event> {
  readonly outcome: HookOutcome;
  /** The event that was read, when one was, for the decision path (RFX-043). */
  readonly event?: Event;
}

/** What a host's hot-path entry gives the runner: a reader and a recorder. */
export interface HostHook<Event> {
  readonly read: (
    stdin: string,
  ) =>
    | { readonly ok: true; readonly event: Event }
    | { readonly ok: false; readonly reason: string };
  readonly record: (
    event: Event,
    context: { readonly now: () => Date },
  ) => ObservationRecord | undefined;
  /**
   * G8: whether an event should be recorded at all. A user-scoped hook
   * fires in every project; Codex keeps to the projects REFLEX was
   * installed in. Absent means everything is recorded.
   */
  readonly accepts?: (event: Event) => boolean;
}

/** Never throws. The return value exists for the decision path and tests. */
export async function runObserveHook<Event>(
  host: HostHook<Event>,
  stdin: string | undefined,
  dependencies: HookDependencies,
): Promise<HookResult<Event>> {
  try {
    if (stdin === undefined) {
      return { outcome: "unreadable-payload" };
    }
    const input = host.read(stdin);
    if (!input.ok) {
      return { outcome: "unreadable-payload" };
    }
    if (host.accepts !== undefined && !host.accepts(input.event)) {
      return { outcome: "nothing-to-record" };
    }
    const record = host.record(input.event, { now: dependencies.now });
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

export const CLAUDE_CODE_HOOK: HostHook<claude.ClaudeHookEvent> = {
  read: claude.readHookInput,
  record: claude.toObservationRecord,
};

export function codexHook(
  accepts: (event: codex.CodexHookEvent) => boolean,
): HostHook<codex.CodexHookEvent> {
  return {
    read: codex.readHookInput,
    record: codex.toObservationRecord,
    accepts,
  };
}

export function runClaudeCodeHook(
  stdin: string | undefined,
  dependencies: HookDependencies,
): Promise<HookResult<claude.ClaudeHookEvent>> {
  return runObserveHook(CLAUDE_CODE_HOOK, stdin, dependencies);
}
