import type { DecisionId } from "@reflex/contracts";

import { requestOverSocket } from "../daemon/client.js";
import { daemonPaths, ensureDaemon } from "../daemon/lifecycle.js";

/**
 * RFX-125 — `rfx override <decisionId>`: a human lets one denied action
 * through, once.
 *
 * The id is the one the deny's reason line shows in the host. The human
 * runs this in a terminal; when the agent runs it through a tool, REFLEX's
 * own rule asks the human first (`reflex.protect-own-command`). The daemon
 * remembers the decision for a while, grants one pass for that very action
 * and refuses a mandatory deny; the next time the agent tries the same
 * action, it is allowed with `human_override` and recorded as the human's.
 */
export interface OverrideOptions {
  readonly home: string;
  readonly nodePath: string;
  readonly daemonEntry?: string;
}

export type OverrideOutcome =
  | { readonly kind: "granted"; readonly expiresAt: string }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly message: string;
    }
  | { readonly kind: "unreachable" | "malformed" };

export const REFUSAL_HINTS: Readonly<Record<number, string>> = {
  404: "The daemon does not remember that decision: it restarted since, or the deny is older than its window. Let the agent try again, then override the new decision id.",
  403: "A mandatory deny holds whatever anyone says. Change the policy that makes it mandatory, with whoever owns it.",
  409: "Nothing to do: that decision did not deny, or it was already overridden (one override per decision; a new deny has a new id).",
};

export async function overrideDecision(
  decisionId: DecisionId,
  options: OverrideOptions,
): Promise<OverrideOutcome> {
  const ensured = await ensureDaemon({
    home: options.home,
    nodePath: options.nodePath,
    startedBy: "override",
    ...(options.daemonEntry === undefined
      ? {}
      : { entry: options.daemonEntry }),
  });
  if (!ensured.ok) {
    return { kind: "unreachable" };
  }
  const result = await requestOverSocket({
    socketPath: daemonPaths(options.home).socketPath,
    method: "POST",
    path: "/v1/overrides",
    body: JSON.stringify({ decisionId }),
    timeoutMs: 2_000,
  });
  if (!result.ok) {
    return { kind: "unreachable" };
  }
  const { status, json } = result.response;
  if (status === 200) {
    const expiresAt =
      typeof json === "object" &&
      json !== null &&
      "expiresAt" in json &&
      typeof json.expiresAt === "string"
        ? json.expiresAt
        : undefined;
    return expiresAt === undefined
      ? { kind: "malformed" }
      : { kind: "granted", expiresAt };
  }
  const message =
    typeof json === "object" &&
    json !== null &&
    "error" in json &&
    typeof json.error === "object" &&
    json.error !== null &&
    "message" in json.error &&
    typeof json.error.message === "string"
      ? json.error.message
      : undefined;
  return message === undefined
    ? { kind: "malformed" }
    : { kind: "refused", status, message };
}
