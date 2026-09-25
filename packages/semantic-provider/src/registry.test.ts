import { describe, expect, it } from "vitest";

import { FAKE_MODEL } from "./fake.js";
import { providerError, type SemanticDecisionProvider } from "./provider.js";
import {
  PROVIDER_IDS,
  createProviderRegistry,
  fakeProviderConstructor,
  isProviderId,
  type ProviderConfig,
} from "./registry.js";

const stub = (name: string): SemanticDecisionProvider => ({
  providerName: name,
  model: `${name}-1.0.0`,
  evaluate: () =>
    Promise.resolve({
      ok: false,
      error: providerError("unavailable", name, 0),
    }),
});

describe("RFX-141 the provider registry", () => {
  it("knows the ids of ADR-016 and nothing else", () => {
    expect(PROVIDER_IDS).toEqual(["none", "jev", "local", "reflex", "fake"]);
    expect(isProviderId("jev")).toBe(true);
    expect(isProviderId("none")).toBe(true);
    expect(isProviderId("openai")).toBe(false);
    expect(isProviderId("")).toBe(false);
    expect(isProviderId("JEV")).toBe(false);
  });

  it("lists what was registered, in the vocabulary's order, and builds it", () => {
    const seen: ProviderConfig[] = [];
    const registry = createProviderRegistry({
      fake: fakeProviderConstructor,
      jev: (config) => {
        seen.push(config);
        return { ok: true, provider: stub("jev") };
      },
    });
    expect(registry.available).toEqual(["jev", "fake"]);
    const built = registry.create({
      id: "jev",
      model: "jev-1.13.0",
      apiKey: "k",
    });
    expect(built.ok).toBe(true);
    expect(seen).toEqual([{ id: "jev", model: "jev-1.13.0", apiKey: "k" }]);
  });

  it("refuses an id nobody registered, naming what is available", () => {
    const registry = createProviderRegistry({ fake: fakeProviderConstructor });
    const built = registry.create({ id: "local" });
    expect(built).toEqual({
      ok: false,
      reason: expect.stringContaining('"local" is not available') as string,
    });
    if (!built.ok) {
      expect(built.reason).toContain("available: fake");
    }
    const empty = createProviderRegistry({});
    expect(empty.available).toEqual([]);
    const none = empty.create({ id: "jev" });
    expect(none.ok).toBe(false);
    if (!none.ok) {
      expect(none.reason).toContain("available: none");
    }
  });

  it("turns a constructor that throws into a reason, without the configuration in it", () => {
    const registry = createProviderRegistry({
      jev: () => {
        throw new RangeError("pin a versioned model");
      },
    });
    const built = registry.create({ id: "jev", apiKey: "secret-key-value" });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.reason).toContain("pin a versioned model");
      expect(built.reason).not.toContain("secret-key-value");
    }
  });

  it("builds the fake with its one model, and refuses another", () => {
    const built = fakeProviderConstructor({ id: "fake" });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.provider.providerName).toBe("fake");
      expect(built.provider.model).toBe(FAKE_MODEL);
    }
    expect(fakeProviderConstructor({ id: "fake", model: "fake-2" })).toEqual({
      ok: false,
      reason: expect.stringContaining(FAKE_MODEL) as string,
    });
  });
});
