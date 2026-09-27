import { createHash, randomBytes } from "node:crypto";

import type { ActionId, SessionId } from "@reflex/contracts";

/**
 * Canonical IDs for Codex events.
 *
 * The host runs the hook as a new process for every event, so nothing can be
 * remembered between "this tool is about to run" and "this tool ran". IDs are
 * therefore derived, not minted: every event about the same tool call yields
 * the same `ActionId`, with no lookup and no shared state. The host's own
 * identifiers are hashed, not embedded (ADR-013).
 */
const HOST = "codex";

function digest(length: number, ...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(`${String(part.length)}:${part}`);
  }
  return hash.digest("hex").slice(0, length);
}

export function deriveSessionId(hostSessionId: string): SessionId {
  return `ses_${digest(24, HOST, hostSessionId)}`;
}

/**
 * `undefined` when the host gave no tool-use identifier (`PermissionRequest`
 * carries none, by its documentation): without one, later events cannot be
 * tied to this action, and pretending otherwise would attribute one action's
 * outcome to another.
 */
export function deriveActionId(
  hostSessionId: string | undefined,
  toolUseId: string | undefined,
): ActionId | undefined {
  if (toolUseId === undefined) {
    return undefined;
  }
  return `act_${digest(32, HOST, hostSessionId ?? "", toolUseId)}`;
}

/** For an action that can never be correlated. Unique, and says nothing. */
export function randomActionId(): ActionId {
  return `act_${randomBytes(16).toString("hex")}`;
}
