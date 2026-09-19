import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  readHookInput,
  type ClaudeHookEvent,
  type ClaudeToolEvent,
} from "./hook-input.js";

const FIXTURES = new URL("../fixtures/claude-code-2.1/", import.meta.url);

export function fixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`${name}.json`, FIXTURES)), "utf8");
}

export function fixtureEvent(name: string): ClaudeHookEvent {
  const result = readHookInput(fixtureText(name));
  if (!result.ok) {
    throw new Error(`fixture ${name} is unreadable: ${result.reason}`);
  }
  return result.event;
}

export function toolEvent(name: string): ClaudeToolEvent {
  const event = fixtureEvent(name);
  if (event.kind !== "tool") {
    throw new Error(`fixture ${name} is not a tool event`);
  }
  return event;
}

/** A fixture payload with fields replaced, as the text the host would send. */
export function tampered(
  name: string,
  fields: Record<string, unknown>,
): string {
  const payload = JSON.parse(fixtureText(name)) as Record<string, unknown>;
  return JSON.stringify({ ...payload, ...fields });
}

export const FIXED_NOW = (): Date => new Date("2026-09-19T09:00:00.000Z");
