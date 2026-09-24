import { SIDE_EFFECT_CLASSES } from "@reflex/contracts";
import { describe, expect, it } from "vitest";

import {
  DecisionCache,
  NEVER_CACHED_CLASSES,
  SEMANTIC_CACHEABLE_CLASSES,
  isCacheable,
  isSemanticCacheable,
  type CachedDecision,
} from "./cache.js";

const value = (effect: CachedDecision["effect"] = "allow"): CachedDecision => ({
  effect,
  risk: 5,
  confidence: 1,
  reasonCodes: ["explicit_allow"],
  policyMatches: [],
  policySetHash: "sha256:11",
  sideEffectClass: "local-read",
});

describe("RFX-106 decision cache", () => {
  it("returns what was put, until it expires", () => {
    const cache = new DecisionCache({ maxEntries: 10, ttlMs: 100 });
    cache.set("k", value(), 0);
    expect(cache.get("k", 50)).toEqual(value());
    expect(cache.get("k", 100)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry when full", () => {
    const cache = new DecisionCache({ maxEntries: 2, ttlMs: 1_000 });
    cache.set("a", value(), 0);
    cache.set("b", value(), 1);
    expect(cache.get("a", 2)).toBeDefined(); // a is now the most recent
    cache.set("c", value(), 3);
    expect(cache.get("b", 4)).toBeUndefined();
    expect(cache.get("a", 4)).toBeDefined();
    expect(cache.get("c", 4)).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it("replaces an entry under the same key", () => {
    const cache = new DecisionCache({ maxEntries: 2, ttlMs: 1_000 });
    cache.set("a", value("allow"), 0);
    cache.set("a", value("deny"), 1);
    expect(cache.get("a", 2)?.effect).toBe("deny");
    expect(cache.size).toBe(1);
  });

  it("is empty after a flush", () => {
    const cache = new DecisionCache({ maxEntries: 2, ttlMs: 1_000 });
    cache.set("a", value(), 0);
    cache.flush();
    expect(cache.get("a", 1)).toBeUndefined();
  });

  it("keeps exactly one entry when told to", () => {
    const cache = new DecisionCache({ maxEntries: 1, ttlMs: 1_000 });
    cache.set("a", value(), 0);
    cache.set("b", value(), 1);
    expect(cache.size).toBe(1);
    expect(cache.get("a", 2)).toBeUndefined();
    expect(cache.get("b", 2)).toBeDefined();
  });

  it("refuses a size or a TTL that would keep nothing", () => {
    expect(() => new DecisionCache({ maxEntries: 0, ttlMs: 1 })).toThrow(
      RangeError,
    );
    expect(() => new DecisionCache({ maxEntries: 1, ttlMs: 0 })).toThrow(
      RangeError,
    );
  });
});

describe("what is never cached (architecture §11)", () => {
  it("names the classes on the list and nothing else", () => {
    expect([...NEVER_CACHED_CLASSES].sort()).toEqual([
      "credential",
      "destructive",
      "external-write",
      "financial",
      "privilege",
    ]);
    for (const sideEffectClass of SIDE_EFFECT_CLASSES) {
      expect(isCacheable({ sideEffectClass, environment: undefined })).toBe(
        !NEVER_CACHED_CLASSES.has(sideEffectClass),
      );
    }
  });

  it("never caches a production change, whatever the class", () => {
    for (const sideEffectClass of SIDE_EFFECT_CLASSES) {
      expect(isCacheable({ sideEffectClass, environment: "production" })).toBe(
        false,
      );
    }
    expect(
      isCacheable({ sideEffectClass: "local-read", environment: "local" }),
    ).toBe(true);
  });
});

describe("what a semantic decision may be cached for (RFX-109)", () => {
  it("is the safe, repeatable classes and nothing on the never-cached list", () => {
    expect([...SEMANTIC_CACHEABLE_CLASSES].sort()).toEqual([
      "external-read",
      "local-read",
      "local-write",
      "none",
    ]);
    for (const sideEffectClass of SIDE_EFFECT_CLASSES) {
      expect(
        isSemanticCacheable({ sideEffectClass, environment: undefined }),
      ).toBe(SEMANTIC_CACHEABLE_CLASSES.has(sideEffectClass));
      expect(
        isSemanticCacheable({ sideEffectClass, environment: "production" }),
      ).toBe(false);
      if (NEVER_CACHED_CLASSES.has(sideEffectClass)) {
        expect(SEMANTIC_CACHEABLE_CLASSES.has(sideEffectClass)).toBe(false);
      }
    }
    expect(SEMANTIC_CACHEABLE_CLASSES.has("unknown")).toBe(false);
  });
});
