import { readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SNAPSHOT_LIMITS,
  compilePolicySet,
  keyIdOf,
  parsePolicySnapshot,
  verifyPolicySnapshot,
  type PolicySourceDocument,
} from "@reflex-control/policy-engine";
import { createPublicKey } from "node:crypto";

/**
 * RFX-083 — the daemon's side of a team policy subscription (ADR-018).
 *
 * `rfx policy subscribe <location> --key <public key>` writes
 * `<REFLEX_HOME>/subscription.json`. From then on the daemon fetches the
 * snapshot at the location when it starts and on a bounded interval,
 * verifies it with that key (`verifyPolicySnapshot`), compiles it as the
 * `organization` and `environment` sources, and keeps the last good one
 * when a fetch or a verification fails (ADR-003 §3): a team whose policy
 * host is down keeps the policy it had, and a snapshot that does not verify
 * is refused, reported, and never applied. The last good snapshot is also
 * kept on disk (`snapshot.json`), so a daemon that starts offline starts
 * with it.
 *
 * Nothing about the subscribing machine is sent to the location beyond the
 * fetch itself: one `GET`, with `If-None-Match` when the server gave an
 * ETag, no other header REFLEX adds, no body, no redirect followed.
 */
export const SUBSCRIPTION_RECORD_VERSION = 1;
export const SNAPSHOT_CACHE_VERSION = 1;
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 300_000;
export const MIN_SNAPSHOT_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface SubscriptionRecord {
  readonly version: typeof SUBSCRIPTION_RECORD_VERSION;
  /** An absolute file path, a `file:` URL or an `https:` URL. */
  readonly location: string;
  /** SPKI PEM of the team's Ed25519 key. */
  readonly publicKeyPem: string;
  readonly subscribedAt: string;
}

export function subscriptionPath(home: string): string {
  return join(home, "subscription.json");
}

export function snapshotCachePath(home: string): string {
  return join(home, "snapshot.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A record REFLEX cannot read is no subscription. */
export function parseSubscriptionRecord(
  text: string | undefined,
): SubscriptionRecord | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      !isRecord(parsed) ||
      parsed.version !== SUBSCRIPTION_RECORD_VERSION ||
      typeof parsed.location !== "string" ||
      parsed.location === "" ||
      typeof parsed.publicKeyPem !== "string" ||
      typeof parsed.subscribedAt !== "string"
    ) {
      return undefined;
    }
    return {
      version: SUBSCRIPTION_RECORD_VERSION,
      location: parsed.location,
      publicKeyPem: parsed.publicKeyPem,
      subscribedAt: parsed.subscribedAt,
    };
  } catch {
    return undefined;
  }
}

export function serializeSubscription(record: SubscriptionRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export type LocationKind = "file" | "https";

/** What a location may be, and what it is. Anything else is refused before any I/O. */
export function classifyLocation(
  location: string,
): { readonly kind: LocationKind; readonly target: string } | undefined {
  if (location.startsWith("https://")) {
    try {
      const url = new URL(location);
      return url.hostname === ""
        ? undefined
        : { kind: "https", target: url.href };
    } catch {
      return undefined;
    }
  }
  if (location.startsWith("file://")) {
    try {
      return { kind: "file", target: fileURLToPath(location) };
    } catch {
      return undefined;
    }
  }
  if (isAbsolute(location)) {
    return { kind: "file", target: location };
  }
  return undefined;
}

export type FetchOutcome =
  | { readonly kind: "fetched"; readonly text: string; readonly etag?: string }
  | { readonly kind: "unchanged" }
  | { readonly kind: "failed"; readonly reason: string };

export type SnapshotFetcher = (
  location: { readonly kind: LocationKind; readonly target: string },
  etag: string | undefined,
) => Promise<FetchOutcome>;

/** The default fetcher: a file read, or one `GET` over HTTPS with a timeout and a size cap. */
export async function fetchSnapshotText(
  location: { readonly kind: LocationKind; readonly target: string },
  etag: string | undefined,
): Promise<FetchOutcome> {
  if (location.kind === "file") {
    try {
      const text = await readFile(location.target, "utf8");
      return { kind: "fetched", text };
    } catch {
      return { kind: "failed", reason: `cannot read ${location.target}` };
    }
  }
  let response: Response;
  try {
    response = await fetch(location.target, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: etag === undefined ? {} : { "if-none-match": etag },
    });
  } catch (error) {
    return {
      kind: "failed",
      reason: `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status === 304) {
    return { kind: "unchanged" };
  }
  if (!response.ok) {
    return { kind: "failed", reason: `HTTP ${String(response.status)}` };
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > SNAPSHOT_LIMITS.bytes) {
    return { kind: "failed", reason: "the snapshot is larger than allowed" };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { kind: "failed", reason: "the response could not be read" };
  }
  if (Buffer.byteLength(text, "utf8") > SNAPSHOT_LIMITS.bytes) {
    return { kind: "failed", reason: "the snapshot is larger than allowed" };
  }
  const newEtag = response.headers.get("etag") ?? undefined;
  return {
    kind: "fetched",
    text,
    ...(newEtag === undefined ? {} : { etag: newEtag }),
  };
}

export interface CurrentSnapshot {
  readonly version: string;
  readonly hash: string;
  readonly publishedAt: string;
  readonly keyId: string;
  readonly fetchedAt: string;
  /** The envelope as fetched, kept for the cache. */
  readonly text: string;
}

export interface SubscriptionState {
  readonly subscribed: boolean;
  readonly location?: string;
  /** Which key is subscribed, for a human reading `rfx status`. */
  readonly keyId?: string;
  readonly current?: Omit<CurrentSnapshot, "text">;
  readonly lastAttemptAt?: string;
  /** Why the last attempt did not produce a new snapshot; the last good one stays. */
  readonly lastError?: string;
  /** The subscription record itself could not be used. */
  readonly problem?: string;
}

export type RefreshOutcome =
  | {
      readonly kind: "applied";
      readonly version: string;
      readonly hash: string;
    }
  | { readonly kind: "unchanged" }
  | { readonly kind: "unsubscribed" }
  | { readonly kind: "refused"; readonly reason: string };

export interface SubscriptionHolder {
  /** The snapshot's sources, every one trusted; empty with no snapshot. */
  readonly sources: () => readonly PolicySourceDocument[];
  readonly state: () => SubscriptionState;
  /** Reads the subscription record, fetches, verifies, applies or keeps. */
  readonly refresh: () => Promise<RefreshOutcome>;
}

export interface SubscriptionHolderOptions {
  readonly home: string;
  readonly fetcher?: SnapshotFetcher;
  readonly clock?: () => Date;
}

interface Applied {
  readonly current: CurrentSnapshot;
  readonly sources: readonly PolicySourceDocument[];
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Written whole, then renamed: a reader never sees half a file. */
async function writeAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

function keyIdOfPem(pem: string): string | undefined {
  try {
    return keyIdOf(createPublicKey(pem));
  } catch {
    return undefined;
  }
}

/**
 * Verifies an envelope's text against the subscribed key and compiles it
 * on its own, so that a snapshot the engine would refuse never becomes the
 * current one.
 */
function applyText(
  text: string,
  record: SubscriptionRecord,
  fetchedAt: string,
): { ok: true; applied: Applied } | { ok: false; reason: string } {
  const parsed = parsePolicySnapshot(text);
  if (!parsed.ok) {
    return parsed;
  }
  const verified = verifyPolicySnapshot(parsed.snapshot, record.publicKeyPem);
  if (!verified.ok) {
    return verified;
  }
  const compiled = compilePolicySet(verified.verified.sources);
  if (!compiled.ok) {
    return { ok: false, reason: compiled.problems.join("; ") };
  }
  return {
    ok: true,
    applied: {
      current: {
        version: verified.verified.version,
        hash: verified.verified.hash,
        publishedAt: verified.verified.publishedAt,
        keyId: verified.verified.keyId,
        fetchedAt,
        text,
      },
      sources: verified.verified.sources,
    },
  };
}

export async function createSubscriptionHolder(
  options: SubscriptionHolderOptions,
): Promise<SubscriptionHolder> {
  const clock = options.clock ?? (() => new Date());
  const fetcher = options.fetcher ?? fetchSnapshotText;
  const recordPath = subscriptionPath(options.home);
  const cachePath = snapshotCachePath(options.home);

  let applied: Applied | undefined;
  let record: SubscriptionRecord | undefined;
  let etag: string | undefined;
  let lastAttemptAt: string | undefined;
  let lastError: string | undefined;
  let problem: string | undefined;

  const readRecord = async (): Promise<SubscriptionRecord | undefined> => {
    const text = await readIfExists(recordPath);
    if (text === undefined) {
      problem = undefined;
      return undefined;
    }
    const parsed = parseSubscriptionRecord(text);
    if (parsed === undefined) {
      problem = `${recordPath} cannot be read; run rfx policy subscribe again`;
      return undefined;
    }
    if (classifyLocation(parsed.location) === undefined) {
      problem = `${recordPath}: the location must be an absolute path, a file: URL or an https: URL`;
      return undefined;
    }
    if (keyIdOfPem(parsed.publicKeyPem) === undefined) {
      problem = `${recordPath}: the public key does not parse`;
      return undefined;
    }
    problem = undefined;
    return parsed;
  };

  // The last good snapshot, if it still verifies with the current key.
  record = await readRecord();
  if (record !== undefined) {
    const cached = await readIfExists(cachePath);
    if (cached !== undefined) {
      try {
        const parsed: unknown = JSON.parse(cached);
        if (
          isRecord(parsed) &&
          parsed.version === SNAPSHOT_CACHE_VERSION &&
          typeof parsed.text === "string" &&
          typeof parsed.fetchedAt === "string"
        ) {
          const result = applyText(parsed.text, record, parsed.fetchedAt);
          if (result.ok) {
            applied = result.applied;
          }
        }
      } catch {
        // A cache that cannot be read is no cache.
      }
    }
  }

  const refresh = async (): Promise<RefreshOutcome> => {
    const now = clock().toISOString();
    const previousRecord = record;
    record = await readRecord();
    if (record === undefined) {
      // Unsubscribed, or the record is unusable: nothing of the team's
      // applies any more, and the state says why.
      applied = undefined;
      etag = undefined;
      lastError = undefined;
      return { kind: "unsubscribed" };
    }
    if (
      previousRecord !== undefined &&
      (previousRecord.location !== record.location ||
        previousRecord.publicKeyPem !== record.publicKeyPem)
    ) {
      // A new subscription starts clean: the old snapshot was for the old key.
      applied = undefined;
      etag = undefined;
    }
    lastAttemptAt = now;
    const location = classifyLocation(record.location);
    if (location === undefined) {
      lastError = "the location is not usable";
      return { kind: "refused", reason: lastError };
    }
    const fetched = await fetcher(location, etag);
    if (fetched.kind === "unchanged") {
      lastError = undefined;
      return { kind: "unchanged" };
    }
    if (fetched.kind === "failed") {
      lastError = fetched.reason;
      return { kind: "refused", reason: fetched.reason };
    }
    const result = applyText(fetched.text, record, now);
    if (!result.ok) {
      lastError = result.reason;
      return { kind: "refused", reason: result.reason };
    }
    lastError = undefined;
    etag = fetched.etag;
    if (
      applied?.current.hash === result.applied.current.hash &&
      applied.current.version === result.applied.current.version
    ) {
      applied = {
        ...applied,
        current: { ...applied.current, fetchedAt: now },
      };
      return { kind: "unchanged" };
    }
    applied = result.applied;
    try {
      await writeAtomically(
        cachePath,
        `${JSON.stringify(
          {
            version: SNAPSHOT_CACHE_VERSION,
            fetchedAt: now,
            text: fetched.text,
          },
          null,
          2,
        )}\n`,
      );
    } catch {
      // The snapshot is applied in memory either way; the cache is for the
      // next start, and a cache that could not be written is reported.
      lastError = "the snapshot was applied but could not be cached";
    }
    return {
      kind: "applied",
      version: result.applied.current.version,
      hash: result.applied.current.hash,
    };
  };

  return {
    sources: () => applied?.sources ?? [],
    state: () => ({
      subscribed: record !== undefined,
      ...(record === undefined ? {} : { location: record.location }),
      ...(record === undefined
        ? {}
        : (() => {
            const keyId = keyIdOfPem(record.publicKeyPem);
            return keyId === undefined ? {} : { keyId };
          })()),
      ...(applied === undefined
        ? {}
        : {
            current: {
              version: applied.current.version,
              hash: applied.current.hash,
              publishedAt: applied.current.publishedAt,
              keyId: applied.current.keyId,
              fetchedAt: applied.current.fetchedAt,
            },
          }),
      ...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
      ...(lastError === undefined ? {} : { lastError }),
      ...(problem === undefined ? {} : { problem }),
    }),
    refresh,
  };
}
