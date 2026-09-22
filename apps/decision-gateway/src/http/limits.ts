/**
 * RFX-119 — what one caller can cost the gateway.
 *
 * Both limits act before any validation or decision work: the rate limit on
 * arrival, the size limit before the body is read. State is in memory and
 * bounded. Losing it (a restart, an eviction) starts a caller over with a
 * full burst, which is a bounded over-allowance and never a disabled limit;
 * and a limiter that cannot answer limits, because REFLEX failing must never
 * widen what a caller can do.
 */
export interface RateLimitOptions {
  /** Requests a caller may make at once, from rest. */
  readonly burst: number;
  /** Requests per second a caller may sustain. */
  readonly perSecond: number;
  /** Callers remembered at once. The least recently seen is forgotten first. */
  readonly maxCallers?: number;
}

export type RateLimitVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const DEFAULT_MAX_CALLERS = 10_000;

/** A token bucket per caller. The clock is the caller's, in milliseconds. */
export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #burst: number;
  readonly #perMs: number;
  readonly #maxCallers: number;

  constructor(options: RateLimitOptions) {
    if (
      !(options.burst >= 1) ||
      !(options.perSecond > 0) ||
      !((options.maxCallers ?? DEFAULT_MAX_CALLERS) >= 1)
    ) {
      throw new RangeError("a rate limit needs a positive burst and rate");
    }
    this.#burst = options.burst;
    this.#perMs = options.perSecond / 1_000;
    this.#maxCallers = options.maxCallers ?? DEFAULT_MAX_CALLERS;
  }

  take(caller: string, now: number): RateLimitVerdict {
    let bucket = this.#buckets.get(caller);
    if (bucket === undefined) {
      if (this.#buckets.size >= this.#maxCallers) {
        const oldest = this.#buckets.keys().next();
        if (!oldest.done) {
          this.#buckets.delete(oldest.value);
        }
      }
      bucket = { tokens: this.#burst, updatedAt: now };
    } else {
      this.#buckets.delete(caller);
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(
        this.#burst,
        bucket.tokens + elapsed * this.#perMs,
      );
      bucket.updatedAt = now;
    }
    // Most recently seen goes last.
    this.#buckets.set(caller, bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    const waitMs = (1 - bucket.tokens) / this.#perMs;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1_000)),
    };
  }

  /** What a flush looks like to the limiter: every caller starts over. */
  reset(): void {
    this.#buckets.clear();
  }

  get callers(): number {
    return this.#buckets.size;
  }
}
