import type { ReflexDecision } from "@reflex-control/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  decisionRequest,
  harness,
  shell,
  type Harness,
} from "./gateway.test-support.js";
import { IdempotencyStore } from "./http/idempotency.js";

let running: Harness | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

const ACT = "act_00000000000000000000000000000001";

describe("RFX-120 idempotent decisions keyed by action.id", () => {
  it("returns the same decision, byte for byte, for the same request again", async () => {
    running = await harness();
    const request = decisionRequest(shell("git status"));
    const first = await running.client.decide(request);
    const again = await running.client.decide(request);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.text).toBe(first.text);
    expect(again.headers["x-reflex-replayed"]).toBe("true");
    expect(first.headers["x-reflex-replayed"]).toBeUndefined();
    expect((again.json as ReflexDecision).id).toBe(
      (first.json as ReflexDecision).id,
    );
  });

  it("counts a replayed decision once", async () => {
    running = await harness();
    const request = decisionRequest(shell("git status"));
    await running.client.decide(request);
    await running.client.decide(request);
    await running.client.decide(request);
    const events = await running.sink.settled();
    expect(events.filter((event) => event.kind === "decision")).toHaveLength(1);
  });

  it("replays whatever the deadline of the retry is", async () => {
    running = await harness();
    const first = await running.client.decide(
      decisionRequest(shell("git status"), { deadlineMs: 900 }),
    );
    const retry = await running.client.decide(
      decisionRequest(shell("git status"), { deadlineMs: 300 }),
    );
    expect(retry.text).toBe(first.text);
  });

  // Adversarial: the same id with other content must not get the first
  // decision, and must not be decided either.
  it("rejects the same id with different content, and does not decide it", async () => {
    running = await harness();
    const allowed = await running.client.decide(
      decisionRequest(shell("git status")),
    );
    expect((allowed.json as ReflexDecision).effect).toBe("allow");

    const spoofed = await running.client.decide(
      decisionRequest(shell("git push --force", ACT)),
    );
    expect(spoofed.status).toBe(409);
    expect(spoofed.json).toMatchObject({
      error: { code: "idempotency-conflict" },
    });

    const otherMode = await running.client.decide(
      decisionRequest(shell("git status"), { mode: "observe" }),
    );
    expect(otherMode.status).toBe(409);

    const otherFailureMode = await running.client.decide(
      decisionRequest(shell("git status"), { failureMode: "fail-open" }),
    );
    expect(otherFailureMode.status).toBe(409);

    const events = await running.sink.settled();
    expect(events.filter((event) => event.kind === "decision")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "rejected")).toHaveLength(3);
  });

  it("treats adapter metadata as no difference", async () => {
    running = await harness();
    const first = await running.client.decide(
      decisionRequest(shell("git status")),
    );
    const retry = await running.client.decide(
      decisionRequest({
        ...shell("git status"),
        adapterMetadata: { attempt: 2 },
      }),
    );
    expect(retry.status).toBe(200);
    expect(retry.text).toBe(first.text);
  });

  it("is a different decision for a different id", async () => {
    running = await harness();
    const first = await running.client.decide(
      decisionRequest(shell("git status")),
    );
    const second = await running.client.decide(
      decisionRequest(
        shell("git status", "act_00000000000000000000000000000002"),
      ),
    );
    expect(second.status).toBe(200);
    expect((second.json as ReflexDecision).id).not.toBe(
      (first.json as ReflexDecision).id,
    );
    // The engine's cache served the second one; idempotency did not.
    expect((second.json as ReflexDecision).cached).toBe(true);
    expect(second.headers["x-reflex-replayed"]).toBeUndefined();
  });
});

describe("the idempotency store", () => {
  const decision = { id: "dec_x" } as unknown as ReflexDecision;

  it("forgets an entry after its TTL, and the oldest when full", () => {
    const store = new IdempotencyStore({ ttlMs: 100, maxEntries: 2 });
    store.remember(ACT, "h1", decision, 0);
    expect(store.lookup(ACT, "h1", 50)).toEqual({ kind: "replay", decision });
    expect(store.lookup(ACT, "h2", 50)).toEqual({ kind: "conflict" });
    expect(store.lookup(ACT, "h1", 100)).toEqual({ kind: "new" });

    store.remember("act_a", "h", decision, 0);
    store.remember("act_b", "h", decision, 0);
    store.remember("act_c", "h", decision, 0);
    expect(store.size).toBe(2);
    expect(store.lookup("act_a", "h", 1)).toEqual({ kind: "new" });
    expect(store.lookup("act_c", "h", 1).kind).toBe("replay");
  });

  it("refuses a TTL or a size that would keep nothing", () => {
    expect(() => new IdempotencyStore({ ttlMs: 0, maxEntries: 1 })).toThrow(
      RangeError,
    );
    expect(() => new IdempotencyStore({ ttlMs: 1, maxEntries: 0 })).toThrow(
      RangeError,
    );
  });
});
