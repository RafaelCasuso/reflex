import type {
  ActionId,
  CanonicalAction,
  PriorActionSummary,
  SessionId,
} from "@reflex/contracts";

/**
 * RFX-032 — the relevant-history selector, and a bounded memory to select
 * from.
 *
 * What a provider needs about the past is small: what the agent did just
 * before, and what it did before to the same tool or the same thing. The
 * selector takes the session's history and keeps the most recent items and
 * the most related ones, within a bound that does not grow with the
 * session. The memory it selects from is bounded too, per session and
 * overall, so a session that runs for a day costs what a session that runs
 * for a minute costs.
 */
export interface HistoryLimits {
  /** Items handed to the provider. */
  readonly maxItems: number;
  /** Of which, the most recent regardless of relevance. */
  readonly recentItems: number;
  /** Older than this is not relevant, whatever it touched. */
  readonly maxAgeMs: number;
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
  maxItems: 8,
  recentItems: 3,
  maxAgeMs: 30 * 60 * 1_000,
};

export interface HistoryEntry extends PriorActionSummary {
  readonly toolNamespace?: string;
  /** What the action touched, as the adapter or the classifier saw it. */
  readonly resource?: string;
}

/** Newest last, as they happened. */
export function selectRelevantHistory(
  history: readonly HistoryEntry[],
  current: CanonicalAction,
  now: Date,
  limits: HistoryLimits = DEFAULT_HISTORY_LIMITS,
): readonly PriorActionSummary[] {
  const cutoff = now.getTime() - limits.maxAgeMs;
  const fresh = history.filter(
    (entry) => Date.parse(entry.occurredAt) >= cutoff,
  );
  const recent = fresh.slice(-limits.recentItems);
  const recentSet = new Set(recent);
  const resource = current.resource?.identifier ?? current.operands?.paths?.[0];
  const related = fresh.filter(
    (entry) =>
      !recentSet.has(entry) &&
      (entry.toolName === current.tool.name ||
        (entry.toolNamespace !== undefined &&
          entry.toolNamespace === current.tool.namespace) ||
        (resource !== undefined && entry.resource === resource)),
  );
  const selected = [
    ...related.slice(-(limits.maxItems - recent.length)),
    ...recent,
  ]
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
    .slice(-limits.maxItems);
  return selected.map((entry) => ({
    ...(entry.actionId === undefined ? {} : { actionId: entry.actionId }),
    toolName: entry.toolName,
    ...(entry.operation === undefined ? {} : { operation: entry.operation }),
    ...(entry.effect === undefined ? {} : { effect: entry.effect }),
    occurredAt: entry.occurredAt,
  }));
}

export interface MemoryLimits {
  readonly maxSessions: number;
  readonly maxPerSession: number;
  readonly sessionTtlMs: number;
}

export const DEFAULT_MEMORY_LIMITS: MemoryLimits = {
  maxSessions: 1_000,
  maxPerSession: 200,
  sessionTtlMs: 6 * 60 * 60 * 1_000,
};

interface Session {
  entries: HistoryEntry[];
  touchedAt: number;
}

/** In memory, bounded, no I/O. The daemon owns one. */
export class SessionMemory {
  readonly #sessions = new Map<SessionId, Session>();
  readonly #limits: MemoryLimits;

  constructor(limits: MemoryLimits = DEFAULT_MEMORY_LIMITS) {
    if (
      !(limits.maxSessions >= 1) ||
      !(limits.maxPerSession >= 1) ||
      !(limits.sessionTtlMs > 0)
    ) {
      throw new RangeError("session memory needs positive limits");
    }
    this.#limits = limits;
  }

  remember(sessionId: SessionId, entry: HistoryEntry, now: number): void {
    let session = this.#sessions.get(sessionId);
    if (session === undefined) {
      this.#evict(now);
      session = { entries: [], touchedAt: now };
    } else {
      this.#sessions.delete(sessionId);
    }
    session.entries.push(entry);
    if (session.entries.length > this.#limits.maxPerSession) {
      session.entries.splice(
        0,
        session.entries.length - this.#limits.maxPerSession,
      );
    }
    session.touchedAt = now;
    this.#sessions.set(sessionId, session);
  }

  recall(sessionId: SessionId, now: number): readonly HistoryEntry[] {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      return [];
    }
    if (now - session.touchedAt > this.#limits.sessionTtlMs) {
      this.#sessions.delete(sessionId);
      return [];
    }
    return session.entries;
  }

  #evict(now: number): void {
    for (const [id, session] of this.#sessions) {
      if (now - session.touchedAt > this.#limits.sessionTtlMs) {
        this.#sessions.delete(id);
      }
    }
    while (this.#sessions.size >= this.#limits.maxSessions) {
      const oldest = this.#sessions.keys().next();
      if (oldest.done) {
        break;
      }
      this.#sessions.delete(oldest.value);
    }
  }

  get sessions(): number {
    return this.#sessions.size;
  }
}

export function historyEntryOf(
  action: CanonicalAction,
  effect: PriorActionSummary["effect"],
  actionId: ActionId = action.id,
): HistoryEntry {
  const resource = action.resource?.identifier ?? action.operands?.paths?.[0];
  return {
    actionId,
    toolName: action.tool.name,
    ...(action.tool.namespace === undefined
      ? {}
      : { toolNamespace: action.tool.namespace }),
    ...(action.operation === undefined ? {} : { operation: action.operation }),
    ...(effect === undefined ? {} : { effect }),
    ...(resource === undefined ? {} : { resource }),
    occurredAt: action.createdAt,
  };
}
