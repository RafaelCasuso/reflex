import { parseCanonicalAction } from "@reflex/contracts";
import { describe, expect, it } from "vitest";

import { FIXED_NOW, fixture } from "./fixtures.test-support.js";
import { readHookInput, type CodexToolEvent } from "./hook-input.js";
import {
  classifyByName,
  operandsOf,
  parseToolName,
  readPatch,
  toCanonicalAction,
} from "./translate.js";

/** RFX-048 — Bash, apply_patch and MCP, from the documented payloads. */
const context = { now: FIXED_NOW, hostVersion: "codex-cli 0.157.1" };

function toolEvent(name: string): CodexToolEvent {
  const read = readHookInput(fixture(name));
  if (!read.ok || read.event.kind !== "tool") {
    throw new Error(`${name} is not a tool event`);
  }
  return read.event;
}

describe("Bash", () => {
  it("carries the command as an operand, uninterpreted, and is unknown by name", () => {
    const action = toCanonicalAction(toolEvent("pre-tool-use.bash"), context);
    expect(action).toMatchObject({
      agent: { host: "codex", hostVersion: "codex-cli 0.157.1" },
      tool: { name: "Bash" },
      operands: { command: { raw: "touch marker.txt" } },
      sideEffectClass: "unknown",
      cwd: "/work/project",
      adapterMetadata: {
        hookEventName: "PreToolUse",
        toolUseId: "call_0001",
        turnId: "turn_0001",
        permissionMode: "default",
      },
      createdAt: "2026-09-27T12:00:00.000Z",
    });
    expect(action.id).toMatch(/^act_[0-9a-f]{32}$/);
    expect(action.sessionId).toMatch(/^ses_[0-9a-f]{24}$/);
    expect(parseCanonicalAction(action).ok).toBe(true);
  });

  it("derives the same action id for every event about the same call, and a random one without an id", () => {
    const pre = toCanonicalAction(toolEvent("pre-tool-use.bash"), context);
    const post = toCanonicalAction(toolEvent("post-tool-use.bash"), context);
    expect(post.id).toBe(pre.id);
    const request = toCanonicalAction(
      toolEvent("permission-request.bash"),
      context,
    );
    expect(request.id).not.toBe(pre.id);
    expect(request.adapterMetadata).not.toHaveProperty("toolUseId");
  });
});

describe("apply_patch", () => {
  it("lists the files the patch touches and writes locally", () => {
    const action = toCanonicalAction(
      toolEvent("pre-tool-use.apply-patch"),
      context,
    );
    expect(action.operands).toEqual({ paths: ["src/app.ts", "src/new.ts"] });
    expect(action.sideEffectClass).toBe("local-write");
    expect(parseCanonicalAction(action).ok).toBe(true);
  });

  it("is destructive when the patch deletes a file, as rm is", () => {
    const action = toCanonicalAction(
      toolEvent("pre-tool-use.apply-patch-delete"),
      context,
    );
    expect(action.operands).toEqual({ paths: ["src/old.ts"] });
    expect(action.sideEffectClass).toBe("destructive");
  });

  it("reads the documented headers, moves included, once each", () => {
    expect(
      readPatch(
        "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n*** Update File: a.ts\n*** End Patch",
      ),
    ).toEqual({ paths: ["a.ts", "b.ts"], deletes: false });
    expect(readPatch("not a patch")).toBeUndefined();
    expect(readPatch("*** Begin Patch\n*** End Patch")).toBeUndefined();
  });

  // Adversarial: a tool named apply_patch whose input is not a patch in the
  // documented format is unknown, never safe, and yields no operand an
  // allow rule about paths could match.
  it("is unknown, with no operands, when the input is not a documented patch", () => {
    const tool = { name: "apply_patch" };
    for (const input of [
      {},
      { command: "" },
      { command: 42 },
      { command: "rm -rf /" },
      { patch: "*** Begin Patch\n*** Update File: a.ts\n*** End Patch" },
    ]) {
      expect(classifyByName(tool, input)).toBe("unknown");
      expect(operandsOf(tool, input)).toBeUndefined();
    }
  });

  // Adversarial: a Bash command that happens to contain patch headers is a
  // command, not a patch. Only its command operand is read.
  it("does not read a patch out of a Bash command", () => {
    const input = {
      command: "*** Begin Patch\n*** Delete File: /etc/passwd\n*** End Patch",
    };
    expect(operandsOf({ name: "Bash" }, input)).toEqual({
      command: { raw: input.command },
    });
    expect(classifyByName({ name: "Bash" }, input)).toBe("unknown");
  });
});

describe("MCP and other tools", () => {
  it("splits mcp__server__tool into namespace and name, and never classifies it", () => {
    const action = toCanonicalAction(toolEvent("pre-tool-use.mcp"), context);
    expect(action.tool).toEqual({ name: "read_file", namespace: "filesystem" });
    expect(action.sideEffectClass).toBe("unknown");
    expect(action).not.toHaveProperty("operands");
    expect(parseToolName("mcp__")).toEqual({ name: "mcp__", namespace: "mcp" });
    expect(parseToolName("mcp__server")).toEqual({
      name: "mcp__server",
      namespace: "server",
    });
    expect(parseToolName("mcp__server__")).toEqual({
      name: "mcp__server__",
      namespace: "server__",
    });
  });

  it("settles by name only what no argument could change", () => {
    const plan = toCanonicalAction(
      toolEvent("pre-tool-use.update-plan"),
      context,
    );
    expect(plan.sideEffectClass).toBe("none");
    for (const name of [
      "Bash",
      "Agent",
      "spawn_agent",
      "view_image",
      "SomethingNew",
      "constructor",
      "toString",
      "__proto__",
    ]) {
      expect(classifyByName({ name }, {})).toBe("unknown");
    }
    // A tool with a namespace is never settled by its bare name.
    expect(classifyByName({ name: "update_plan", namespace: "evil" }, {})).toBe(
      "unknown",
    );
  });
});
