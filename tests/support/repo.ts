import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root. */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export type StringRecord = Readonly<Record<string, string>>;

/** The subset of package.json the integrity tests reason about. */
export interface PackageManifest {
  readonly name: string;
  readonly isPrivate: boolean;
  readonly packageManager: string | undefined;
  readonly scripts: StringRecord;
  readonly engines: StringRecord;
  /** Every dependency field merged: an edge is an edge wherever declared. */
  readonly allDependencies: StringRecord;
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export function repoPath(...segments: readonly string[]): string {
  return join(REPO_ROOT, ...segments);
}

export function readText(...segments: readonly string[]): string {
  return readFileSync(repoPath(...segments), "utf8");
}

export function readJson(...segments: readonly string[]): unknown {
  return JSON.parse(readText(...segments)) as unknown;
}

export function readManifest(...segments: readonly string[]): PackageManifest {
  const path = join(...segments, "package.json");
  return parseManifest(readJson(path), path);
}

/** Pure, so the dependency-field merge can be tested adversarially. */
export function parseManifest(raw: unknown, label: string): PackageManifest {
  if (!isRecord(raw) || typeof raw.name !== "string") {
    throw new TypeError(`${label} is not a package manifest with a name`);
  }

  const packageManager = raw.packageManager;

  return {
    name: raw.name,
    isPrivate: raw.private === true,
    packageManager:
      typeof packageManager === "string" ? packageManager : undefined,
    scripts: toStringRecord(raw.scripts, `${label}#scripts`),
    engines: toStringRecord(raw.engines, `${label}#engines`),
    allDependencies: Object.assign(
      {},
      ...DEPENDENCY_FIELDS.map((field) =>
        toStringRecord(raw[field], `${label}#${field}`),
      ),
    ) as StringRecord,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringRecord(value: unknown, label: string): StringRecord {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new TypeError(`${label}.${key} must be a string`);
    }
    result[key] = entry;
  }
  return result;
}
