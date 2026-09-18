import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ValidationIssue, ValidationResult } from "./index.js";

/**
 * Test support: frozen fixtures and small helpers for building hostile input.
 * Excluded from the build (tsconfig.build.json).
 */
const FIXTURES_ROOT = new URL("../fixtures/", import.meta.url);

export type JsonRecord = Record<string, unknown>;

export function fixtureVersions(): string[] {
  return readdirSync(fileURLToPath(FIXTURES_ROOT), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function fixtureFiles(version: string): string[] {
  return readdirSync(fileURLToPath(new URL(`${version}/`, FIXTURES_ROOT)))
    .filter((file) => file.endsWith(".json"))
    .sort();
}

/** Raw bytes as text, line endings normalized so checksums survive Windows. */
export function readFixtureText(version: string, file: string): string {
  return readFileSync(
    fileURLToPath(new URL(`${version}/${file}`, FIXTURES_ROOT)),
    "utf8",
  ).replaceAll("\r\n", "\n");
}

/** A fresh, mutable copy on every call: tests tamper with it freely. */
export function loadFixture(file: string, version = "v1.0"): JsonRecord {
  const parsed: unknown = JSON.parse(readFixtureText(version, file));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${version}/${file} is not a JSON object`);
  }
  return parsed as JsonRecord;
}

/** Returns a deep copy of `source` with the value at `path` replaced. */
export function withValue(
  source: JsonRecord,
  path: readonly string[],
  value: unknown,
): JsonRecord {
  const copy = structuredClone(source);
  const parent = parentOf(copy, path);
  parent[lastOf(path)] = value;
  return copy;
}

/** Returns a deep copy of `source` with the key at `path` removed. */
export function without(
  source: JsonRecord,
  path: readonly string[],
): JsonRecord {
  const copy = structuredClone(source);
  const parent = parentOf(copy, path);
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- building invalid input is the point
  delete parent[lastOf(path)];
  return copy;
}

function lastOf(path: readonly string[]): string {
  const last = path.at(-1);
  if (last === undefined) {
    throw new RangeError("path must not be empty");
  }
  return last;
}

function parentOf(root: JsonRecord, path: readonly string[]): JsonRecord {
  let current: JsonRecord = root;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (typeof next !== "object" || next === null) {
      throw new RangeError(`no object at "${segment}"`);
    }
    current = next as JsonRecord;
  }
  return current;
}

/** Narrows to the failure branch, failing the test if validation passed. */
export function issuesOf(
  result: ValidationResult<unknown>,
): readonly ValidationIssue[] {
  if (result.ok) {
    throw new Error("expected validation to fail, but it succeeded");
  }
  return result.issues;
}

/** `code:path` pairs: compact and order-insensitive to assert on. */
export function summarize(result: ValidationResult<unknown>): string[] {
  return issuesOf(result)
    .map((issue) => `${issue.code}:${issue.path}`)
    .sort();
}

/** Narrows to the success branch, failing the test with the issues if not. */
export function valueOf<T>(result: ValidationResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `expected validation to succeed: ${JSON.stringify(result.issues)}`,
    );
  }
  return result.value;
}
