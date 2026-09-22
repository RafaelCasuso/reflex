import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { dirname } from "node:path";

import type { ReflexDecisionEngine } from "@reflex/core";
import type { TelemetrySink } from "@reflex/telemetry";

import { createGatewayHandler } from "./http/handler.js";
import {
  DEFAULT_IDEMPOTENCY,
  IdempotencyStore,
  type IdempotencyOptions,
} from "./http/idempotency.js";
import { RateLimiter, type RateLimitOptions } from "./http/limits.js";

/**
 * @reflex/decision-gateway — the latency-sensitive runtime decision endpoint.
 *
 * One server, two ways to listen (ADR-010 implementation notes): a Unix
 * domain socket on the user's machine, private to the user, or TCP on the
 * loopback interface. Anything else needs an authenticator, which G14
 * brings, and is refused until then.
 */
export type ListenTarget =
  | { readonly kind: "socket"; readonly path: string }
  | { readonly kind: "tcp"; readonly host: string; readonly port: number };

export type ListenResult =
  | { readonly ok: true; readonly target: ListenTarget }
  | {
      readonly ok: false;
      readonly reason:
        "already-running" | "needs-authentication" | "cannot-bind";
    };

export interface GatewayLimits {
  readonly maxBodyBytes: number;
  readonly rate: RateLimitOptions;
  /** Slow clients: how long a request may take to arrive. */
  readonly requestTimeoutMs: number;
  readonly headersTimeoutMs: number;
}

export const DEFAULT_LIMITS: GatewayLimits = {
  // A shell command may carry a whole file (contracts: 1 MiB), and a Write
  // carries one in its arguments. Four times that is generous and bounded.
  maxBodyBytes: 4 * 1024 * 1024,
  rate: { burst: 300, perSecond: 100 },
  requestTimeoutMs: 10_000,
  headersTimeoutMs: 5_000,
};

export interface GatewayServerOptions {
  readonly engine: ReflexDecisionEngine;
  readonly telemetry?: TelemetrySink;
  readonly limits?: Partial<GatewayLimits>;
  readonly idempotency?: IdempotencyOptions;
  readonly health?: () => Readonly<Record<string, unknown>>;
  readonly clock?: () => Date;
  readonly monotonic?: () => number;
}

export interface GatewayServer {
  listen(target: ListenTarget): Promise<ListenResult>;
  close(): Promise<void>;
  /** Where it listens, once it does. */
  readonly target: ListenTarget | undefined;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const SOCKET_DIRECTORY_MODE = 0o700;
const SOCKET_MODE = 0o600;

/** Whether something answers on the socket. A stale file does not. */
function somethingListens(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

async function prepareSocketPath(
  path: string,
): Promise<"free" | "already-running"> {
  await mkdir(dirname(path), { recursive: true, mode: SOCKET_DIRECTORY_MODE });
  await chmod(dirname(path), SOCKET_DIRECTORY_MODE);
  try {
    await stat(path);
  } catch {
    return "free";
  }
  if (await somethingListens(path)) {
    return "already-running";
  }
  // Left behind by a daemon that did not exit cleanly. RFX-138 owns the
  // fuller story (PID files, versions); here a socket nobody answers on is
  // in the way and is removed.
  await unlink(path).catch(() => undefined);
  return "free";
}

export function createGatewayServer(
  options: GatewayServerOptions,
): GatewayServer {
  const limits: GatewayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const clock = options.clock ?? (() => new Date());
  const monotonic = options.monotonic ?? (() => performance.now());
  const startedAt = monotonic();
  let target: ListenTarget | undefined;

  const handler = createGatewayHandler({
    engine: options.engine,
    ...(options.telemetry === undefined
      ? {}
      : { telemetry: options.telemetry }),
    rateLimiter: new RateLimiter(limits.rate),
    idempotency: new IdempotencyStore(
      options.idempotency ?? DEFAULT_IDEMPOTENCY,
    ),
    maxBodyBytes: limits.maxBodyBytes,
    // Every peer of a Unix socket is the same user: one caller. On TCP each
    // address is one, until API keys (G14) name callers.
    callerOf: (request) =>
      target?.kind === "tcp"
        ? (request.socket.remoteAddress ?? "unknown")
        : "local",
    health: () => ({
      uptimeMs: Math.round(monotonic() - startedAt),
      ...(options.health?.() ?? {}),
    }),
    clock,
    monotonic,
  });

  const server: Server = createServer(handler);
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = limits.headersTimeoutMs;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  const bind = (
    listenTo: string | { host: string; port: number },
  ): Promise<boolean> =>
    new Promise((resolve) => {
      const onError = (): void => {
        resolve(false);
      };
      server.once("error", onError);
      const done = (): void => {
        server.off("error", onError);
        resolve(true);
      };
      if (typeof listenTo === "string") {
        server.listen(listenTo, done);
      } else {
        server.listen(listenTo.port, listenTo.host, done);
      }
    });

  return {
    get target() {
      return target;
    },

    async listen(wanted) {
      switch (wanted.kind) {
        case "socket": {
          if ((await prepareSocketPath(wanted.path)) === "already-running") {
            return { ok: false, reason: "already-running" };
          }
          if (!(await bind(wanted.path))) {
            return { ok: false, reason: "cannot-bind" };
          }
          await chmod(wanted.path, SOCKET_MODE);
          target = wanted;
          return { ok: true, target };
        }
        case "tcp": {
          if (!LOOPBACK.has(wanted.host)) {
            return { ok: false, reason: "needs-authentication" };
          }
          if (!(await bind({ host: wanted.host, port: wanted.port }))) {
            return { ok: false, reason: "cannot-bind" };
          }
          const address = server.address();
          target =
            typeof address === "object" && address !== null
              ? { kind: "tcp", host: wanted.host, port: address.port }
              : wanted;
          return { ok: true, target };
        }
      }
    },

    async close() {
      const listening = target;
      target = undefined;
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
      if (listening?.kind === "socket") {
        await unlink(listening.path).catch(() => undefined);
      }
    },
  };
}
