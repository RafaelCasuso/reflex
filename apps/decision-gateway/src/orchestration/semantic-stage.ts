import {
  createContextCompiler,
  createRedactor,
} from "@reflex/context-compiler";
import {
  createRiskAggregator,
  type SemanticStage,
  type ShadowProvider,
  type ShadowSample,
} from "@reflex/core";
import { JEV_DEFAULT_MODEL, createJevProvider } from "@reflex/provider-jev";
import {
  LOCAL_DEFAULT_ENDPOINT,
  createLocalProvider,
  isLoopbackEndpoint,
} from "@reflex/provider-local";
import {
  consentCovers,
  createProviderRegistry,
  fakeProviderConstructor,
  isRemoteProvider,
  type ConsentRecord,
  type ProviderId,
  type ProviderRegistry,
} from "@reflex/semantic-provider";

/**
 * RFX-141 — the semantic stage the daemon runs, built from configuration
 * (ADR-016 §1).
 *
 * The daemon is the composition root: it registers the providers this
 * build ships and assembles the stage of ADR-002 (the compiler with the
 * installation's redactor, the provider, the aggregator) or none. A key is
 * read from the environment here, given to the provider, and written
 * nowhere: not in health, not in a reason, not in a log.
 */
export const JEV_API_KEY_VARIABLE = "TYPESAFE_API_KEY";
/** CLAUDE.md principle 9: the median semantic input stays under this. */
export const SEMANTIC_MAX_INPUT_TOKENS = 600;

const ALIAS = /latest|preview/;

/** What this build can construct. `reflex` is G14. */
export function gatewayProviderRegistry(): ProviderRegistry {
  return createProviderRegistry({
    local: (config) => {
      if (config.model === undefined || config.model === "") {
        return {
          ok: false,
          reason:
            "the local provider needs --semantic-model, pinned to the checkpoint the server serves",
        };
      }
      if (ALIAS.test(config.model)) {
        return {
          ok: false,
          reason: `pin the local checkpoint to a version, never an alias: "${config.model}"`,
        };
      }
      const endpoint = config.endpoint ?? LOCAL_DEFAULT_ENDPOINT;
      if (!isLoopbackEndpoint(endpoint)) {
        return {
          ok: false,
          reason:
            "the local provider talks to this machine only: --semantic-endpoint must be on 127.0.0.1, ::1 or localhost",
        };
      }
      return {
        ok: true,
        provider: createLocalProvider({ model: config.model, endpoint }),
      };
    },
    jev: (config) => {
      if (config.apiKey === undefined || config.apiKey === "") {
        return {
          ok: false,
          reason: `the jev provider needs an API key in ${JEV_API_KEY_VARIABLE}`,
        };
      }
      const model = config.model ?? JEV_DEFAULT_MODEL;
      if (ALIAS.test(model)) {
        return {
          ok: false,
          reason: `pin a versioned Jev model, never an alias: "${model}"`,
        };
      }
      return {
        ok: true,
        provider: createJevProvider({
          apiKey: config.apiKey,
          model,
          ...(config.endpoint === undefined
            ? {}
            : { endpoint: config.endpoint }),
        }),
      };
    },
    fake: fakeProviderConstructor,
  });
}

/** What `GET /v1/health` says about the stage. Never a key, never an endpoint. */
export type SemanticProviderDescription =
  | { readonly id: "none" }
  | {
      readonly id: Exclude<ProviderId, "none">;
      readonly name: string;
      /** Pinned, never an alias (ADR-016 §1). */
      readonly model: string | undefined;
    };

/** RFX-142: a shadow, by id. It gets the same model and endpoint rules. */
export interface ShadowConfiguration {
  readonly id: Exclude<ProviderId, "none">;
  readonly model?: string;
  readonly endpoint?: string;
}

export interface SemanticStageBuildOptions {
  readonly id: ProviderId;
  readonly model: string | undefined;
  readonly endpoint: string | undefined;
  /** The installation's redaction key (ADR-006 §4). */
  readonly redactionKey: Uint8Array;
  readonly env: NodeJS.ProcessEnv;
  readonly registry?: ProviderRegistry;
  readonly clock?: () => Date;
  /** RFX-142. Empty or absent means none. */
  readonly shadows?: readonly ShadowConfiguration[];
  readonly shadowDeadlineMs?: number;
  readonly shadowSample?: ShadowSample;
  /**
   * RFX-123: the consent the user gave, read by the daemon's caller. A
   * remote provider, primary or shadow, is built only when a consent
   * covers it; nothing is uploaded before.
   */
  readonly consent?: ConsentRecord;
}

export type ShadowDescription = Exclude<
  SemanticProviderDescription,
  { readonly id: "none" }
> & { readonly sample: ShadowSample };

export type SemanticStageBuild =
  | {
      readonly ok: true;
      readonly stage: SemanticStage | undefined;
      readonly provider: SemanticProviderDescription;
      /** What `GET /v1/health` says about the shadows: ids, names, models. */
      readonly shadows: readonly ShadowDescription[];
    }
  | { readonly ok: false; readonly reason: string };

export function buildSemanticStage(
  options: SemanticStageBuildOptions,
): SemanticStageBuild {
  if (options.id === "none") {
    if ((options.shadows ?? []).length > 0) {
      // ADR-016 §3: shadows run where the primary runs.
      return { ok: false, reason: "a shadow provider needs a primary one" };
    }
    return {
      ok: true,
      stage: undefined,
      provider: { id: "none" },
      shadows: [],
    };
  }
  const registry = options.registry ?? gatewayProviderRegistry();
  // RFX-123: nothing is uploaded before consent. The check comes before any
  // constructor runs, so no key is even read for a provider nobody agreed to.
  const withoutConsent = [
    options.id,
    ...(options.shadows ?? []).map((shadow) => shadow.id),
  ].find((id) => isRemoteProvider(id) && !consentCovers(options.consent, id));
  if (withoutConsent !== undefined) {
    return {
      ok: false,
      reason: `the ${withoutConsent} provider sends action content off this machine and needs your consent first: run "rfx provider ${withoutConsent}"`,
    };
  }
  const construct = (
    configuration: ShadowConfiguration,
  ): ReturnType<ProviderRegistry["create"]> =>
    registry.create({
      id: configuration.id,
      ...(configuration.model === undefined
        ? {}
        : { model: configuration.model }),
      ...(configuration.endpoint === undefined
        ? {}
        : { endpoint: configuration.endpoint }),
      ...(configuration.id === "jev" &&
      options.env[JEV_API_KEY_VARIABLE] !== undefined
        ? { apiKey: options.env[JEV_API_KEY_VARIABLE] }
        : {}),
    });
  const built = construct({
    id: options.id,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
  });
  if (!built.ok) {
    return built;
  }
  const sample = options.shadowSample ?? "unresolved";
  const deadlineMs = options.shadowDeadlineMs ?? 5_000;
  const shadow: ShadowProvider[] = [];
  const shadows: ShadowDescription[] = [];
  for (const configuration of options.shadows ?? []) {
    if (sample === "all" && configuration.id !== "local") {
      return {
        ok: false,
        reason: `the shadow "${configuration.id}" may not be sampled on resolved actions: only local may (ADR-016 §3)`,
      };
    }
    const constructed = construct(configuration);
    if (!constructed.ok) {
      return {
        ok: false,
        reason: `shadow ${constructed.reason}`,
      };
    }
    shadow.push({ provider: constructed.provider, deadlineMs, sample });
    shadows.push({
      id: configuration.id,
      name: constructed.provider.providerName,
      model: constructed.provider.model,
      sample,
    });
  }
  const compiler = createContextCompiler({
    redactor: createRedactor({ key: options.redactionKey }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return {
    ok: true,
    stage: {
      provider: built.provider,
      compiler,
      aggregator: createRiskAggregator(),
      maxInputTokens: SEMANTIC_MAX_INPUT_TOKENS,
      ...(shadow.length === 0 ? {} : { shadow }),
    },
    provider: {
      id: options.id,
      name: built.provider.providerName,
      model: built.provider.model,
    },
    shadows,
  };
}
