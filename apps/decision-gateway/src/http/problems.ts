import type { ValidationIssue } from "@reflex/contracts";
import type { RejectionCode } from "@reflex/telemetry";

/**
 * A typed rejection. Never a stack trace, never a value from the request.
 * `code` is closed and each has one status, so a client can switch on it.
 */
export interface Problem {
  readonly status: number;
  readonly code: RejectionCode;
  readonly message: string;
  readonly issues?: readonly ValidationIssue[];
  readonly retryAfterSeconds?: number;
}

export interface ProblemBody {
  readonly error: {
    readonly code: RejectionCode;
    readonly message: string;
    readonly issues?: readonly ValidationIssue[];
  };
  readonly requestId: string;
}

export const PROBLEMS = {
  notFound: (): Problem => ({
    status: 404,
    code: "not-found",
    message: "no such route",
  }),
  methodNotAllowed: (): Problem => ({
    status: 405,
    code: "method-not-allowed",
    message: "this route takes POST",
  }),
  unsupportedMediaType: (): Problem => ({
    status: 415,
    code: "unsupported-media-type",
    message: "the body must be application/json",
  }),
  payloadTooLarge: (maxBytes: number): Problem => ({
    status: 413,
    code: "payload-too-large",
    message: `the body may not exceed ${String(maxBytes)} bytes`,
  }),
  rateLimited: (retryAfterSeconds: number): Problem => ({
    status: 429,
    code: "rate-limited",
    message: "too many requests",
    retryAfterSeconds,
  }),
  invalidRequest: (issues: readonly ValidationIssue[]): Problem => ({
    status: 400,
    code: "invalid-request",
    message: "the request is not a valid decision request",
    issues,
  }),
  notJson: (): Problem => ({
    status: 400,
    code: "invalid-request",
    message: "the body is not JSON",
  }),
  idempotencyConflict: (): Problem => ({
    status: 409,
    code: "idempotency-conflict",
    message:
      "an action with this id was already decided with different content",
  }),
  internal: (): Problem => ({
    status: 500,
    code: "internal-error",
    message: "the gateway could not decide",
  }),
} as const;

export function problemBody(problem: Problem, requestId: string): ProblemBody {
  return {
    error: {
      code: problem.code,
      message: problem.message,
      ...(problem.issues === undefined ? {} : { issues: problem.issues }),
    },
    requestId,
  };
}
