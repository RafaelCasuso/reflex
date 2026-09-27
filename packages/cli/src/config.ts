import { join } from "node:path";

import {
  consentCovers,
  isRemoteProvider,
  type ConsentRecord,
} from "@reflex/semantic-provider";

/**
 * RFX-138 — the user's daemon configuration, `<REFLEX_HOME>/config.json`.
 *
 * One daemon per user serves every project, so what it runs with (which
 * semantic provider, which shadows) is the user's, not a project's. Absent
 * or unreadable, the daemon runs with no provider: policy alone, and an
 * open action asks. A file REFLEX cannot read is never trusted.
 */
export const PROVIDER_IDS = ["none", "jev", "local", "reflex", "fake"] as const;
export type ConfiguredProvider = (typeof PROVIDER_IDS)[number];

export interface UserConfig {
  readonly version: 1;
  readonly semanticProvider: ConfiguredProvider;
  readonly semanticModel?: string;
  readonly semanticEndpoint?: string;
  readonly shadowProviders?: readonly Exclude<ConfiguredProvider, "none">[];
  readonly shadowSample?: "unresolved" | "all";
  readonly shadowDeadlineMs?: number;
}

export const DEFAULT_CONFIG: UserConfig = {
  version: 1,
  semanticProvider: "none",
};

export function configPath(home: string): string {
  return join(home, "config.json");
}

/** RFX-123: the consent the user gave, `<REFLEX_HOME>/consent.json`. */
export function consentPath(home: string): string {
  return join(home, "consent.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isProvider = (value: unknown): value is ConfiguredProvider =>
  typeof value === "string" &&
  (PROVIDER_IDS as readonly string[]).includes(value);

export function parseConfig(text: string | undefined): UserConfig {
  if (text === undefined) {
    return DEFAULT_CONFIG;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !isProvider(parsed.semanticProvider)
    ) {
      return DEFAULT_CONFIG;
    }
    const shadows = Array.isArray(parsed.shadowProviders)
      ? parsed.shadowProviders.filter(
          (entry): entry is Exclude<ConfiguredProvider, "none"> =>
            isProvider(entry) && entry !== "none",
        )
      : undefined;
    return {
      version: 1,
      semanticProvider: parsed.semanticProvider,
      ...(typeof parsed.semanticModel === "string" &&
      parsed.semanticModel !== ""
        ? { semanticModel: parsed.semanticModel }
        : {}),
      ...(typeof parsed.semanticEndpoint === "string" &&
      parsed.semanticEndpoint !== ""
        ? { semanticEndpoint: parsed.semanticEndpoint }
        : {}),
      ...(shadows !== undefined && shadows.length > 0
        ? { shadowProviders: shadows }
        : {}),
      ...(parsed.shadowSample === "all" || parsed.shadowSample === "unresolved"
        ? { shadowSample: parsed.shadowSample }
        : {}),
      ...(typeof parsed.shadowDeadlineMs === "number" &&
      Number.isInteger(parsed.shadowDeadlineMs) &&
      parsed.shadowDeadlineMs >= 1
        ? { shadowDeadlineMs: parsed.shadowDeadlineMs }
        : {}),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export interface ConsentedConfig {
  /** What the daemon is started with. */
  readonly config: UserConfig;
  /** RFX-123: the remote providers the configuration asks for without consent. */
  readonly withheld: readonly ConfiguredProvider[];
}

/**
 * RFX-123 — nothing is uploaded before consent.
 *
 * A remote provider the configuration names is withheld unless a consent
 * record covers it: the primary becomes `none` (policy alone, an open
 * action asks, and with no primary no shadow runs either), a shadow is
 * left out. `rfx provider` never writes such a configuration; this is for a
 * `config.json` edited by hand or by something else, so that even then no
 * action content leaves the machine. The daemon checks again on its side.
 */
export function withConsent(
  config: UserConfig,
  consent: ConsentRecord | undefined,
): ConsentedConfig {
  const covered = (id: ConfiguredProvider): boolean =>
    !isRemoteProvider(id) || consentCovers(consent, id);
  const withheld: ConfiguredProvider[] = [];
  if (!covered(config.semanticProvider)) {
    withheld.push(config.semanticProvider);
    for (const shadow of config.shadowProviders ?? []) {
      if (!covered(shadow)) {
        withheld.push(shadow);
      }
    }
    return { config: DEFAULT_CONFIG, withheld };
  }
  const shadows = (config.shadowProviders ?? []).filter((shadow) => {
    if (covered(shadow)) {
      return true;
    }
    withheld.push(shadow);
    return false;
  });
  const rest: UserConfig = {
    version: 1,
    semanticProvider: config.semanticProvider,
    ...(config.semanticModel === undefined
      ? {}
      : { semanticModel: config.semanticModel }),
    ...(config.semanticEndpoint === undefined
      ? {}
      : { semanticEndpoint: config.semanticEndpoint }),
    ...(config.shadowSample === undefined
      ? {}
      : { shadowSample: config.shadowSample }),
    ...(config.shadowDeadlineMs === undefined
      ? {}
      : { shadowDeadlineMs: config.shadowDeadlineMs }),
  };
  return {
    config: shadows.length === 0 ? rest : { ...rest, shadowProviders: shadows },
    withheld,
  };
}

/**
 * The daemon's command line for this configuration (RFX-141, RFX-142), with
 * the consent file when one was read (RFX-123), so that the daemon can
 * verify the consent itself before it builds a remote provider.
 */
export function daemonArguments(
  config: UserConfig,
  consentFile?: string,
): string[] {
  const args: string[] = [];
  if (config.semanticProvider !== "none") {
    args.push("--semantic-provider", config.semanticProvider);
    if (config.semanticModel !== undefined) {
      args.push("--semantic-model", config.semanticModel);
    }
    if (config.semanticEndpoint !== undefined) {
      args.push("--semantic-endpoint", config.semanticEndpoint);
    }
    for (const shadow of config.shadowProviders ?? []) {
      args.push("--shadow-provider", shadow);
    }
    if (config.shadowSample !== undefined) {
      args.push("--shadow-sample", config.shadowSample);
    }
    if (config.shadowDeadlineMs !== undefined) {
      args.push("--shadow-deadline", String(config.shadowDeadlineMs));
    }
    if (consentFile !== undefined) {
      args.push("--remote-consent", consentFile);
    }
  }
  return args;
}
