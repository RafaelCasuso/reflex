import { createHash, createHmac } from "node:crypto";

import type {
  CanonicalAction,
  EnvironmentKind,
} from "@reflex-control/contracts";

/**
 * RFX-106 — the canonical action fingerprint.
 *
 * Two actions with the same fingerprint are the same action as far as a
 * deterministic decision is concerned: the same tool, arguments, operands,
 * resource, class, working directory and repository. What varies from one
 * call to the next without changing the decision is left out (ADR-001 §3.4):
 * identifiers, timestamps, the adapter's metadata bag, and the prior actions,
 * which only the semantic stage reads.
 *
 * The fingerprint is keyed (ADR-006). The key is the daemon's own, random at
 * start and never written down, so that nothing outside the daemon can tell
 * from a fingerprint, in a cache key or in telemetry, whether a guessed
 * command was ever run.
 */
const EXCLUDED_TOP_LEVEL: ReadonlySet<string> = new Set([
  "id",
  "organizationId",
  "projectId",
  "sessionId",
  "createdAt",
  "adapterMetadata",
  "priorActions",
]);

type Json = string | number | boolean | null | Json[] | JsonObject;
interface JsonObject {
  [key: string]: Json;
}

/** JSON with sorted keys and no whitespace. `undefined` members are absent. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): Json {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    const out: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) {
        out[key] = sortKeys(member);
      }
    }
    return out;
  }
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  return null;
}

export function fingerprintAction(
  action: CanonicalAction,
  key: Uint8Array,
): string {
  const { agent, ...rest } = action;
  const agentWithoutId: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(agent)) {
    if (name !== "id") {
      agentWithoutId[name] = value;
    }
  }
  const subject: Record<string, unknown> = { agent: agentWithoutId };
  for (const [name, value] of Object.entries(rest)) {
    if (!EXCLUDED_TOP_LEVEL.has(name)) {
      subject[name] = value;
    }
  }
  return `hmac-sha256:${createHmac("sha256", key)
    .update(canonicalJson(subject), "utf8")
    .digest("hex")}`;
}

export interface CacheKeyInput {
  readonly fingerprint: string;
  /** `CompiledPolicySet.hash`: a policy change invalidates by construction. */
  readonly policySetHash: string;
  readonly projectId?: string;
  readonly environment?: EnvironmentKind;
  /** RFX-109: a semantic decision is the answer of one provider and model. */
  readonly provider?: string;
  readonly model?: string;
}

/**
 * `docs/architecture.md` §11: fingerprint, policy hash, environment, project,
 * and, when a semantic stage is configured, which provider and model would
 * answer, so that a change of either misses by construction.
 */
export function decisionCacheKey(input: CacheKeyInput): string {
  const payload = JSON.stringify([
    input.fingerprint,
    input.policySetHash,
    input.projectId ?? null,
    input.environment ?? null,
    input.provider ?? null,
    input.model ?? null,
  ]);
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}
