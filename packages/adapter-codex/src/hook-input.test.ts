import { describe, expect, it } from "vitest";

import { fixture, fixtureNames } from "./fixtures.test-support.js";
import { readHookInput } from "./hook-input.js";

/** RFX-048 — the documented envelope, read strictly where it matters. */
describe("reading a Codex hook payload", () => {
  it("reads every documented fixture into a typed event", () => {
    for (const name of fixtureNames()) {
      expect(readHookInput(fixture(name)).ok, name).toBe(true);
    }
  });

  it("reads a PreToolUse with its ids, and a PermissionRequest without a tool_use_id", () => {
    expect(readHookInput(fixture("pre-tool-use.bash"))).toEqual({
      ok: true,
      event: {
        kind: "tool",
        event: "PreToolUse",
        sessionId: "0c4b8b9e-3d1a-4f6e-9a2b-7e5d1c3f8a10",
        turnId: "turn_0001",
        toolUseId: "call_0001",
        toolName: "Bash",
        toolInput: {
          command: "touch marker.txt",
          description: "Create a marker file",
        },
        cwd: "/work/project",
        permissionMode: "default",
      },
    });
    const request = readHookInput(fixture("permission-request.bash"));
    expect(
      request.ok && request.event.kind === "tool" && request.event.toolUseId,
    ).toBeUndefined();
  });

  it("reads Stop as the end of the turn, and other events as ignored", () => {
    expect(readHookInput(fixture("stop"))).toEqual({
      ok: true,
      event: {
        kind: "turn-ended",
        sessionId: "0c4b8b9e-3d1a-4f6e-9a2b-7e5d1c3f8a10",
      },
    });
    expect(readHookInput(fixture("session-start"))).toEqual({
      ok: true,
      event: { kind: "ignored", event: "SessionStart" },
    });
    expect(readHookInput(fixture("user-prompt-submit"))).toEqual({
      ok: true,
      event: { kind: "ignored", event: "UserPromptSubmit" },
    });
  });

  // RFX-124's rule for every host: a payload the adapter cannot use is a
  // typed failure, never a guess.
  it.each([
    ["nothing", "", "not-json"],
    ["truncated JSON", '{"hook_event_name": "PreToolU', "not-json"],
    ["an array", "[]", "not-an-object"],
    ["no event name", "{}", "missing-event-name"],
    ["a numeric event name", '{"hook_event_name": 7}', "missing-event-name"],
    [
      "a tool event without a tool name",
      '{"hook_event_name": "PreToolUse", "tool_input": {}}',
      "invalid-tool-event",
    ],
    [
      "a tool event whose input is a string",
      '{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": "rm -rf /"}',
      "invalid-tool-event",
    ],
    [
      "a tool event whose input is an array",
      '{"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": []}',
      "invalid-tool-event",
    ],
    [
      "a tool name that is too long",
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "x".repeat(600),
        tool_input: {},
      }),
      "invalid-tool-event",
    ],
  ])("fails on %s", (_label, stdin, reason) => {
    expect(readHookInput(stdin)).toEqual({ ok: false, reason });
  });

  it("tolerates fields it does not know, and empty strings as absent", () => {
    const read = readHookInput(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        session_id: "",
        cwd: "",
        something_new: { deep: true },
      }),
    );
    expect(read.ok && read.event.kind === "tool" && read.event).toMatchObject({
      sessionId: undefined,
      cwd: undefined,
      toolUseId: undefined,
    });
  });
});
