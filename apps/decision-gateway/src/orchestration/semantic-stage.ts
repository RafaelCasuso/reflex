import {
  createContextCompiler,
  createRedactor,
} from "@reflex/context-compiler";
import { createRiskAggregator, type SemanticStage } from "@reflex/core";
import { JEV_DEFAULT_MODEL, createJevProvider } from "@reflex/provider-jev";
import {
  createProviderRegistry,
  fakeProviderConstructor,
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

/** What this build can construct. `local` is RFX-144; `reflex` is G14. */
export function gatewayProviderRegistry(): ProviderRegistry {
  return createProviderRegistry({
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

export interface SemanticStageBuildOptions {
  readonly id: ProviderId;
  readonly model: string | undefined;
  readonly endpoint: string | undefined;
  /** The installation's redaction key (ADR-006 §4). */
  readonly redactionKey: Uint8Array;
  readonly env: NodeJS.ProcessEnv;
  readonly registry?: ProviderRegistry;
  readonly clock?: () => Date;
}

export type SemanticStageBuild =
  | {
      readonly ok: true;
      readonly stage: SemanticStage | undefined;
      readonly provider: SemanticProviderDescription;
    }
  | { readonly ok: false; readonly reason: string };

export function buildSemanticStage(
  options: SemanticStageBuildOptions,
): SemanticStageBuild {
  if (options.id === "none") {
    return { ok: true, stage: undefined, provider: { id: "none" } };
  }
  const registry = options.registry ?? gatewayProviderRegistry();
  const built = registry.create({
    id: options.id,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.id === "jev" && options.env[JEV_API_KEY_VARIABLE] !== undefined
      ? { apiKey: options.env[JEV_API_KEY_VARIABLE] }
      : {}),
  });
  if (!built.ok) {
    return built;
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
    },
    provider: {
      id: options.id,
      name: built.provider.providerName,
      model: built.provider.model,
    },
  };
}
