import type {
  SemanticAssessment,
  SemanticDecisionRequest,
} from "@reflex/contracts";
import { describe, expect, it } from "vitest";

import {
  LOCAL_DEFAULT_ENDPOINT,
  createLocalProvider,
  isLoopbackEndpoint,
} from "./client.js";

/**
 * RFX-144 — the client against a fake `fetch`: one request as the contract
 * says, the answer read strictly, the model held to what was asked for,
 * every failure a typed result, never a retry, never a default.
 */
const MODEL = "rdm-0.1.0";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(
  respond: (call: FetchCall) => Response | Promise<Response>,
): { readonly fetch: typeof fetch; readonly calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const call = {
      url:
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      init: init ?? {},
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const signal = (value: number) => ({ value, confidence: 0.8 });
const answer = (overrides: Partial<SemanticAssessment> = {}) =>
  ({
    objectiveAlignment: signal(67),
    destructiveRisk: signal(0),
    reversibility: signal(100),
    externalSideEffect: { value: false, confidence: 0.8 },
    privilegeEscalation: signal(0),
    secretAccess: signal(0),
    sensitiveDataExposure: signal(0),
    financialConsequence: signal(0),
    productionMutation: signal(0),
    unusualScope: signal(0),
    untrustedInput: signal(0),
    provider: "rdm-server",
    model: MODEL,
    latencyMs: 7,
    ...overrides,
  }) satisfies SemanticAssessment;

const request = (deadlineMs = 500): SemanticDecisionRequest => ({
  action: {
    tool: { name: "Bash" },
    arguments: { command: "cat README.md" },
    sideEffectClass: "local-read",
  },
  maxInputTokens: 600,
  deadlineMs,
});

describe("RFX-144 the local provider client", () => {
  it("posts the canonical request to the loopback endpoint and reads the assessment strictly", async () => {
    const usage: unknown[] = [];
    const fake = fakeFetch(() => json(answer()));
    const provider = createLocalProvider({
      model: MODEL,
      fetch: fake.fetch,
      onUsage: (event) => usage.push(event),
    });
    expect(provider.providerName).toBe("local");
    expect(provider.model).toBe(MODEL);
    expect(provider.onMachine).toBe(true);
    const result = await provider.evaluate(request());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assessment.provider).toBe("local");
      expect(result.assessment.model).toBe(MODEL);
      expect(result.assessment.destructiveRisk).toEqual(signal(0));
      expect(Number.isInteger(result.assessment.latencyMs)).toBe(true);
    }
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call?.url).toBe(LOCAL_DEFAULT_ENDPOINT);
    expect(call?.init.method).toBe("POST");
    expect(JSON.parse(call?.init.body as string)).toEqual(request());
    expect(usage).toEqual([
      { status: 200, latencyMs: expect.any(Number) as number },
    ]);
  });

  it("refuses an answer in another checkpoint's name, or in no name", async () => {
    for (const model of ["rdm-0.2.0", "laya-1.0.0", undefined]) {
      const body: Record<string, unknown> = { ...answer() };
      if (model === undefined) {
        delete body.model;
      } else {
        body.model = model;
      }
      const fake = fakeFetch(() => json(body));
      const provider = createLocalProvider({ model: MODEL, fetch: fake.fetch });
      const result = await provider.evaluate(request());
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "invalid-response", providerName: "local" },
      });
    }
  });

  it("is a failure, never a default, when the answer is partial, malformed, or not JSON", async () => {
    const partial: Record<string, unknown> = { ...answer() };
    delete partial.secretAccess;
    const cases: (() => Response)[] = [
      () => json(partial),
      () =>
        json({ ...answer(), destructiveRisk: { value: 101, confidence: 1 } }),
      () => json({ ...answer(), verdict: "allow" }),
      () => json("allow"),
      () => new Response("not json", { status: 200 }),
      () => new Response("", { status: 200 }),
    ];
    for (const respond of cases) {
      const provider = createLocalProvider({
        model: MODEL,
        fetch: fakeFetch(respond).fetch,
      });
      const result = await provider.evaluate(request());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("invalid-response");
      }
    }
  });

  it.each([
    [429, "rate-limited"],
    [400, "rejected-request"],
    [401, "rejected-request"],
    [403, "rejected-request"],
    [422, "rejected-request"],
    [500, "unavailable"],
    [503, "unavailable"],
  ] as const)("reads status %s as %s", async (status, kind) => {
    const provider = createLocalProvider({
      model: MODEL,
      fetch: fakeFetch(() => json({ error: "x" }, status)).fetch,
    });
    const result = await provider.evaluate(request());
    expect(result).toMatchObject({ ok: false, error: { kind } });
  });

  it("reports a server that is not there as unavailable, and never retries", async () => {
    const fake = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const provider = createLocalProvider({ model: MODEL, fetch: fake.fetch });
    const result = await provider.evaluate(request());
    expect(result).toMatchObject({ ok: false, error: { kind: "unavailable" } });
    expect(fake.calls).toHaveLength(1);
  });

  it("times out on the request's deadline and tells a caller's abort apart", async () => {
    const hanging = fakeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const provider = createLocalProvider({
      model: MODEL,
      fetch: hanging.fetch,
    });
    const timedOut = await provider.evaluate(request(20));
    expect(timedOut).toMatchObject({ ok: false, error: { kind: "timeout" } });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 5);
    const aborted = await provider.evaluate(request(5_000), controller.signal);
    expect(aborted).toMatchObject({ ok: false, error: { kind: "aborted" } });
  });

  it("talks to this machine only: any other endpoint is refused at construction", () => {
    for (const endpoint of [
      "http://10.0.0.5:8765/v1/assess",
      "http://api.example.test/v1/assess",
      "http://127.0.0.1.example.test/v1/assess",
      "ftp://127.0.0.1/x",
      "not a url",
      "",
    ]) {
      expect(isLoopbackEndpoint(endpoint), endpoint).toBe(false);
      expect(() =>
        createLocalProvider({
          model: MODEL,
          endpoint,
          fetch: fakeFetch(() => json(answer())).fetch,
        }),
      ).toThrow(/this machine only/);
    }
    for (const endpoint of [
      "http://127.0.0.1:8765/v1/assess",
      "http://localhost:9000/v1/assess",
      "http://[::1]:8765/v1/assess",
      "https://127.0.0.1/v1/assess",
    ]) {
      expect(isLoopbackEndpoint(endpoint), endpoint).toBe(true);
    }
  });

  it("refuses a checkpoint that is not pinned", () => {
    for (const model of ["", "rdm-latest", "laya-preview"]) {
      expect(() => createLocalProvider({ model })).toThrow(/never an alias/);
    }
  });
});
