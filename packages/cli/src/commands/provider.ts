import {
  consentRecord,
  consentStatement,
  isRemoteProvider,
  parseConsentRecord,
  type ConsentRecord,
} from "@reflex/semantic-provider";

import type { FileSystemPort } from "../backups/file-system.js";
import {
  configPath,
  consentPath,
  DEFAULT_CONFIG,
  parseConfig,
  withConsent,
  type ConfiguredProvider,
  type UserConfig,
} from "../config.js";
import {
  reflexHome,
  serialize,
  STATE_FILE_MODE,
  type Environment,
} from "../state.js";

/**
 * RFX-123 — `rfx provider`: what assesses the actions policy leaves open,
 * and the consent a remote one needs first.
 *
 * The provider is the user's, not a project's: one daemon serves every
 * project (RFX-138), so this writes `<REFLEX_HOME>/config.json`. A remote
 * provider (`jev`, later `reflex`) sends the redacted request off the
 * machine, so choosing one shows the statement of what is sent, what is
 * redacted first and where it goes, and records the yes in
 * `<REFLEX_HOME>/consent.json` with the statement's digest. Nothing is
 * written for a remote provider without that yes, and choosing `none`
 * withdraws it. Declining changes nothing: policy alone, as before.
 */
export const CHOOSABLE_PROVIDERS = ["none", "jev", "local"] as const;
export type ChoosableProvider = (typeof CHOOSABLE_PROVIDERS)[number];

export interface ProviderReport {
  readonly config: UserConfig;
  readonly consent: ConsentRecord | undefined;
  /** Remote providers the configuration names without a covering consent. */
  readonly withheld: readonly ConfiguredProvider[];
}

export interface ProviderChoice {
  readonly provider: ChoosableProvider;
  readonly model?: string;
  readonly endpoint?: string;
  /** The user agreed to the statement for this provider, in this run. */
  readonly consented: boolean;
}

export type ProviderChangeResult =
  | {
      readonly ok: true;
      readonly after: ProviderReport;
      /** The daemon must be restarted to run with the new configuration. */
      readonly changed: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: "consent-required" | "model-required" | "write-failed";
    };

export { consentStatement };

export async function readProvider(
  environment: Environment,
  fileSystem: FileSystemPort,
): Promise<ProviderReport> {
  const home = reflexHome(environment);
  const config = parseConfig(
    (await fileSystem.read(configPath(home)))?.content.toString("utf8"),
  );
  const consent = parseConsentRecord(
    (await fileSystem.read(consentPath(home)))?.content.toString("utf8"),
  );
  return { config, consent, withheld: withConsent(config, consent).withheld };
}

export async function changeProvider(
  environment: Environment,
  fileSystem: FileSystemPort,
  choice: ProviderChoice,
): Promise<ProviderChangeResult> {
  const home = reflexHome(environment);
  const before = await readProvider(environment, fileSystem);

  if (isRemoteProvider(choice.provider) && !choice.consented) {
    return { ok: false, reason: "consent-required" };
  }
  if (choice.provider === "local" && choice.model === undefined) {
    // The local provider must be pinned to the checkpoint it serves
    // (RFX-144); the daemon refuses it otherwise, so refuse it here first.
    return { ok: false, reason: "model-required" };
  }

  const config: UserConfig =
    choice.provider === "none"
      ? DEFAULT_CONFIG
      : {
          version: 1,
          semanticProvider: choice.provider,
          ...(choice.model === undefined
            ? {}
            : { semanticModel: choice.model }),
          ...(choice.endpoint === undefined
            ? {}
            : { semanticEndpoint: choice.endpoint }),
        };
  const consent = isRemoteProvider(choice.provider)
    ? consentRecord(choice.provider, environment.now())
    : choice.provider === "none"
      ? undefined
      : before.consent;

  try {
    // The consent first: a configuration that names a remote provider never
    // exists on disk without the consent that covers it, not even between
    // two writes.
    if (consent === undefined) {
      if (before.consent !== undefined) {
        await fileSystem.remove(consentPath(home));
      }
    } else if (
      before.consent?.provider !== consent.provider ||
      before.consent.statementDigest !== consent.statementDigest
    ) {
      await fileSystem.write(
        consentPath(home),
        serialize(consent),
        STATE_FILE_MODE,
      );
    }
    await fileSystem.write(
      configPath(home),
      serialize(config),
      STATE_FILE_MODE,
    );
  } catch {
    return { ok: false, reason: "write-failed" };
  }

  const after = await readProvider(environment, fileSystem);
  return {
    ok: true,
    after,
    changed: JSON.stringify(after.config) !== JSON.stringify(before.config),
  };
}

/** One line for `rfx status` and `rfx provider`. */
export function describeProvider(report: ProviderReport): string {
  const { config, consent, withheld } = report;
  if (withheld.length > 0) {
    return `${withheld.join(", ")} configured without consent: running with policy alone, nothing leaves this machine. Run "rfx provider ${withheld[0] ?? "none"}" to agree, or "rfx provider none".`;
  }
  if (config.semanticProvider === "none") {
    return "none (policy alone; an open action asks; nothing leaves this machine)";
  }
  const model =
    config.semanticModel === undefined ? "" : `, model ${config.semanticModel}`;
  const consented =
    consent === undefined
      ? ""
      : `, consent given ${consent.grantedAt.slice(0, 10)}`;
  return `${config.semanticProvider}${model}${consented}`;
}
