import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  parseDecisionRequest,
  type DecisionRequest,
  type ReflexDecision,
} from "@reflex/contracts";
import type { ReflexDecisionEngine } from "@reflex/core";
import {
  decisionEventsOf,
  rejectedRequestEvent,
  type TelemetrySink,
} from "@reflex/telemetry";

import { declaredLength, readBody } from "./body.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { RateLimiter } from "./limits.js";
import { PROBLEMS, problemBody, type Problem } from "./problems.js";

/**
 * RFX-021 — `POST /v1/decisions`.
 *
 * In order: the rate limit (before anything is read), the media type, the
 * size limit (before the body is read), the body, strict validation
 * (ADR-009), idempotency (RFX-120), the engine, the answer, and then, after
 * the answer has left, telemetry (RFX-023). Every way out is a typed answer
 * with the request's correlation id; nothing here throws to the server.
 */
export interface GatewayHandlerOptions {
  readonly engine: ReflexDecisionEngine;
  readonly telemetry?: TelemetrySink;
  readonly rateLimiter: RateLimiter;
  readonly idempotency: IdempotencyStore;
  readonly maxBodyBytes: number;
  /** Who a request is from, for the rate limit. One key for a local socket. */
  readonly callerOf: (request: IncomingMessage) => string;
  /** What `GET /v1/health` reports besides `ok`. */
  readonly health: () => Readonly<Record<string, unknown>>;
  readonly clock: () => Date;
  readonly monotonic: () => number;
}

export type GatewayHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DECISIONS = "/v1/decisions";
const HEALTH = "/v1/health";

function requestIdOf(request: IncomingMessage): string {
  const given = request.headers["x-request-id"];
  const value = Array.isArray(given) ? given[0] : given;
  return value !== undefined && REQUEST_ID.test(value)
    ? value
    : `req_${randomBytes(8).toString("hex")}`;
}

function isJson(request: IncomingMessage): boolean {
  const type = request.headers["content-type"] ?? "";
  return type.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function pathOf(request: IncomingMessage): string {
  const url = request.url ?? "/";
  const end = url.indexOf("?");
  return end === -1 ? url : url.slice(0, end);
}

/** The engine's fingerprint, the mode and the requested failure mode. */
function contentHashOf(
  engine: ReflexDecisionEngine,
  request: DecisionRequest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        engine.fingerprint(request.action),
        request.mode,
        request.failureMode,
      ]),
    )
    .digest("hex");
}

export function createGatewayHandler(
  options: GatewayHandlerOptions,
): GatewayHandler {
  const emit = (event: Parameters<TelemetrySink["emit"]>[0]): void => {
    if (options.telemetry === undefined) {
      return;
    }
    const sink = options.telemetry;
    // Off the decision path, and a sink that throws is its own problem.
    setImmediate(() => {
      try {
        sink.emit(event);
      } catch {
        // Telemetry never fails a decision.
      }
    });
  };

  const send = (
    response: ServerResponse,
    status: number,
    requestId: string,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): void => {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
      "cache-control": "no-store",
      "x-request-id": requestId,
      ...headers,
    });
    response.end(text);
  };

  const reject = (
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    problem: Problem,
  ): void => {
    send(response, problem.status, requestId, problemBody(problem, requestId), {
      // Whatever is left of the body is not read: once the answer is out,
      // the connection goes with it.
      connection: "close",
      ...(problem.retryAfterSeconds === undefined
        ? {}
        : { "retry-after": String(problem.retryAfterSeconds) }),
    });
    response.once("finish", () => {
      request.destroy();
    });
    emit(
      rejectedRequestEvent(
        problem.code,
        options.clock().toISOString(),
        requestId,
      ),
    );
  };

  const answer = (
    response: ServerResponse,
    requestId: string,
    decision: ReflexDecision,
    replayed: boolean,
  ): void => {
    send(response, 200, requestId, decision, {
      "x-reflex-decision-id": decision.id,
      ...(replayed ? { "x-reflex-replayed": "true" } : {}),
    });
  };

  async function decide(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ): Promise<void> {
    const verdict = options.rateLimiter.take(
      options.callerOf(request),
      options.monotonic(),
    );
    if (!verdict.allowed) {
      reject(
        request,
        response,
        requestId,
        PROBLEMS.rateLimited(verdict.retryAfterSeconds),
      );
      return;
    }
    if (!isJson(request)) {
      reject(request, response, requestId, PROBLEMS.unsupportedMediaType());
      return;
    }
    const declared = declaredLength(request);
    if (declared !== undefined && declared > options.maxBodyBytes) {
      reject(
        request,
        response,
        requestId,
        PROBLEMS.payloadTooLarge(options.maxBodyBytes),
      );
      return;
    }

    const body = await readBody(request, options.maxBodyBytes);
    if (!body.ok) {
      if (body.reason === "too-large") {
        reject(
          request,
          response,
          requestId,
          PROBLEMS.payloadTooLarge(options.maxBodyBytes),
        );
      }
      // Aborted: nobody is listening. Nothing to answer, nothing to decide.
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(body.text);
    } catch {
      reject(request, response, requestId, PROBLEMS.notJson());
      return;
    }
    const parsed = parseDecisionRequest(json);
    if (!parsed.ok) {
      reject(
        request,
        response,
        requestId,
        PROBLEMS.invalidRequest(parsed.issues),
      );
      return;
    }
    const decisionRequest = parsed.value;

    const contentHash = contentHashOf(options.engine, decisionRequest);
    const seen = options.idempotency.lookup(
      decisionRequest.action.id,
      contentHash,
      options.monotonic(),
    );
    switch (seen.kind) {
      case "replay":
        answer(response, requestId, seen.decision, true);
        return;
      case "conflict":
        reject(request, response, requestId, PROBLEMS.idempotencyConflict());
        return;
      case "new":
        break;
    }

    // A client that went away cancels the decision it asked for.
    const gone = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) {
        gone.abort();
      }
    });

    let decision: ReflexDecision;
    try {
      decision = await options.engine.decide(decisionRequest, gone.signal);
    } catch {
      // The engine does not throw for a domain outcome; this is a defect.
      reject(request, response, requestId, PROBLEMS.internal());
      return;
    }
    options.idempotency.remember(
      decisionRequest.action.id,
      contentHash,
      decision,
      options.monotonic(),
    );
    answer(response, requestId, decision, false);
    for (const event of decisionEventsOf({
      decision,
      action: decisionRequest.action,
      at: options.clock().toISOString(),
      requestId,
    })) {
      emit(event);
    }
  }

  return (request, response) => {
    const requestId = requestIdOf(request);
    const path = pathOf(request);

    if (path === HEALTH) {
      if (request.method !== "GET") {
        reject(request, response, requestId, PROBLEMS.methodNotAllowed());
        return;
      }
      send(response, 200, requestId, { status: "ok", ...options.health() });
      request.resume();
      return;
    }
    if (path !== DECISIONS) {
      reject(request, response, requestId, PROBLEMS.notFound());
      return;
    }
    if (request.method !== "POST") {
      reject(request, response, requestId, PROBLEMS.methodNotAllowed());
      return;
    }
    decide(request, response, requestId).catch(() => {
      if (!response.headersSent) {
        reject(request, response, requestId, PROBLEMS.internal());
      }
    });
  };
}
