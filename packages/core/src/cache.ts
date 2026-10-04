import type {
  Confidence,
  DecisionEffect,
  EnvironmentKind,
  PolicyMatch,
  ReasonCode,
  RiskScore,
  SemanticAssessment,
  SideEffectClass,
} from "@reflex-control/contracts";

/**
 * RFX-106 — the deterministic decision cache.
 *
 * A deterministic decision is a pure function of the action and the compiled
 * policy set, both of which are in the key (`decisionCacheKey`). So a hit is
 * the same decision the engine would make again, and a policy change misses
 * by construction. What is cached is the conclusion, never the action: no
 * argument, no operand, no path.
 *
 * `docs/architecture.md` §11 lists what is never blindly cached, and it is
 * honored here as well although a deterministic decision would be correct:
 * the cost of deciding such an action again is one policy evaluation, and
 * the classes on that list are the ones where a stale answer costs most.
 */
export interface CachedDecision {
  readonly effect: DecisionEffect;
  readonly risk: RiskScore;
  readonly confidence: Confidence;
  readonly reasonCodes: readonly ReasonCode[];
  readonly policyMatches: readonly PolicyMatch[];
  readonly policySetHash: string;
  readonly sideEffectClass: SideEffectClass;
  /** RFX-109: a semantic decision keeps its evidence. */
  readonly semanticAssessment?: SemanticAssessment;
}

export interface DecisionCacheOptions {
  readonly maxEntries: number;
  readonly ttlMs: number;
}

export const DEFAULT_CACHE_OPTIONS: DecisionCacheOptions = {
  maxEntries: 10_000,
  ttlMs: 10 * 60 * 1_000,
};

export const NEVER_CACHED_CLASSES: ReadonlySet<SideEffectClass> =
  new Set<SideEffectClass>([
    "destructive",
    "financial",
    "privilege",
    "credential",
    "external-write",
  ]);

export interface CacheabilityInput {
  readonly sideEffectClass: SideEffectClass;
  readonly environment: EnvironmentKind | undefined;
}

export function isCacheable(input: CacheabilityInput): boolean {
  return (
    !NEVER_CACHED_CLASSES.has(input.sideEffectClass) &&
    input.environment !== "production"
  );
}

/**
 * RFX-109 — semantic caching is allowed only for explicitly safe, repeatable
 * classes (`docs/architecture.md` §11): the classes whose assessment does
 * not change with the moment, and whose cost of being wrong twice is the
 * cost of being wrong once. Everything on the never-cached list stays out,
 * and so does `unknown`, because unknown is never safe.
 */
export const SEMANTIC_CACHEABLE_CLASSES: ReadonlySet<SideEffectClass> =
  new Set<SideEffectClass>([
    "none",
    "local-read",
    "local-write",
    "external-read",
  ]);

export function isSemanticCacheable(input: CacheabilityInput): boolean {
  return (
    SEMANTIC_CACHEABLE_CLASSES.has(input.sideEffectClass) &&
    input.environment !== "production"
  );
}

interface Entry {
  readonly value: CachedDecision;
  readonly expiresAt: number;
}

/** Least recently used, bounded, with a time to live. Clock is the caller's. */
export class DecisionCache {
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;

  constructor(options: DecisionCacheOptions = DEFAULT_CACHE_OPTIONS) {
    if (
      !Number.isInteger(options.maxEntries) ||
      options.maxEntries < 1 ||
      !(options.ttlMs > 0)
    ) {
      throw new RangeError("a decision cache needs a positive size and TTL");
    }
    this.#maxEntries = options.maxEntries;
    this.#ttlMs = options.ttlMs;
  }

  get(key: string, now: number): CachedDecision | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    // Most recently used goes last.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: CachedDecision, now: number): void {
    this.#entries.delete(key);
    if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) {
        this.#entries.delete(oldest.value);
      }
    }
    this.#entries.set(key, { value, expiresAt: now + this.#ttlMs });
  }

  flush(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
