import type { ActionId } from "@reflex-control/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  decisionRequest,
  harness,
  shell,
  type Harness,
} from "./gateway.test-support.js";
import { RateLimiter } from "./http/limits.js";

let running: Harness | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

const ids = (count: number): ActionId[] =>
  Array.from(
    { length: count },
    (_, index): ActionId => `act_${String(index + 1).padStart(32, "0")}`,
  );

describe("RFX-119 request size limit", () => {
  it("rejects a body that declares itself too large before reading it", async () => {
    running = await harness({ server: { limits: { maxBodyBytes: 1_024 } } });
    const response = await running.client.post(
      "/v1/decisions",
      JSON.stringify(decisionRequest(shell("x".repeat(2_000)))),
    );
    expect(response.status).toBe(413);
    expect(response.json).toMatchObject({
      error: { code: "payload-too-large" },
    });
    const events = await running.sink.settled();
    expect(events).toEqual([
      expect.objectContaining({ kind: "rejected", code: "payload-too-large" }),
    ]);
  });

  it("stops reading a body that lies about its length, at the limit", async () => {
    running = await harness({ server: { limits: { maxBodyBytes: 1_024 } } });
    // Chunked: no Content-Length to check ahead of time.
    const response = await running.client.post(
      "/v1/decisions",
      JSON.stringify(decisionRequest(shell("x".repeat(2_000)))),
      { "transfer-encoding": "chunked" },
    );
    expect(response.status).toBe(413);
  });

  it("accepts a body within the limit", async () => {
    running = await harness({ server: { limits: { maxBodyBytes: 4_096 } } });
    const response = await running.client.decide(
      decisionRequest(shell("git status")),
    );
    expect(response.status).toBe(200);
  });
});

describe("RFX-119 rate limit", () => {
  it("turns away the request past the burst before validating anything, and says when to retry", async () => {
    running = await harness({
      server: { limits: { rate: { burst: 3, perSecond: 1 } } },
    });
    const [a, b, c, d] = ids(4);
    for (const id of [a, b, c]) {
      expect(
        (await running.client.decide(decisionRequest(shell("git status", id))))
          .status,
      ).toBe(200);
    }
    // The fourth is turned away, and so would be an invalid one: no work is
    // done for a caller over the limit.
    const limited = await running.client.decide(
      decisionRequest(shell("git status", d)),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toMatch(/^\d+$/);
    expect(limited.json).toMatchObject({ error: { code: "rate-limited" } });
    const garbage = await running.client.post("/v1/decisions", "{not json");
    expect(garbage.status).toBe(429);
    const events = await running.sink.settled();
    expect(events.filter((event) => event.kind === "rejected")).toHaveLength(2);
  });

  it("refills with time", () => {
    const limiter = new RateLimiter({ burst: 2, perSecond: 10 });
    expect(limiter.take("k", 0)).toEqual({ allowed: true });
    expect(limiter.take("k", 0)).toEqual({ allowed: true });
    expect(limiter.take("k", 0)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    // 100 ms later one token is back.
    expect(limiter.take("k", 100)).toEqual({ allowed: true });
    expect(limiter.take("k", 100).allowed).toBe(false);
    // Never above the burst, however long the wait.
    expect(limiter.take("k", 100_000)).toEqual({ allowed: true });
    expect(limiter.take("k", 100_000)).toEqual({ allowed: true });
    expect(limiter.take("k", 100_000).allowed).toBe(false);
  });

  it("keeps callers apart", () => {
    const limiter = new RateLimiter({ burst: 1, perSecond: 1 });
    expect(limiter.take("a", 0).allowed).toBe(true);
    expect(limiter.take("a", 0).allowed).toBe(false);
    expect(limiter.take("b", 0).allowed).toBe(true);
  });

  // Losing state fails safe: a caller starts over with a burst, never with
  // no limit, and the limit itself is still there.
  it("keeps limiting after its state is lost", () => {
    const limiter = new RateLimiter({ burst: 2, perSecond: 1 });
    limiter.take("k", 0);
    limiter.take("k", 0);
    expect(limiter.take("k", 0).allowed).toBe(false);
    limiter.reset();
    expect(limiter.take("k", 0).allowed).toBe(true);
    expect(limiter.take("k", 0).allowed).toBe(true);
    expect(limiter.take("k", 0).allowed).toBe(false);
  });

  it("forgets the least recently seen caller when full, and that caller starts over bounded", () => {
    const limiter = new RateLimiter({ burst: 1, perSecond: 1, maxCallers: 2 });
    expect(limiter.take("a", 0).allowed).toBe(true);
    expect(limiter.take("b", 0).allowed).toBe(true);
    expect(limiter.take("c", 0).allowed).toBe(true); // a is forgotten
    expect(limiter.callers).toBe(2);
    expect(limiter.take("a", 0).allowed).toBe(true); // one burst, not unlimited
    expect(limiter.take("a", 0).allowed).toBe(false);
  });

  it("refuses a limit that would let everything or nothing through", () => {
    expect(() => new RateLimiter({ burst: 0, perSecond: 1 })).toThrow(
      RangeError,
    );
    expect(() => new RateLimiter({ burst: 1, perSecond: 0 })).toThrow(
      RangeError,
    );
    expect(
      () => new RateLimiter({ burst: 1, perSecond: 1, maxCallers: 0 }),
    ).toThrow(RangeError);
  });
});
