import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  parseSemanticAssessment,
  type SemanticDecisionRequest,
} from "@reflex-control/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLocalProvider } from "./client.js";

/**
 * RFX-144 — the wire, with a fake inference server on the loopback: what a
 * server for RDM or Laya has to speak, and nothing more.
 */
const MODEL = "laya-1.0.0";
const signal = (value: number) => ({ value, confidence: 0.6 });

let server: Server;
let endpoint: string;
const seen: {
  path: string;
  body: unknown;
  headers: Record<string, unknown>;
}[] = [];
let connections = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.push({ path: request.url ?? "", body, headers: request.headers });
      const sideEffectClass = (body as SemanticDecisionRequest).action
        .sideEffectClass;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          objectiveAlignment: signal(67),
          destructiveRisk: signal(sideEffectClass === "destructive" ? 100 : 0),
          reversibility: signal(100),
          externalSideEffect: { value: false, confidence: 0.6 },
          privilegeEscalation: signal(0),
          secretAccess: signal(0),
          sensitiveDataExposure: signal(0),
          financialConsequence: signal(0),
          productionMutation: signal(0),
          unusualScope: signal(0),
          untrustedInput: signal(0),
          provider: "fake-inference-server",
          model: MODEL,
          latencyMs: 3,
        }),
      );
    });
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  endpoint = `http://127.0.0.1:${String(port)}/v1/assess`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

const request = (
  command: string,
  sideEffectClass: "local-read" | "destructive",
): SemanticDecisionRequest => ({
  action: { tool: { name: "Bash" }, arguments: { command }, sideEffectClass },
  maxInputTokens: 600,
  deadlineMs: 1_000,
});

describe("RFX-144 against a fake inference server on the loopback", () => {
  it("speaks the canonical contract and keeps its connection across assessments", async () => {
    const provider = createLocalProvider({ model: MODEL, endpoint });
    const first = await provider.evaluate(
      request("cat README.md", "local-read"),
    );
    const second = await provider.evaluate(request("rm -rf ~", "destructive"));
    expect(first.ok && first.assessment.destructiveRisk.value).toBe(0);
    expect(second.ok && second.assessment.destructiveRisk.value).toBe(100);
    expect(second.ok && second.assessment.model).toBe(MODEL);
    expect(second.ok && second.assessment.provider).toBe("local");
    expect(seen.map((entry) => entry.path)).toEqual([
      "/v1/assess",
      "/v1/assess",
    ]);
    expect(seen[1]?.body).toEqual(request("rm -rf ~", "destructive"));
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
    expect(seen[0]?.headers.connection).not.toBe("close");
    expect(
      parseSemanticAssessment(first.ok ? first.assessment : undefined).ok,
    ).toBe(true);
    // Kept open: six assessments on at most two sockets. (A request that
    // starts before the previous socket is back in the pool may open a
    // second one; a third never happens.)
    for (let index = 0; index < 4; index += 1) {
      const result = await provider.evaluate(request("ls", "local-read"));
      expect(result.ok).toBe(true);
    }
    expect(seen).toHaveLength(6);
    expect(connections).toBeLessThanOrEqual(2);
  });
});
