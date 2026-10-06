import { createPublicKey } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import type { EnvironmentKind } from "@reflex-control/contracts";
import {
  classifyLocation,
  createSubscriptionHolder,
  parseSubscriptionRecord,
  serializeSubscription,
  snapshotCachePath,
  subscriptionPath,
  type RefreshOutcome,
  type SubscriptionState,
} from "@reflex-control/decision-gateway/policy.js";
import {
  MAPPABLE_ENVIRONMENTS,
  createPolicySnapshot,
  generateSnapshotKeys,
  keyIdOf,
  parsePolicy,
  serializeSnapshot,
  type SnapshotSourceInput,
} from "@reflex-control/policy-engine";

import type { FileSystemPort } from "../backups/file-system.js";
import { stopDaemon } from "../daemon/lifecycle.js";
import { reflexHome, STATE_FILE_MODE, type Environment } from "../state.js";
import { appendAudit } from "./pause-command.js";

/**
 * RFX-083 — a team's policy, published as a signed snapshot and subscribed
 * to without an account (ADR-018).
 *
 * The publishing side (`rfx policy keygen`, `rfx policy snapshot`) runs
 * wherever the team keeps its policy: a repository's CI, an administrator's
 * machine. The subscribing side (`rfx policy subscribe`, `unsubscribe`)
 * runs on every member's machine and records only the location and the
 * public key; the daemon does the fetching (`apps/decision-gateway`,
 * `orchestration/subscription.ts`).
 */
export const PRIVATE_KEY_FILE = "reflex-policy-key.pem";
export const PUBLIC_KEY_FILE = "reflex-policy-key.pub";

export type KeygenResult =
  | {
      readonly kind: "written";
      readonly privateKeyPath: string;
      readonly publicKeyPath: string;
      readonly keyId: string;
    }
  | { readonly kind: "exists"; readonly privateKeyPath: string }
  | { readonly kind: "write-failed"; readonly privateKeyPath: string };

function resolveFrom(environment: Environment, path: string): string {
  return isAbsolute(path) ? path : resolve(environment.projectDir, path);
}

/** A fresh Ed25519 pair, the private half readable by its owner only. Never overwrites. */
export async function generateKeys(
  environment: Environment,
  fileSystem: FileSystemPort,
  options: { readonly out?: string } = {},
): Promise<KeygenResult> {
  const directory =
    options.out === undefined
      ? join(reflexHome(environment), "keys")
      : resolveFrom(environment, options.out);
  const privateKeyPath = join(directory, PRIVATE_KEY_FILE);
  const publicKeyPath = join(directory, PUBLIC_KEY_FILE);
  if ((await fileSystem.read(privateKeyPath)) !== undefined) {
    return { kind: "exists", privateKeyPath };
  }
  const keys = generateSnapshotKeys();
  try {
    await fileSystem.write(
      privateKeyPath,
      Buffer.from(keys.privateKeyPem, "utf8"),
      STATE_FILE_MODE,
    );
    await fileSystem.write(
      publicKeyPath,
      Buffer.from(keys.publicKeyPem, "utf8"),
      0o644,
    );
  } catch {
    return { kind: "write-failed", privateKeyPath };
  }
  await appendAudit(reflexHome(environment), {
    at: environment.now().toISOString(),
    kind: "policy-keygen",
    detail: { publicKeyPath, keyId: keys.keyId },
  });
  return { kind: "written", privateKeyPath, publicKeyPath, keyId: keys.keyId };
}

export interface SnapshotCommandOptions {
  /** The organization's policy file. */
  readonly policy: string;
  /** `production=./production.yaml`, one per environment. */
  readonly environments: readonly string[];
  /** The private key file. */
  readonly key: string;
  /** The team's own label for this version. */
  readonly label: string;
  readonly out: string;
}

export type SnapshotCommandResult =
  | {
      readonly kind: "written";
      readonly path: string;
      readonly version: string;
      readonly hash: string;
      readonly keyId: string;
      readonly sources: number;
    }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "write-failed"; readonly path: string };

async function readPolicySource(
  environment: Environment,
  fileSystem: FileSystemPort,
  path: string,
  source: SnapshotSourceInput["source"],
  env?: EnvironmentKind,
): Promise<
  { ok: true; input: SnapshotSourceInput } | { ok: false; reason: string }
> {
  const file = await fileSystem.read(resolveFrom(environment, path));
  if (file === undefined) {
    return { ok: false, reason: `${path} cannot be read` };
  }
  const parsed = parsePolicy(file.content.toString("utf8"));
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `${path}: ${parsed.issues
        .map((issue) => `${String(issue.line)}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  if (parsed.environments !== undefined) {
    // A mapping says where a project is; a snapshot says what to do there.
    return {
      ok: false,
      reason: `${path}: an environments mapping belongs in a project's .reflex/policy.yaml, not in a snapshot`,
    };
  }
  return {
    ok: true,
    input: {
      source,
      ...(env === undefined ? {} : { environment: env }),
      document: parsed.document,
    },
  };
}

/** Compiles and signs the team's documents into one snapshot file. */
export async function writeSnapshot(
  environment: Environment,
  fileSystem: FileSystemPort,
  options: SnapshotCommandOptions,
): Promise<SnapshotCommandResult> {
  const organization = await readPolicySource(
    environment,
    fileSystem,
    options.policy,
    "organization",
  );
  if (!organization.ok) {
    return { kind: "invalid", reason: organization.reason };
  }
  const sources: SnapshotSourceInput[] = [organization.input];
  for (const entry of options.environments) {
    const separator = entry.indexOf("=");
    const name = separator === -1 ? "" : entry.slice(0, separator);
    const path = separator === -1 ? "" : entry.slice(separator + 1);
    if (
      !(MAPPABLE_ENVIRONMENTS as readonly string[]).includes(name) ||
      path === ""
    ) {
      return {
        kind: "invalid",
        reason: `--environment takes <environment>=<file>, where the environment is one of ${MAPPABLE_ENVIRONMENTS.join(", ")}`,
      };
    }
    const read = await readPolicySource(
      environment,
      fileSystem,
      path,
      "environment",
      name as EnvironmentKind,
    );
    if (!read.ok) {
      return { kind: "invalid", reason: read.reason };
    }
    sources.push(read.input);
  }
  const keyFile = await fileSystem.read(resolveFrom(environment, options.key));
  if (keyFile === undefined) {
    return { kind: "invalid", reason: `${options.key} cannot be read` };
  }
  const created = createPolicySnapshot({
    sources,
    version: options.label,
    publishedAt: environment.now(),
    privateKey: keyFile.content.toString("utf8"),
  });
  if (!created.ok) {
    return { kind: "invalid", reason: created.reason };
  }
  const path = resolveFrom(environment, options.out);
  try {
    await fileSystem.write(
      path,
      Buffer.from(serializeSnapshot(created.snapshot), "utf8"),
      0o644,
    );
  } catch {
    return { kind: "write-failed", path };
  }
  await appendAudit(reflexHome(environment), {
    at: environment.now().toISOString(),
    kind: "policy-snapshot",
    detail: {
      path,
      version: created.snapshot.version,
      hash: created.snapshot.hash,
    },
  });
  return {
    kind: "written",
    path,
    version: created.snapshot.version,
    hash: created.snapshot.hash,
    keyId: created.snapshot.signature.keyId,
    sources: sources.length,
  };
}

export type SubscribeResult =
  | {
      readonly kind: "subscribed";
      readonly location: string;
      readonly keyId: string;
      /** What the first fetch said; the daemon keeps trying either way. */
      readonly first: RefreshOutcome;
    }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "write-failed" };

/**
 * Records the subscription and fetches once, so that the user sees right
 * away whether the location and the key agree. The daemon is stopped: the
 * next hook call starts one that reads the subscription.
 */
export async function subscribe(
  environment: Environment,
  fileSystem: FileSystemPort,
  options: { readonly location: string; readonly key: string },
): Promise<SubscribeResult> {
  const location =
    options.location.startsWith("https://") ||
    options.location.startsWith("file://")
      ? options.location
      : resolveFrom(environment, options.location);
  if (classifyLocation(location) === undefined) {
    return {
      kind: "invalid",
      reason:
        "the location must be an https: URL, a file: URL or a path; plain http: is refused",
    };
  }
  const keyFile = await fileSystem.read(resolveFrom(environment, options.key));
  if (keyFile === undefined) {
    return { kind: "invalid", reason: `${options.key} cannot be read` };
  }
  const publicKeyPem = keyFile.content.toString("utf8");
  let keyId: string;
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") {
      return {
        kind: "invalid",
        reason: "the key is not an Ed25519 public key",
      };
    }
    keyId = keyIdOf(key);
  } catch {
    return { kind: "invalid", reason: `${options.key} is not a public key` };
  }
  const home = reflexHome(environment);
  try {
    await fileSystem.write(
      subscriptionPath(home),
      Buffer.from(
        serializeSubscription({
          version: 1,
          location,
          publicKeyPem,
          subscribedAt: environment.now().toISOString(),
        }),
        "utf8",
      ),
      STATE_FILE_MODE,
    );
  } catch {
    return { kind: "write-failed" };
  }
  const holder = await createSubscriptionHolder({
    home,
    clock: environment.now,
  });
  const first = await holder.refresh();
  await stopDaemon(home);
  await appendAudit(home, {
    at: environment.now().toISOString(),
    kind: "policy-subscribe",
    detail: {
      location,
      keyId,
      first: first.kind,
      ...(first.kind === "applied" ? { version: first.version } : {}),
    },
  });
  return { kind: "subscribed", location, keyId, first };
}

export type UnsubscribeResult =
  | { readonly kind: "unsubscribed"; readonly location: string }
  | { readonly kind: "not-subscribed" }
  | { readonly kind: "write-failed" };

export async function unsubscribe(
  environment: Environment,
  fileSystem: FileSystemPort,
): Promise<UnsubscribeResult> {
  const home = reflexHome(environment);
  const record = parseSubscriptionRecord(
    (await fileSystem.read(subscriptionPath(home)))?.content.toString("utf8"),
  );
  if (record === undefined) {
    return { kind: "not-subscribed" };
  }
  try {
    await fileSystem.remove(subscriptionPath(home));
    await fileSystem.remove(snapshotCachePath(home));
  } catch {
    return { kind: "write-failed" };
  }
  await stopDaemon(home);
  await appendAudit(home, {
    at: environment.now().toISOString(),
    kind: "policy-unsubscribe",
    detail: { location: record.location },
  });
  return { kind: "unsubscribed", location: record.location };
}

/** What `rfx status`, `rfx doctor` and `rfx explain` know, from the files alone: no fetch. */
export async function readTeamPolicy(
  environment: Environment,
): Promise<SubscriptionState> {
  const holder = await createSubscriptionHolder({
    home: reflexHome(environment),
    clock: environment.now,
  });
  return holder.state();
}

export function describeTeamPolicy(state: SubscriptionState): string {
  if (!state.subscribed) {
    return state.problem === undefined
      ? 'none ("rfx policy subscribe <location> --key <public key>")'
      : `unusable subscription: ${state.problem}`;
  }
  const where = state.location ?? "?";
  if (state.current === undefined) {
    return `subscribed to ${where}, nothing in force yet${state.lastError === undefined ? "" : ` (${state.lastError})`}`;
  }
  return `${state.current.version} (${state.current.hash.slice(0, 19)}...) from ${where}${state.lastError === undefined ? "" : `; last fetch failed (${state.lastError}), this one stays in force`}`;
}
