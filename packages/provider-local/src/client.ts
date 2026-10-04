import { performance } from "node:perf_hooks";
import { URL } from "node:url";

import {
  parseSemanticAssessment,
  type ProviderErrorKind,
  type SemanticAssessment,
} from "@reflex-control/contracts";
import {
  providerError,
  type ProviderResult,
  type SemanticDecisionProvider,
} from "@reflex-control/semantic-provider";

/**
 * RFX-144 — the local provider client.
 *
 * One `POST` per assessment to a server on this machine, over a kept
 * connection, never retried on the decision path. The request goes as it
 * is: the canonical `SemanticDecisionRequest`, already redacted and
 * bounded by the compiler (ADR-006). The answer is read strictly with the
 * contract's own parser: a partial or malformed assessment is a failure,
 * never a default (ADR-005 §3), and the model the server declares must be
 * the one that was asked for, so that a checkpoint swapped under the
 * server cannot answer in another's name.
 */
export const LOCAL_PROVIDER_NAME = "local";
export const LOCAL_DEFAULT_ENDPOINT = "http://127.0.0.1:8765/v1/assess";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** True for an `http://` URL on this machine: what `onMachine` promises. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    LOOPBACK_HOSTS.has(url.hostname)
  );
}

export interface LocalUsage {
  readonly status: number;
  readonly latencyMs: number;
}

export interface LocalProviderOptions {
  /** The checkpoint the server must declare, pinned: `rdm-0.1.0`, `laya-1.0.0`. */
  readonly model: string;
  /** `http://127.0.0.1:<port>/v1/assess` by default. Loopback only. */
  readonly endpoint?: string;
  /** For tests. `globalThis.fetch` otherwise, which keeps connections open. */
  readonly fetch?: typeof fetch;
  /** Off the decision path: status and latency, never content. */
  readonly onUsage?: (usage: LocalUsage) => void;
}

const ALIAS = /latest|preview/;

function kindOfStatus(status: number): ProviderErrorKind {
  if (status === 429) {
    return "rate-limited";
  }
  if (status === 400 || status === 401 || status === 403 || status === 422) {
    return "rejected-request";
  }
  return "unavailable";
}

export function createLocalProvider(
  options: LocalProviderOptions,
): SemanticDecisionProvider {
  const model = options.model;
  if (model === "" || ALIAS.test(model)) {
    throw new RangeError(
      "pin the local checkpoint to a version, never an alias",
    );
  }
  const endpoint = options.endpoint ?? LOCAL_DEFAULT_ENDPOINT;
  if (!isLoopbackEndpoint(endpoint)) {
    // ADR-010: what a local provider is given never leaves the machine.
    throw new RangeError(
      "a local provider talks to this machine only: the endpoint must be on 127.0.0.1, ::1 or localhost",
    );
  }
  const doFetch = options.fetch ?? globalThis.fetch;
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  };

  const failure = (
    kind: ProviderErrorKind,
    started: number,
  ): ProviderResult => ({
    ok: false,
    error: providerError(
      kind,
      LOCAL_PROVIDER_NAME,
      performance.now() - started,
    ),
  });

  return {
    providerName: LOCAL_PROVIDER_NAME,
    model,
    onMachine: true,

    async evaluate(request, signal) {
      const started = performance.now();
      const deadline = AbortSignal.timeout(Math.max(1, request.deadlineMs));
      const combined =
        signal === undefined ? deadline : AbortSignal.any([signal, deadline]);

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal: combined,
        });
      } catch {
        if (deadline.aborted) {
          return failure("timeout", started);
        }
        if (signal?.aborted === true) {
          return failure("aborted", started);
        }
        return failure("unavailable", started);
      }

      const latencyMs = performance.now() - started;
      options.onUsage?.({
        status: response.status,
        latencyMs: Math.round(latencyMs),
      });
      if (!response.ok) {
        return failure(kindOfStatus(response.status), started);
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        return failure("invalid-response", started);
      }
      const parsed = parseSemanticAssessment(json);
      if (!parsed.ok) {
        return failure("invalid-response", started);
      }
      if (parsed.value.model !== model) {
        // The server serves a checkpoint; it answers in its own name, and
        // that name must be the one that was asked for.
        return failure("invalid-response", started);
      }
      const assessment: SemanticAssessment = {
        ...parsed.value,
        provider: LOCAL_PROVIDER_NAME,
        latencyMs: Math.max(0, Math.round(latencyMs)),
      };
      return { ok: true, assessment };
    },
  };
}
