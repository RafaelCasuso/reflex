import { join } from "node:path";

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

/** The daemon's command line for this configuration (RFX-141, RFX-142). */
export function daemonArguments(config: UserConfig): string[] {
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
  }
  return args;
}
