import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Test support: the documented payloads under `fixtures/`. */
const FIXTURES = new URL("../fixtures/codex-hooks-doc/", import.meta.url);

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`${name}.json`, FIXTURES)), "utf8");
}

export function fixtureNames(): string[] {
  return readdirSync(fileURLToPath(FIXTURES))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

export const FIXED_NOW = () => new Date("2026-09-27T12:00:00.000Z");
