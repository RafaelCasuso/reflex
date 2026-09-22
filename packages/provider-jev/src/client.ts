import type { SemanticDecisionRequest } from "@reflex/contracts";
import {
  providerError,
  type ProviderErrorKind,
  type ProviderResult,
  type SemanticDecisionProvider,
} from "@reflex/semantic-provider";

import {
  questionsFor,
  type BooleanQuestionForm,
  type Dimension,
  type JevQuestion,
} from "./questions.js";
import { parseJevResponse } from "./response.js";
import { stateOf, type JevState } from "./state.js";

/**
 * RFX-026, RFX-028 — the Jev client boundary.
 *
 * One request per assessment, eleven questions in it (RFX-107: one call
 * beats eleven). The key is given, never read from the environment here,
 * and never appears in a result. The deadline is the request's; the caller's
 * signal cancels. No retry, ever, on this path: a retry spends the latency
 * budget twice, and the decision has a fallback for that (ADR-003).
 */
export const JEV_PROVIDER_NAME = "jev";
export const JEV_DEFAULT_MODEL = "jev-1.13.0";
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export interface JevRequestBody {
  readonly state: JevState;
  readonly model: string;
  readonly questions: Readonly<Record<Dimension, JevQuestion>>;
}

export interface JevUsage {
  readonly status: number;
  readonly latencyMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface JevProviderOptions {
  readonly apiKey: string;
  /** A versioned id. An alias moves when a release ships. */
  readonly model?: string;
  readonly endpoint?: string;
  readonly booleanForm?: BooleanQuestionForm;
  /** For tests. `globalThis.fetch` otherwise, which keeps connections open. */
  readonly fetch?: typeof fetch;
  /** Off the decision path: tokens and status, never content. */
  readonly onUsage?: (usage: JevUsage) => void;
}

const ALIAS = /latest|preview/;

export function buildJevRequest(
  request: SemanticDecisionRequest,
  model: string,
  booleanForm: BooleanQuestionForm,
): JevRequestBody {
  return {
    state: stateOf(request),
    model,
    questions: questionsFor(booleanForm),
  };
}

function kindOfStatus(status: number): ProviderErrorKind {
  if (status === 429) {
    return "rate-limited";
  }
  if (status === 401 || status === 403 || status === 400 || status === 422) {
    return "rejected-request";
  }
  return "unavailable";
}

export function createJevProvider(
  options: JevProviderOptions,
): SemanticDecisionProvider {
  const model = options.model ?? JEV_DEFAULT_MODEL;
  if (ALIAS.test(model)) {
    throw new RangeError("pin a versioned Jev model, never an alias");
  }
  if (options.apiKey === "") {
    throw new RangeError("a Jev provider needs an API key");
  }
  const endpoint = options.endpoint ?? JEV_ENDPOINT;
  const booleanForm = options.booleanForm ?? "choice";
  const doFetch = options.fetch ?? globalThis.fetch;
  const headers = {
    authorization: `Bearer ${options.apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
  };

  const failure = (
    kind: ProviderErrorKind,
    started: number,
  ): ProviderResult => ({
    ok: false,
    error: providerError(kind, JEV_PROVIDER_NAME, performance.now() - started),
  });

  return {
    providerName: JEV_PROVIDER_NAME,
    model,

    async evaluate(request, signal) {
      const started = performance.now();
      const deadline = AbortSignal.timeout(Math.max(1, request.deadlineMs));
      const combined =
        signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
      const body = JSON.stringify(buildJevRequest(request, model, booleanForm));

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers,
          body,
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
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        json = undefined;
      }
      options.onUsage?.({
        status: response.status,
        latencyMs: Math.round(latencyMs),
        ...(typeof json === "object" &&
        json !== null &&
        "usage" in json &&
        typeof json.usage === "object" &&
        json.usage !== null
          ? usageOf(json.usage)
          : {}),
      });

      if (!response.ok) {
        return failure(kindOfStatus(response.status), started);
      }
      if (json === undefined) {
        return failure("invalid-response", started);
      }
      const parsed = parseJevResponse(json, {
        expectedModel: model,
        booleanForm,
        providerName: JEV_PROVIDER_NAME,
        latencyMs,
      });
      return parsed.ok
        ? { ok: true, assessment: parsed.assessment }
        : failure("invalid-response", started);
    },
  };
}

function usageOf(
  usage: object,
): Pick<JevUsage, "inputTokens" | "outputTokens"> {
  const record = usage as Record<string, unknown>;
  return {
    ...(typeof record.input_tokens === "number"
      ? { inputTokens: record.input_tokens }
      : {}),
    ...(typeof record.output_tokens === "number"
      ? { outputTokens: record.output_tokens }
      : {}),
  };
}
