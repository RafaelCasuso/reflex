import { FAKE_MODEL, createFakeProvider } from "./fake.js";
import type { SemanticDecisionProvider } from "./provider.js";

/**
 * RFX-141 — the provider registry (ADR-016 §1).
 *
 * A provider is chosen by id, in configuration, and built from a
 * constructor this registry maps the id to. The ids are the vocabulary of
 * ADR-016; which of them a build can construct is what the composition
 * root registers (the daemon registers `jev`; `local` comes with RFX-144
 * and `reflex` with G14). `none` is not a provider: it is the absence of
 * a semantic stage, today's behavior and the default.
 *
 * The registry never logs a configuration: it may carry a key.
 */
export const PROVIDER_IDS = ["none", "jev", "local", "reflex", "fake"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
/** Every id but `none`: the ones a constructor can be registered for. */
export type ConfigurableProviderId = Exclude<ProviderId, "none">;

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export interface ProviderConfig {
  readonly id: ConfigurableProviderId;
  /** A versioned model, when the provider takes one; its default otherwise. */
  readonly model?: string;
  /** Where to reach it, when the provider takes one. */
  readonly endpoint?: string;
  /** Read by the caller from its environment. Never written anywhere. */
  readonly apiKey?: string;
}

export type ProviderConstruction =
  | { readonly ok: true; readonly provider: SemanticDecisionProvider }
  | { readonly ok: false; readonly reason: string };

export type ProviderConstructor = (
  config: ProviderConfig,
) => ProviderConstruction;

export interface ProviderRegistry {
  /** The ids this build can construct, in the order of `PROVIDER_IDS`. */
  readonly available: readonly ConfigurableProviderId[];
  create(config: ProviderConfig): ProviderConstruction;
}

export function createProviderRegistry(
  constructors: Partial<
    Readonly<Record<ConfigurableProviderId, ProviderConstructor>>
  >,
): ProviderRegistry {
  const available = PROVIDER_IDS.filter(
    (id): id is ConfigurableProviderId =>
      id !== "none" && constructors[id] !== undefined,
  );
  return {
    available,
    create(config) {
      const construct = constructors[config.id];
      if (construct === undefined) {
        return {
          ok: false,
          reason: `the semantic provider "${config.id}" is not available in this build (available: ${available.length === 0 ? "none" : available.join(", ")})`,
        };
      }
      try {
        return construct(config);
      } catch (error: unknown) {
        // A constructor that throws is a bug in the constructor; the daemon
        // still needs a reason it can print without the configuration.
        return {
          ok: false,
          reason: `the semantic provider "${config.id}" could not be built: ${error instanceof Error ? error.message : "unknown error"}`,
        };
      }
    },
  };
}

/** The fake (RFX-029), for development and tests: it answers from the class. */
export const fakeProviderConstructor: ProviderConstructor = (config) => {
  if (config.model !== undefined && config.model !== FAKE_MODEL) {
    return {
      ok: false,
      reason: `the fake provider has one model, ${FAKE_MODEL}`,
    };
  }
  return { ok: true, provider: createFakeProvider() };
};
