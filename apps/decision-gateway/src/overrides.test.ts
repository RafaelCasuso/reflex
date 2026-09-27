import { parseReflexDecision, type ReflexDecision } from "@reflex/contracts";
import { OverrideStore } from "@reflex/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  decisionRequest,
  harness,
  shell,
  type Harness,
} from "./gateway.test-support.js";

/**
 * RFX-125 — `POST /v1/overrides` through a real server: a human's yes to one
 * denied decision lets that action through once, is recorded, and never
 * touches a mandatory deny.
 */
const POLICY = `
version: 1
defaults:
  unresolved: ask
rules:
  - id: deny-rm
    name: Deny rm
    effect: deny
    conditions:
      - { field: command.name, operator: equals, value: rm }
  - id: deny-force-push
    name: Deny a force push
    effect: deny
    mandatory: true
    conditions:
      - { field: command.name, operator: equals, value: git }
      - { field: command.args, operator: equals, value: --force }
`;

let running: Harness | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(): Promise<Harness> {
  const overrides = new OverrideStore();
  running = await harness({
    policy: POLICY,
    engine: { overrides },
    server: { overrides },
  });
  return running;
}

function decisionOf(json: unknown): ReflexDecision {
  const parsed = parseReflexDecision(json);
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.issues));
  }
  return parsed.value;
}

const ACT_2 = "act_00000000000000000000000000000002";
const ACT_3 = "act_00000000000000000000000000000003";

describe("RFX-125 POST /v1/overrides", () => {
  it("turns a denied decision into one allow for the same action, recorded as the human's", async () => {
    const { client, sink } = await start();
    const denied = decisionOf(
      (await client.decide(decisionRequest(shell("rm -rf build")))).json,
    );
    expect(denied.effectiveEffect).toBe("deny");

    const granted = await client.post(
      "/v1/overrides",
      JSON.stringify({ decisionId: denied.id }),
      { "x-request-id": "human-0001" },
    );
    expect(granted.status).toBe(200);
    expect(granted.json).toMatchObject({
      decisionId: denied.id,
      oneShot: true,
    });
    expect(granted.headers["x-request-id"]).toBe("human-0001");

    // The agent retries: a new action id, the same content.
    const allowed = decisionOf(
      (await client.decide(decisionRequest(shell("rm -rf build", ACT_2)))).json,
    );
    expect(allowed).toMatchObject({
      effect: "allow",
      effectiveEffect: "allow",
      reasonCodes: ["human_override", "destructive"],
      cached: false,
    });
    const again = decisionOf(
      (await client.decide(decisionRequest(shell("rm -rf build", ACT_3)))).json,
    );
    expect(again.effectiveEffect).toBe("deny");

    const events = await sink.settled();
    expect(events.filter((event) => event.kind === "override")).toEqual([
      expect.objectContaining({
        kind: "override",
        decisionId: denied.id,
        requestId: "human-0001",
      }),
    ]);
    const overrideDecision = events.find(
      (event) => event.kind === "decision" && event.decisionId === allowed.id,
    );
    expect(overrideDecision).toMatchObject({
      reasonCodes: ["human_override", "destructive"],
    });
    const health = await client.get("/v1/health");
    expect(health.json).toMatchObject({ status: "ok" });
  });

  it("refuses with a typed problem: unknown, not a deny, already granted, mandatory", async () => {
    const { client, sink } = await start();
    const unknown = await client.post(
      "/v1/overrides",
      JSON.stringify({ decisionId: "dec_00000000000000000000000000000099" }),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.json).toMatchObject({
      error: { code: "override-refused" },
    });

    const asked = decisionOf(
      (await client.decide(decisionRequest(shell("ls")))).json,
    );
    expect(asked.effectiveEffect).toBe("ask");
    const notDeny = await client.post(
      "/v1/overrides",
      JSON.stringify({ decisionId: asked.id }),
    );
    expect(notDeny.status).toBe(409);

    const denied = decisionOf(
      (await client.decide(decisionRequest(shell("rm -rf build", ACT_2)))).json,
    );
    expect(
      (
        await client.post(
          "/v1/overrides",
          JSON.stringify({ decisionId: denied.id }),
        )
      ).status,
    ).toBe(200);
    const twice = await client.post(
      "/v1/overrides",
      JSON.stringify({ decisionId: denied.id }),
    );
    expect(twice.status).toBe(409);

    // Adversarial: the mandatory deny. Refused, and the action stays denied.
    const mandatory = decisionOf(
      (await client.decide(decisionRequest(shell("git push --force", ACT_3))))
        .json,
    );
    expect(mandatory.effectiveEffect).toBe("deny");
    const refused = await client.post(
      "/v1/overrides",
      JSON.stringify({ decisionId: mandatory.id }),
    );
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({
      error: {
        code: "override-refused",
        message: "a mandatory deny cannot be overridden",
      },
    });
    const still = decisionOf(
      (
        await client.decide(
          decisionRequest(
            shell("git push --force", "act_00000000000000000000000000000004"),
          ),
        )
      ).json,
    );
    expect(still.effectiveEffect).toBe("deny");

    const events = await sink.settled();
    expect(
      events.filter(
        (event) =>
          event.kind === "rejected" && event.code === "override-refused",
      ),
    ).toHaveLength(4);
  });

  it("validates the body and the method, and never echoes a value", async () => {
    const { client } = await start();
    const secret = ["canary", "override", "7a8b9c"].join("-");
    for (const body of [
      "{}",
      JSON.stringify({ decisionId: secret }),
      "[]",
      "null",
      JSON.stringify({ decisionId: 7 }),
    ]) {
      const response = await client.post("/v1/overrides", body);
      expect(response.status).toBe(400);
      expect(response.text).not.toContain(secret);
      expect(response.json).toMatchObject({
        error: { code: "invalid-request" },
      });
    }
    const got = await client.get("/v1/overrides");
    expect(got.status).toBe(405);
  });

  it("does not exist on a server without a store", async () => {
    running = await harness({ policy: POLICY });
    const response = await running.client.post(
      "/v1/overrides",
      JSON.stringify({ decisionId: "dec_00000000000000000000000000000001" }),
    );
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ error: { code: "not-found" } });
  });
});
