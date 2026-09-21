import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCanonicalAction } from "@reflex/contracts";
import { describe, expect, it } from "vitest";

import { readHookInput } from "./hook-input.js";
import { toObservationRecord } from "./observe.js";
import { classifyByName, toCanonicalAction } from "./translate.js";

/**
 * RFX-089 — the payloads a live host sent for file edits, a fetch and an MCP
 * call, held against the adapter and against the written review.
 *
 * `live/capture-tool-payloads.mjs` ran real headless sessions and recorded
 * what the host wrote to the hook's stdin. This suite runs offline on that
 * record, and on the one RFX-087 made for `Bash`.
 */
const PAYLOADS_DIR = fileURLToPath(
  new URL("../live/payloads/", import.meta.url),
);
const RESULTS_DIR = fileURLToPath(new URL("../live/results/", import.meta.url));
const REVIEW = readFileSync(
  fileURLToPath(
    new URL("../../../docs/canonical-action-review.md", import.meta.url),
  ),
  "utf8",
);

type Payload = Readonly<Record<string, unknown>>;

interface CapturedCase {
  readonly id: string;
  readonly happened: boolean | null;
  readonly events: Readonly<Record<string, number>>;
  readonly samples: Readonly<Record<string, Payload>>;
}

interface PayloadRecord {
  readonly ticket: string;
  readonly host: string;
  readonly results: readonly CapturedCase[];
}

const recordFiles = readdirSync(PAYLOADS_DIR).filter((file) =>
  file.endsWith(".json"),
);

const context = {
  now: () => new Date(Date.UTC(2026, 8, 21, 9, 0, 0)),
  hostVersion: "live",
};

function actionOf(payload: Payload) {
  const input = readHookInput(JSON.stringify(payload));
  if (!input.ok || input.event.kind !== "tool") {
    throw new Error("the live payload is not a readable tool event");
  }
  return toCanonicalAction(input.event, context);
}

it("has at least one recorded host version", () => {
  expect(recordFiles.length).toBeGreaterThan(0);
});

describe.each(recordFiles)("RFX-089 live payloads %s", (file) => {
  const raw = readFileSync(join(PAYLOADS_DIR, file), "utf8");
  const record = JSON.parse(raw) as PayloadRecord;
  const sample = (caseId: string, key: string): Payload => {
    const found = record.results.find((result) => result.id === caseId)
      ?.samples[key];
    if (found === undefined) {
      throw new Error(`the record has no ${key} in case ${caseId}`);
    }
    return found;
  };
  const everySample = record.results.flatMap((result) =>
    Object.entries(result.samples),
  );

  it("is the record of tools that really ran", () => {
    expect(record.ticket).toBe("RFX-089");
    expect(record.host).toMatch(/^\d+\.\d+\.\d+/);
    for (const result of record.results) {
      // Read from the disk, not from the model. A fetch leaves nothing there,
      // so its completion event is the evidence.
      expect(result.happened, result.id).not.toBe(false);
      const completed = Object.keys(result.events).some((key) =>
        key.startsWith("PostToolUse:"),
      );
      expect(completed, result.id).toBe(true);
    }
  });

  // ADR-011: the adapter copies operands from these arguments. If the host
  // renames one, the operand silently disappears, and with it every allow rule
  // about paths. This is where that would be noticed.
  it("finds the arguments the adapter copies operands from", () => {
    for (const key of [
      "PreToolUse:Write",
      "PreToolUse:Read",
      "PreToolUse:Edit",
    ]) {
      const caseId = key.endsWith("Write") ? "write" : "edit";
      expect(sample(caseId, key).tool_input, key).toHaveProperty("file_path");
    }
    expect(sample("webfetch", "PreToolUse:WebFetch").tool_input).toHaveProperty(
      "url",
    );

    const bash = readdirSync(RESULTS_DIR)
      .filter((name) => name.endsWith(".json"))
      .map(
        (name) =>
          JSON.parse(readFileSync(join(RESULTS_DIR, name), "utf8")) as {
            results: { samples: Record<string, Payload> }[];
          },
      )
      .flatMap((bashRecord) => bashRecord.results)
      .map((result) => result.samples.PreToolUse)
      .find((payload) => payload?.tool_name === "Bash");
    expect(bash?.tool_input).toHaveProperty("command");
  });

  it("translates every captured call into an action the contract accepts", () => {
    const calls = everySample.filter(([key]) => key.startsWith("PreToolUse:"));
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const [key, payload] of calls) {
      expect(parseCanonicalAction(actionOf(payload)).ok, key).toBe(true);
    }
  });

  it("fills the operands from what the host really sent", () => {
    expect(actionOf(sample("write", "PreToolUse:Write")).operands).toEqual({
      paths: ["/work/project/notes.txt"],
    });
    expect(actionOf(sample("edit", "PreToolUse:Edit")).operands).toEqual({
      paths: ["/work/project/greeting.txt"],
    });
    expect(actionOf(sample("edit", "PreToolUse:Read")).operands).toEqual({
      paths: ["/work/project/greeting.txt"],
    });
    expect(
      actionOf(sample("webfetch", "PreToolUse:WebFetch")).operands,
    ).toEqual({
      networkHosts: ["example.com"],
    });
  });

  describe("an MCP tool", () => {
    const payload = sample("mcp", "PreToolUse:mcp__notes__save_note");

    it("is named by the host, and the adapter believes the host", () => {
      // An object, which is what this suite found: the adapter first read it
      // as a string, saw nothing, and split the name instead.
      expect(payload.mcp_server).toEqual({ name: "notes", source: "dynamic" });
      expect(readHookInput(JSON.stringify(payload))).toMatchObject({
        ok: true,
        event: { mcpServer: "notes" },
      });
      expect(actionOf(payload).tool).toEqual({
        name: "save_note",
        namespace: "notes",
      });
    });

    it("gets no operand and no class, whatever its arguments are called", () => {
      const action = actionOf(payload);
      expect(action.operands).toBeUndefined();
      expect(action.sideEffectClass).toBe("unknown");
    });

    // Adversarial: the same payload with the host's statement changed. The
    // adapter must follow the statement, and must not trust the name to split.
    it("follows mcp_server even when the name reads like another server", () => {
      const spoofed = actionOf({
        ...payload,
        tool_name: "mcp__github__admin__save_note",
        mcp_server: { name: "github__admin", source: "dynamic" },
      });
      expect(spoofed.tool).toEqual({
        name: "save_note",
        namespace: "github__admin",
      });
    });

    it("says mcp_server only for MCP tools", () => {
      for (const [key, sent] of everySample) {
        expect("mcp_server" in sent, key).toBe(key.includes(":mcp__"));
      }
    });
  });

  it("classes ToolSearch as touching nothing, and nothing else by its name", () => {
    expect(
      actionOf(sample("mcp", "PreToolUse:ToolSearch")).sideEffectClass,
    ).toBe("none");
    expect(classifyByName({ name: "ToolSearch", namespace: "helper" })).toBe(
      "unknown",
    );
    for (const key of ["PreToolUse:Write", "PreToolUse:Edit"]) {
      const caseId = key.endsWith("Write") ? "write" : "edit";
      expect(actionOf(sample(caseId, key)).sideEffectClass, key).toBe(
        "unknown",
      );
    }
  });

  // ADR-006, ADR-008: a completion carries the tool's output. For an edit
  // that is the whole original file. None of it may reach a record.
  it("keeps the tool's output out of what is recorded", () => {
    const completion = sample("edit", "PostToolUse:Edit");
    expect(JSON.stringify(completion.tool_response)).toContain("hello world");

    for (const [key, payload] of everySample) {
      const input = readHookInput(JSON.stringify(payload));
      expect(input.ok, key).toBe(true);
      if (!input.ok) {
        continue;
      }
      const recorded = JSON.stringify(
        toObservationRecord(input.event, context) ?? {},
      );
      for (const content of [
        "hello world",
        "hello reflex",
        "hello from reflex",
        "remember the milk",
        "example.com",
        "greeting.txt",
        "notes.txt",
      ]) {
        expect(recorded, `${key}: ${content}`).not.toContain(content);
      }
    }
  });

  // The review says what the host sends. It must not drift from the record.
  it("the written review names every field the host sent", () => {
    const fields = new Set(
      everySample.flatMap(([, payload]) => Object.keys(payload)),
    );
    expect(fields.size).toBeGreaterThanOrEqual(10);
    for (const field of fields) {
      expect(REVIEW, field).toContain(`\`${field}\``);
    }
    for (const [key, payload] of everySample) {
      if (!key.startsWith("PreToolUse:") || key.includes(":mcp__")) {
        continue;
      }
      for (const argument of Object.keys(payload.tool_input as Payload)) {
        expect(REVIEW, `${key}: ${argument}`).toContain(`\`${argument}\``);
      }
    }
  });

  it("holds no path, account or credential of the recording machine", () => {
    for (const forbidden of [
      /\/Users\//,
      /\/var\/folders\//,
      /\/private\//,
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.(?!com\/)[a-z]{2,}/,
      /sk-ant-/,
      /apikey_/,
      /Bearer\s/i,
    ]) {
      expect(raw, String(forbidden)).not.toMatch(forbidden);
    }
  });
});
