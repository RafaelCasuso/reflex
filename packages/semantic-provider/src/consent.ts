import { createHash } from "node:crypto";

import type { ProviderId } from "./registry.js";

/**
 * RFX-123 — consent before action content leaves the machine.
 *
 * A remote provider is given the redacted, minimal request the context
 * compiler produces (ADR-006). That is the moment a developer's commands
 * and file paths leave their machine, and it happens only after they said
 * yes to a statement of what is sent, what is redacted first and where it
 * goes. The statement is versioned by its digest: when it changes, every
 * earlier consent stops covering it and the question is asked again.
 * Declining keeps the local deterministic path fully working: the daemon
 * runs with no provider.
 */
export const REMOTE_PROVIDERS: readonly ProviderId[] = ["jev", "reflex"];

export function isRemoteProvider(id: ProviderId): boolean {
  return REMOTE_PROVIDERS.includes(id);
}

export const CONSENT_RECORD_VERSION = 1;

const DESTINATIONS: Readonly<Record<string, string>> = {
  jev: "TypeSafe's Jev API (api.typesafe.ai) over HTTPS, with your own API key",
  reflex: "the hosted REFLEX gateway over HTTPS, under your account",
};

/** What the user is shown, and what their consent covers. */
export function consentStatement(provider: ProviderId): string {
  const destination =
    DESTINATIONS[provider] ?? `the provider "${provider}" over the network`;
  return [
    `REFLEX will send action content to ${destination}, only for actions your policy does not resolve.`,
    "",
    "What is sent, per action:",
    "  - the tool's name and namespace, the operation, and the side-effect class;",
    "  - the tool's arguments, after redaction;",
    "  - your objective and the task summary, after redaction;",
    "  - the environment (local, staging, production), the repository's branch and remote host, never its path on disk;",
    "  - summaries of prior actions (tool names and effects), and the names of matching policy rules;",
    "  - never: your identity, your project id, your working directory, tool output, transcripts, or the host's own metadata.",
    "",
    "What is redacted first, on this machine:",
    "  - fifteen shapes of secret (API keys, tokens, private keys, passwords, connection strings, cloud credentials and the like),",
    "    including inside base64 and percent-encoded text, replaced by a fingerprint that identifies repetition without revealing the value;",
    "  - anything larger than the token budget is cut, required fields never;",
    "  - a value the redactor does not recognize as a secret is sent as it is: do not put secrets in commands.",
    "",
    "Where it goes, and for how long:",
    `  - to ${destination};`,
    "  - the provider's answer is eleven numbers and a model name; REFLEX keeps the redacted request and the answer locally for seven days;",
    "  - nothing is sent for actions a rule or a policy default decides, which is most of them.",
    "",
    "Declining keeps REFLEX working with policy alone: an action policy leaves open asks you, and nothing leaves this machine.",
  ].join("\n");
}

export function consentDigest(provider: ProviderId): string {
  return `sha256:${createHash("sha256").update(consentStatement(provider), "utf8").digest("hex")}`;
}

export interface ConsentRecord {
  readonly version: typeof CONSENT_RECORD_VERSION;
  readonly provider: ProviderId;
  readonly grantedAt: string;
  /** The digest of the statement that was shown. */
  readonly statementDigest: string;
}

export function consentRecord(
  provider: ProviderId,
  grantedAt: Date,
): ConsentRecord {
  return {
    version: CONSENT_RECORD_VERSION,
    provider,
    grantedAt: grantedAt.toISOString(),
    statementDigest: consentDigest(provider),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A file REFLEX cannot read is no consent. */
export function parseConsentRecord(
  text: string | undefined,
): ConsentRecord | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      isRecord(parsed) &&
      parsed.version === CONSENT_RECORD_VERSION &&
      typeof parsed.provider === "string" &&
      typeof parsed.grantedAt === "string" &&
      typeof parsed.statementDigest === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(parsed.statementDigest)
    ) {
      return {
        version: CONSENT_RECORD_VERSION,
        provider: parsed.provider as ProviderId,
        grantedAt: parsed.grantedAt,
        statementDigest: parsed.statementDigest,
      };
    }
  } catch {
    // Not consent.
  }
  return undefined;
}

/**
 * True when the record is a yes to the current statement for this
 * provider. A consent to another provider, or to an earlier statement,
 * covers nothing.
 */
export function consentCovers(
  record: ConsentRecord | undefined,
  provider: ProviderId,
): boolean {
  return (
    record?.provider === provider &&
    record.statementDigest === consentDigest(provider)
  );
}
