import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { CanonicalAction, PolicyRule } from "@reflex-control/contracts";
import {
  compilePolicySet,
  parsePolicy,
  type CompiledPolicySet,
  type PolicySourceDocument,
} from "@reflex-control/policy-engine";

/**
 * RFX-104 / RFX-054 — one project's policy, served to that project.
 *
 * A repository may carry `.reflex/policy.yaml`. It is the `project` source
 * of ADR-004, and it is **untrusted until the user trusts it** (ADR-012):
 * untrusted, its deny and ask rules apply and its allow rules are ignored,
 * so a hostile clone can make REFLEX stricter and never looser. Trust is
 * bound to the file's content hash and recorded by `rfx trust` (or by
 * `rfx init`, for the starter it just wrote) in `<REFLEX_HOME>/trust.json`;
 * a changed file is untrusted again until the user looks at it.
 *
 * On the hot path this costs a few `stat` calls: the file is looked for
 * from the action's working directory upward, never above the user's home
 * or the filesystem root, and every reading is cached by path, size and
 * modification time; the compiled set is cached by the hashes it is made
 * of. A project policy that does not parse is dropped and reported; the
 * user's own policy and REFLEX's rules stay in force (ADR-003 §3).
 */
export const PROJECT_POLICY_RELATIVE = join(".reflex", "policy.yaml");
export const TRUST_RECORD_VERSION = 1;

export interface TrustRecord {
  readonly version: typeof TRUST_RECORD_VERSION;
  readonly trusted: readonly TrustedPolicy[];
}

export interface TrustedPolicy {
  /** The policy file, absolute. */
  readonly path: string;
  /** `sha256:` of the file's bytes when it was trusted. */
  readonly policyHash: string;
  readonly trustedAt: string;
}

export function trustFilePath(home: string): string {
  return join(home, "trust.json");
}

export function policyHashOf(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A trust file REFLEX cannot read trusts nothing. */
export function parseTrustRecord(text: string | undefined): TrustRecord {
  const none: TrustRecord = { version: TRUST_RECORD_VERSION, trusted: [] };
  if (text === undefined) {
    return none;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      !isRecord(parsed) ||
      parsed.version !== TRUST_RECORD_VERSION ||
      !Array.isArray(parsed.trusted)
    ) {
      return none;
    }
    const trusted = (parsed.trusted as unknown[]).flatMap(
      (entry): TrustedPolicy[] =>
        isRecord(entry) &&
        typeof entry.path === "string" &&
        typeof entry.policyHash === "string" &&
        /^sha256:[0-9a-f]{64}$/.test(entry.policyHash) &&
        typeof entry.trustedAt === "string"
          ? [
              {
                path: entry.path,
                policyHash: entry.policyHash,
                trustedAt: entry.trustedAt,
              },
            ]
          : [],
    );
    return { version: TRUST_RECORD_VERSION, trusted };
  } catch {
    return none;
  }
}

export function isTrusted(
  record: TrustRecord,
  path: string,
  policyHash: string,
): boolean {
  return record.trusted.some(
    (entry) => entry.path === path && entry.policyHash === policyHash,
  );
}

/** The record with this file trusted at this content, replacing an older trust of the same file. */
export function withTrust(
  record: TrustRecord,
  path: string,
  policyHash: string,
  now: Date,
): TrustRecord {
  return {
    version: TRUST_RECORD_VERSION,
    trusted: [
      ...record.trusted.filter((entry) => entry.path !== path),
      { path, policyHash, trustedAt: now.toISOString() },
    ],
  };
}

export function withoutTrust(record: TrustRecord, path: string): TrustRecord {
  return {
    version: TRUST_RECORD_VERSION,
    trusted: record.trusted.filter((entry) => entry.path !== path),
  };
}

/**
 * The nearest `.reflex/policy.yaml` at or above `cwd`, stopping before the
 * user's home directory and at the filesystem root. The home itself holds
 * REFLEX's own files, never a project's. `undefined` when there is none.
 */
export function findProjectPolicy(
  cwd: string,
  home: string | undefined,
  exists: (path: string) => boolean = (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
): string | undefined {
  let directory = resolve(cwd);
  const stop = home === undefined ? undefined : resolve(home);
  for (;;) {
    if (directory === stop) {
      return undefined;
    }
    const candidate = join(directory, PROJECT_POLICY_RELATIVE);
    if (exists(candidate)) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

export interface ProjectPolicyReading {
  readonly path: string;
  readonly policyHash: string;
  readonly trusted: boolean;
  /** Parse problems, when the file could not be used. */
  readonly problems: readonly string[];
  /** The rules an untrusted policy is not allowed to apply. */
  readonly allowRules: readonly PolicyRule[];
  /** The parsed source, when the file loaded. */
  readonly source?: PolicySourceDocument;
}

export interface ProjectPolicyComposerOptions {
  readonly home: string | undefined;
  /** `trust.json`; absent means nothing is trusted. */
  readonly trustFile: string | undefined;
  /** The user's own policy sources, compiled into every set. */
  readonly userSources: () => readonly PolicySourceDocument[];
  readonly clock?: () => number;
  /** How long a working directory's lookup result is reused. */
  readonly lookupTtlMs?: number;
}

export interface ProjectPolicyComposer {
  /** The set for this action: the user's sources plus the project's, if any. */
  readonly setFor: (action: CanonicalAction) => CompiledPolicySet;
  /** What the composer knows about one project policy file, for `rfx status` and `rfx doctor`. */
  readonly inspect: (cwd: string) => ProjectPolicyReading | undefined;
  /** Project policies that failed to parse since start. */
  readonly problems: () => readonly string[];
}

interface FileReading {
  readonly size: number;
  readonly mtimeMs: number;
  readonly text: string;
  readonly policyHash: string;
}

const DEFAULT_LOOKUP_TTL_MS = 2_000;

export function createProjectPolicyComposer(
  options: ProjectPolicyComposerOptions,
): ProjectPolicyComposer {
  const clock = options.clock ?? Date.now;
  const lookupTtlMs = options.lookupTtlMs ?? DEFAULT_LOOKUP_TTL_MS;
  const lookups = new Map<string, { path: string | undefined; at: number }>();
  const files = new Map<string, FileReading>();
  const sets = new Map<string, CompiledPolicySet>();
  const parsed = new Map<
    string,
    { problems: readonly string[]; source?: PolicySourceDocument }
  >();
  let trust:
    | {
        mtimeMs: number;
        size: number;
        record: ReturnType<typeof parseTrustRecord>;
      }
    | undefined;
  const reported: string[] = [];

  const readCached = (path: string): FileReading | undefined => {
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(path);
    } catch {
      files.delete(path);
      return undefined;
    }
    const cached = files.get(path);
    if (cached?.size === info.size && cached.mtimeMs === info.mtimeMs) {
      return cached;
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      files.delete(path);
      return undefined;
    }
    const reading: FileReading = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      text,
      policyHash: policyHashOf(text),
    };
    files.set(path, reading);
    return reading;
  };

  const trustRecord = (): ReturnType<typeof parseTrustRecord> => {
    if (options.trustFile === undefined) {
      return parseTrustRecord(undefined);
    }
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(options.trustFile);
    } catch {
      trust = undefined;
      return parseTrustRecord(undefined);
    }
    if (trust?.mtimeMs === info.mtimeMs && trust.size === info.size) {
      return trust.record;
    }
    let text: string | undefined;
    try {
      text = readFileSync(options.trustFile, "utf8");
    } catch {
      text = undefined;
    }
    trust = {
      mtimeMs: info.mtimeMs,
      size: info.size,
      record: parseTrustRecord(text),
    };
    return trust.record;
  };

  const locate = (cwd: string): string | undefined => {
    const now = clock();
    const known = lookups.get(cwd);
    if (known !== undefined && now - known.at < lookupTtlMs) {
      return known.path;
    }
    const path = findProjectPolicy(cwd, options.home);
    lookups.set(cwd, { path, at: now });
    if (lookups.size > 1_000) {
      lookups.clear();
    }
    return path;
  };

  const parseCached = (
    path: string,
    reading: FileReading,
    trusted: boolean,
  ): { problems: readonly string[]; source?: PolicySourceDocument } => {
    const key = `${reading.policyHash}|${String(trusted)}`;
    const cached = parsed.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const result = parsePolicy(reading.text);
    const entry: {
      problems: readonly string[];
      source?: PolicySourceDocument;
    } = result.ok
      ? {
          problems: [],
          source: {
            source: "project",
            trusted,
            document: result.document,
          },
        }
      : {
          problems: result.issues.map(
            (issue) => `${path}:${String(issue.line)}: ${issue.message}`,
          ),
        };
    if (!result.ok) {
      for (const problem of entry.problems) {
        if (!reported.includes(problem)) {
          reported.push(problem);
        }
      }
    }
    parsed.set(key, entry);
    if (parsed.size > 100) {
      parsed.clear();
    }
    return entry;
  };

  const reading = (cwd: string): ProjectPolicyReading | undefined => {
    const path = locate(cwd);
    if (path === undefined) {
      return undefined;
    }
    const file = readCached(path);
    if (file === undefined) {
      return undefined;
    }
    const trusted = isTrusted(trustRecord(), path, file.policyHash);
    const result = parseCached(path, file, trusted);
    return {
      path,
      policyHash: file.policyHash,
      trusted,
      problems: result.problems,
      allowRules:
        result.source?.document.rules.filter(
          (rule) => rule.effect === "allow",
        ) ?? [],
      ...(result.source === undefined ? {} : { source: result.source }),
    };
  };

  return {
    setFor(action) {
      const userSources = options.userSources();
      const cwd = action.repository?.root ?? action.cwd;
      const project = cwd === undefined ? undefined : reading(cwd);
      const projectSource = project?.source;
      const key = [
        ...userSources.map(
          (source) =>
            `${source.source}:${String(source.trusted)}:${policyHashOf(JSON.stringify(source.document))}`,
        ),
        projectSource === undefined
          ? "project:none"
          : `project:${String(project?.trusted)}:${project?.policyHash ?? ""}`,
      ].join("|");
      const cached = sets.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const compiled = compilePolicySet([
        ...userSources,
        ...(projectSource === undefined ? [] : [projectSource]),
      ]);
      // A set that does not compile with the project source falls back to
      // the user's alone (ADR-003 §3); the problem is reported.
      let set: CompiledPolicySet;
      if (compiled.ok) {
        set = compiled.set;
      } else {
        for (const problem of compiled.problems) {
          if (!reported.includes(problem)) {
            reported.push(problem);
          }
        }
        const without = compilePolicySet([...userSources]);
        set = without.ok
          ? without.set
          : (compilePolicySet([]) as { ok: true; set: CompiledPolicySet }).set;
      }
      sets.set(key, set);
      if (sets.size > 50) {
        sets.clear();
      }
      return set;
    },
    inspect: reading,
    problems: () => reported,
  };
}
