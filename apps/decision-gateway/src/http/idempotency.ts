import type { ActionId, ReflexDecision } from "@reflex/contracts";

/**
 * RFX-120 — a retried request is decided once.
 *
 * Keyed by `action.id`. The same id with the same content returns the same
 * decision, byte for byte, and is not counted again; the same id with
 * different content is a conflict, not a new decision. Content is the
 * engine's fingerprint of the action together with the mode and the
 * requested failure mode; the deadline is left out, because a retry has
 * less of it.
 */
export interface IdempotencyOptions {
  readonly ttlMs: number;
  readonly maxEntries: number;
}

export const DEFAULT_IDEMPOTENCY: IdempotencyOptions = {
  ttlMs: 10 * 60 * 1_000,
  maxEntries: 10_000,
};

interface Entry {
  readonly contentHash: string;
  readonly decision: ReflexDecision;
  readonly expiresAt: number;
}

export type IdempotencyLookup =
  | { readonly kind: "new" }
  | { readonly kind: "replay"; readonly decision: ReflexDecision }
  | { readonly kind: "conflict" };

export class IdempotencyStore {
  readonly #entries = new Map<ActionId, Entry>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;

  constructor(options: IdempotencyOptions = DEFAULT_IDEMPOTENCY) {
    if (!(options.ttlMs > 0) || !(options.maxEntries >= 1)) {
      throw new RangeError(
        "an idempotency store needs a positive TTL and size",
      );
    }
    this.#ttlMs = options.ttlMs;
    this.#maxEntries = options.maxEntries;
  }

  lookup(
    actionId: ActionId,
    contentHash: string,
    now: number,
  ): IdempotencyLookup {
    const entry = this.#entries.get(actionId);
    if (entry === undefined) {
      return { kind: "new" };
    }
    if (entry.expiresAt <= now) {
      this.#entries.delete(actionId);
      return { kind: "new" };
    }
    return entry.contentHash === contentHash
      ? { kind: "replay", decision: entry.decision }
      : { kind: "conflict" };
  }

  remember(
    actionId: ActionId,
    contentHash: string,
    decision: ReflexDecision,
    now: number,
  ): void {
    this.#entries.delete(actionId);
    if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) {
        this.#entries.delete(oldest.value);
      }
    }
    this.#entries.set(actionId, {
      contentHash,
      decision,
      expiresAt: now + this.#ttlMs,
    });
  }

  get size(): number {
    return this.#entries.size;
  }
}
