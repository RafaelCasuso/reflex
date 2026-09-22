import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ActionId,
  CanonicalAction,
  DecisionRequest,
} from "@reflex/contracts";
import {
  createDecisionEngine,
  DecisionCache,
  type DecisionEngineOptions,
} from "@reflex/core";
import { compilePolicySet, parsePolicy } from "@reflex/policy-engine";
import type { TelemetryEvent, TelemetrySink } from "@reflex/telemetry";

import {
  createGatewayServer,
  type GatewayServerOptions,
  type ListenTarget,
} from "./server.js";

export const PROJECT = "/work/project";

const base = {
  id: "act_00000000000000000000000000000001",
  agent: { host: "claude-code", hostVersion: "2.1.276" },
  sideEffectClass: "unknown",
  cwd: PROJECT,
  repository: { root: PROJECT },
  createdAt: "2026-09-22T10:00:00.000Z",
} as const;

export function shell(
  command: string,
  id: ActionId = base.id,
): CanonicalAction {
  return {
    ...base,
    id,
    tool: { name: "Bash" },
    arguments: { command },
    operands: { command: { raw: command } },
  };
}

export function decisionRequest(
  action: CanonicalAction,
  overrides: Partial<Omit<DecisionRequest, "action">> = {},
): DecisionRequest {
  return { action, mode: "autopilot", failureMode: "fail-ask", ...overrides };
}

export const ALLOW_GIT_STATUS = `
version: 1
defaults:
  unresolved: ask
rules:
  - id: allow-git-status
    name: Allow git status
    effect: allow
    conditions:
      - { field: command.name, operator: equals, value: git }
      - { field: command.args, operator: equals, value: status }
`;

export function compiledPolicy(yaml: string) {
  const parsed = parsePolicy(yaml);
  if (!parsed.ok) {
    throw new Error(parsed.issues.map((issue) => issue.message).join("\n"));
  }
  const result = compilePolicySet([
    { source: "local", trusted: true, document: parsed.document },
  ]);
  if (!result.ok) {
    throw new Error(result.problems.join("\n"));
  }
  return result.set;
}

export class RecordingSink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];
  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }
  /** Telemetry is emitted after the answer, on the next turn of the loop. */
  async settled(): Promise<TelemetryEvent[]> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return this.events;
  }
}

export interface Response {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
  readonly json: unknown;
}

export interface Client {
  readonly post: (
    path: string,
    body: string | Buffer,
    headers?: Readonly<Record<string, string>>,
  ) => Promise<Response>;
  readonly get: (path: string) => Promise<Response>;
  readonly decide: (
    request: DecisionRequest,
    headers?: Readonly<Record<string, string>>,
  ) => Promise<Response>;
}

function clientFor(target: ListenTarget): Client {
  const send = (
    method: "GET" | "POST",
    path: string,
    body: string | Buffer | undefined,
    headers: Readonly<Record<string, string>>,
  ): Promise<Response> =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          ...(target.kind === "socket"
            ? { socketPath: target.path }
            : { host: target.host, port: target.port }),
          method,
          path,
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: unknown;
            try {
              json = JSON.parse(text);
            } catch {
              json = undefined;
            }
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              text,
              json,
            });
          });
        },
      );
      request.on("error", reject);
      if (body !== undefined) {
        request.end(body);
      } else {
        request.end();
      }
    });

  return {
    post: (path, body, headers = {}) =>
      send("POST", path, body, {
        "content-type": "application/json",
        ...headers,
      }),
    get: (path) => send("GET", path, undefined, {}),
    decide: (request, headers = {}) =>
      send("POST", "/v1/decisions", JSON.stringify(request), {
        "content-type": "application/json",
        ...headers,
      }),
  };
}

export interface Harness {
  readonly client: Client;
  readonly sink: RecordingSink;
  readonly target: ListenTarget;
  readonly close: () => Promise<void>;
}

export interface HarnessOptions {
  readonly policy?: string;
  readonly engine?: Partial<DecisionEngineOptions>;
  readonly server?: Partial<Omit<GatewayServerOptions, "engine" | "telemetry">>;
  readonly listen?: ListenTarget;
  readonly cache?: boolean;
}

/** A real server on a real socket in a fresh temporary directory. */
export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "reflex-gw-"));
  const set = compiledPolicy(options.policy ?? ALLOW_GIT_STATUS);
  const engine = createDecisionEngine({
    policy: () => set,
    failureMode: "fail-ask",
    deadline: { defaultMs: 1_000, maxMs: 5_000 },
    ...(options.cache === false ? {} : { cache: new DecisionCache() }),
    ...options.engine,
  });
  const sink = new RecordingSink();
  const server = createGatewayServer({
    engine,
    telemetry: sink,
    ...options.server,
  });
  const listening = await server.listen(
    options.listen ?? { kind: "socket", path: join(directory, "reflex.sock") },
  );
  if (!listening.ok) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`cannot listen: ${listening.reason}`);
  }
  return {
    client: clientFor(listening.target),
    sink,
    target: listening.target,
    close: async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
