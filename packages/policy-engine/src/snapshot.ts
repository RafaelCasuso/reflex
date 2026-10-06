import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import {
  ENVIRONMENT_KINDS,
  isOpaqueId,
  type EnvironmentKind,
  type PolicyDocument,
  type PolicyId,
} from "@reflex-control/contracts";
import { stringify as toYaml } from "yaml";

import {
  POLICY_SET_FORMAT,
  canonicalizePolicySet,
  type CanonicalSource,
} from "./canonical.js";
import type { PolicySourceDocument } from "./evaluator.js";
import { parsePolicy } from "./parser.js";

/**
 * RFX-083 — a signed policy snapshot (ADR-018).
 *
 * A team publishes one to a URL or a file of its own; every member's daemon
 * fetches it, verifies it with the team's public key and compiles it as the
 * `organization` and `environment` sources of ADR-004. No account, no
 * control plane: the hosted one publishes to this same format later.
 *
 * The payload is the canonical policy set of RFX-016, exactly as it is
 * hashed: so a snapshot is immutable by construction (its identity is the
 * hash of its payload), and the `policySetHash` of every decision made under
 * it is a function of it. The signature is Ed25519 over a short statement
 * that binds the format, the version, the publication time and the hash of
 * the payload: changing any of them, or the payload, breaks it.
 *
 * What a snapshot may carry is narrow on purpose: `organization` and
 * `environment` sources, both trusted, nothing else. A `local`, `project` or
 * `built-in` source inside one is refused, as is a source whose payload is
 * not canonical. Verification is pure; fetching, caching and the clock are
 * the daemon's (`apps/decision-gateway`).
 */
export const SNAPSHOT_FORMAT = 1;

export const SNAPSHOT_LIMITS = {
  /** The whole envelope, as text. A policy is configuration, not data. */
  bytes: 1024 * 1024,
  versionLength: 128,
} as const;

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const SNAPSHOT_SOURCES = ["organization", "environment"] as const;
type SnapshotSource = (typeof SNAPSHOT_SOURCES)[number];

export interface SnapshotSignature {
  readonly algorithm: "ed25519";
  /** `sha256:` of the public key's SPKI DER: which key, for a human reading `rfx status`. */
  readonly keyId: string;
  /** Base64. */
  readonly value: string;
}

export interface PolicySnapshot {
  readonly format: typeof SNAPSHOT_FORMAT;
  /** The team's own label: a tag, a date, a counter. */
  readonly version: string;
  /** ISO 8601 UTC. */
  readonly publishedAt: string;
  /** The canonical policy set, exactly as hashed (RFX-016). */
  readonly policySet: string;
  /** `sha256:` of `policySet`. */
  readonly hash: string;
  readonly signature: SnapshotSignature;
}

/** What goes into a snapshot: a team's policy documents, by source. */
export interface SnapshotSourceInput {
  readonly source: SnapshotSource;
  readonly policyId?: PolicyId;
  /** Required on an `environment` source, refused elsewhere. */
  readonly environment?: EnvironmentKind;
  readonly document: PolicyDocument;
}

export interface SnapshotKeys {
  /** PKCS#8 PEM. Keep it where the team keeps secrets; never in a repository. */
  readonly privateKeyPem: string;
  /** SPKI PEM. What every subscriber gets. */
  readonly publicKeyPem: string;
  readonly keyId: string;
}

export type SnapshotResult =
  | { readonly ok: true; readonly snapshot: PolicySnapshot }
  | { readonly ok: false; readonly reason: string };

export interface VerifiedSnapshot {
  readonly version: string;
  readonly publishedAt: string;
  readonly hash: string;
  readonly keyId: string;
  /** Ready for `compilePolicySet`, every source trusted. */
  readonly sources: readonly PolicySourceDocument[];
}

export type VerifyResult =
  | { readonly ok: true; readonly verified: VerifiedSnapshot }
  | { readonly ok: false; readonly reason: string };

export type ParseSnapshotResult =
  | { readonly ok: true; readonly snapshot: PolicySnapshot }
  | { readonly ok: false; readonly reason: string };

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function keyIdOf(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

/** A fresh Ed25519 pair. */
export function generateSnapshotKeys(): SnapshotKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    keyId: keyIdOf(publicKey),
  };
}

function publicKeyOf(
  key: string | KeyObject,
): { ok: true; key: KeyObject } | { ok: false; reason: string } {
  try {
    const object = typeof key === "string" ? createPublicKey(key) : key;
    if (object.type !== "public" || object.asymmetricKeyType !== "ed25519") {
      return { ok: false, reason: "the public key is not an Ed25519 key" };
    }
    return { ok: true, key: object };
  } catch {
    return { ok: false, reason: "the public key does not parse" };
  }
}

function privateKeyOf(
  key: string | KeyObject,
): { ok: true; key: KeyObject } | { ok: false; reason: string } {
  try {
    const object = typeof key === "string" ? createPrivateKey(key) : key;
    if (object.type !== "private" || object.asymmetricKeyType !== "ed25519") {
      return { ok: false, reason: "the private key is not an Ed25519 key" };
    }
    return { ok: true, key: object };
  } catch {
    return { ok: false, reason: "the private key does not parse" };
  }
}

/** What is signed: everything the envelope asserts, and the payload by its hash. */
function statementOf(
  fields: Pick<PolicySnapshot, "format" | "version" | "publishedAt" | "hash">,
): Buffer {
  return Buffer.from(
    `reflex-policy-snapshot\n${String(fields.format)}\n${fields.version}\n${fields.publishedAt}\n${fields.hash}\n`,
    "utf8",
  );
}

function isSnapshotSource(value: unknown): value is SnapshotSource {
  return (SNAPSHOT_SOURCES as readonly unknown[]).includes(value);
}

function isEnvironment(value: unknown): value is EnvironmentKind {
  return (
    (ENVIRONMENT_KINDS as readonly unknown[]).includes(value) &&
    value !== "unknown"
  );
}

function sourceProblem(entry: SnapshotSourceInput): string | undefined {
  if (!isSnapshotSource(entry.source)) {
    return `a snapshot carries organization and environment sources only, not ${String(entry.source)}`;
  }
  if (entry.source === "environment") {
    if (!isEnvironment(entry.environment)) {
      return "an environment source needs the environment it applies to, and unknown is not one";
    }
  } else if (entry.environment !== undefined) {
    return "only an environment source names an environment";
  }
  return undefined;
}

function canonicalSourceOf(entry: SnapshotSourceInput): CanonicalSource {
  return {
    source: entry.source,
    trusted: true,
    ...(entry.policyId === undefined ? {} : { policyId: entry.policyId }),
    ...(entry.document.defaults === undefined
      ? {}
      : { unresolved: entry.document.defaults.unresolved }),
    ...(entry.environment === undefined
      ? {}
      : { environment: entry.environment }),
    rules: entry.document.rules,
  };
}

export interface CreateSnapshotOptions {
  readonly sources: readonly SnapshotSourceInput[];
  readonly version: string;
  readonly publishedAt: Date;
  readonly privateKey: string | KeyObject;
}

/** Signs a team's policy documents into one snapshot. Pure. */
export function createPolicySnapshot(
  options: CreateSnapshotOptions,
): SnapshotResult {
  if (!VERSION.test(options.version)) {
    return {
      ok: false,
      reason: `a snapshot version is 1 to ${String(SNAPSHOT_LIMITS.versionLength)} characters of letters, digits, dots, dashes or underscores`,
    };
  }
  if (options.sources.length === 0) {
    return { ok: false, reason: "a snapshot needs at least one source" };
  }
  for (const entry of options.sources) {
    const problem = sourceProblem(entry);
    if (problem !== undefined) {
      return { ok: false, reason: problem };
    }
  }
  const key = privateKeyOf(options.privateKey);
  if (!key.ok) {
    return key;
  }
  const { payload, hash } = canonicalizePolicySet(
    options.sources.map(canonicalSourceOf),
  );
  const fields = {
    format: SNAPSHOT_FORMAT,
    version: options.version,
    publishedAt: options.publishedAt.toISOString(),
    hash,
  } as const;
  const value = sign(null, statementOf(fields), key.key).toString("base64");
  const snapshot: PolicySnapshot = {
    ...fields,
    policySet: payload,
    signature: {
      algorithm: "ed25519",
      keyId: keyIdOf(createPublicKey(key.key)),
      value,
    },
  };
  if (JSON.stringify(snapshot).length > SNAPSHOT_LIMITS.bytes) {
    return {
      ok: false,
      reason: `a snapshot is at most ${String(SNAPSHOT_LIMITS.bytes)} bytes`,
    };
  }
  return { ok: true, snapshot };
}

export function serializeSnapshot(snapshot: PolicySnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The envelope's shape, and nothing about what it says: that is `verifyPolicySnapshot`. */
export function parsePolicySnapshot(text: string): ParseSnapshotResult {
  if (Buffer.byteLength(text, "utf8") > SNAPSHOT_LIMITS.bytes) {
    return {
      ok: false,
      reason: `a snapshot is at most ${String(SNAPSHOT_LIMITS.bytes)} bytes`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "a snapshot is a JSON document" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "a snapshot is a JSON object" };
  }
  if (parsed.format !== SNAPSHOT_FORMAT) {
    return {
      ok: false,
      reason: `snapshot format ${String(parsed.format)} is not ${String(SNAPSHOT_FORMAT)}, the only one there is`,
    };
  }
  if (typeof parsed.version !== "string" || !VERSION.test(parsed.version)) {
    return { ok: false, reason: "a snapshot needs a version" };
  }
  if (
    typeof parsed.publishedAt !== "string" ||
    Number.isNaN(Date.parse(parsed.publishedAt))
  ) {
    return { ok: false, reason: "a snapshot needs publishedAt, an ISO date" };
  }
  if (typeof parsed.policySet !== "string") {
    return { ok: false, reason: "a snapshot needs its policySet" };
  }
  if (typeof parsed.hash !== "string" || !HASH.test(parsed.hash)) {
    return {
      ok: false,
      reason: "a snapshot needs the sha256 hash of its policySet",
    };
  }
  const signature = parsed.signature;
  if (
    !isRecord(signature) ||
    signature.algorithm !== "ed25519" ||
    typeof signature.keyId !== "string" ||
    typeof signature.value !== "string"
  ) {
    return { ok: false, reason: "a snapshot needs an ed25519 signature" };
  }
  return {
    ok: true,
    snapshot: {
      format: SNAPSHOT_FORMAT,
      version: parsed.version,
      publishedAt: parsed.publishedAt,
      policySet: parsed.policySet,
      hash: parsed.hash,
      signature: {
        algorithm: "ed25519",
        keyId: signature.keyId,
        value: signature.value,
      },
    },
  };
}

/** A canonical source, read back into a document through the same parser a file goes through. */
function sourceOfPayload(
  entry: unknown,
  index: number,
): { ok: true; source: PolicySourceDocument } | { ok: false; reason: string } {
  const where = `source ${String(index)}`;
  if (!isRecord(entry)) {
    return { ok: false, reason: `${where} is not an object` };
  }
  if (!isSnapshotSource(entry.source)) {
    return {
      ok: false,
      reason: `${where}: a snapshot carries organization and environment sources only, not ${String(entry.source)}`,
    };
  }
  if (entry.trusted !== true) {
    return { ok: false, reason: `${where}: a snapshot's sources are trusted` };
  }
  if (entry.policyId !== null && typeof entry.policyId !== "string") {
    return { ok: false, reason: `${where}: policyId is a string or null` };
  }
  let environment: EnvironmentKind | undefined;
  if (entry.source === "environment") {
    if (!isEnvironment(entry.environment)) {
      return {
        ok: false,
        reason: `${where}: an environment source needs the environment it applies to, and unknown is not one`,
      };
    }
    environment = entry.environment;
  } else if (entry.environment !== undefined) {
    return {
      ok: false,
      reason: `${where}: only an environment source names an environment`,
    };
  }
  let policyId: PolicyId | undefined;
  if (typeof entry.policyId === "string") {
    if (!isOpaqueId("pol", entry.policyId)) {
      return { ok: false, reason: `${where}: policyId is a pol_ id` };
    }
    policyId = entry.policyId;
  }
  if (!Array.isArray(entry.rules)) {
    return { ok: false, reason: `${where}: rules is a list` };
  }
  const unresolved = entry.unresolved;
  if (
    unresolved !== null &&
    unresolved !== "semantic" &&
    unresolved !== "ask" &&
    unresolved !== "deny"
  ) {
    return {
      ok: false,
      reason: `${where}: unresolved is semantic, ask, deny or null`,
    };
  }
  // The rules go through the policy parser, so that everything it refuses in
  // a file (unknown fields, operators that do not fit, limits) is refused
  // here too, with the same words.
  let yaml: string;
  try {
    yaml = toYaml({
      version: 1,
      ...(unresolved === null ? {} : { defaults: { unresolved } }),
      rules: entry.rules,
    });
  } catch {
    return { ok: false, reason: `${where}: rules cannot be read` };
  }
  const parsed = parsePolicy(yaml);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `${where}: ${parsed.issues.map((issue) => issue.message).join("; ")}`,
    };
  }
  return {
    ok: true,
    source: {
      source: entry.source,
      trusted: true,
      ...(policyId === undefined ? {} : { policyId }),
      ...(environment === undefined ? {} : { environment }),
      document: parsed.document,
    },
  };
}

/**
 * Checks everything a subscriber must check before applying a snapshot:
 * the hash is the payload's, the signature is the key's over the
 * statement, the payload is canonical and carries only what a snapshot may.
 * A snapshot that fails any of it is refused, with the reason, and never
 * applied (ADR-003 §3 keeps the last good one).
 */
export function verifyPolicySnapshot(
  snapshot: PolicySnapshot,
  publicKey: string | KeyObject,
): VerifyResult {
  const key = publicKeyOf(publicKey);
  if (!key.ok) {
    return key;
  }
  if (sha256(snapshot.policySet) !== snapshot.hash) {
    return { ok: false, reason: "the hash is not the policy set's" };
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(snapshot.signature.value, "base64");
  } catch {
    return { ok: false, reason: "the signature is not base64" };
  }
  const valid = ((): boolean => {
    try {
      return verify(null, statementOf(snapshot), key.key, signature);
    } catch {
      return false;
    }
  })();
  if (!valid) {
    return {
      ok: false,
      reason: "the signature does not verify with the subscribed key",
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(snapshot.policySet);
  } catch {
    return { ok: false, reason: "the policy set is not JSON" };
  }
  if (
    !isRecord(payload) ||
    payload.format !== POLICY_SET_FORMAT ||
    !Array.isArray(payload.sources)
  ) {
    return {
      ok: false,
      reason: `the policy set is not a format ${String(POLICY_SET_FORMAT)} canonical set`,
    };
  }
  if (payload.sources.length === 0) {
    return { ok: false, reason: "the policy set has no sources" };
  }
  const sources: PolicySourceDocument[] = [];
  for (const [index, entry] of (payload.sources as unknown[]).entries()) {
    const read = sourceOfPayload(entry, index);
    if (!read.ok) {
      return read;
    }
    sources.push(read.source);
  }
  // Canonical means canonical: the payload must be the one these sources
  // hash to, or two snapshots with one meaning would have two identities.
  const again = canonicalizePolicySet(
    sources.map((entry) => ({
      source: entry.source,
      trusted: true,
      ...(entry.policyId === undefined ? {} : { policyId: entry.policyId }),
      ...(entry.document.defaults === undefined
        ? {}
        : { unresolved: entry.document.defaults.unresolved }),
      ...(entry.environment === undefined
        ? {}
        : { environment: entry.environment }),
      rules: entry.document.rules,
    })),
  );
  if (again.payload !== snapshot.policySet) {
    return { ok: false, reason: "the policy set is not in canonical form" };
  }
  return {
    ok: true,
    verified: {
      version: snapshot.version,
      publishedAt: snapshot.publishedAt,
      hash: snapshot.hash,
      keyId: keyIdOf(key.key),
      sources,
    },
  };
}
