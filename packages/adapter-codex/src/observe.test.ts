import { assembleOutcomes, type ObservationRecord } from "@reflex/telemetry";
import { describe, expect, it } from "vitest";

import { FIXED_NOW, fixture } from "./fixtures.test-support.js";
import { readHookInput } from "./hook-input.js";
import { toObservationRecord } from "./observe.js";

/** RFX-093 — outcomes from the signals Codex exposes; unknown where it exposes none. */
const context = { now: FIXED_NOW, hostVersion: "codex-cli 0.157.1" };

function record(name: string): ObservationRecord {
  const read = readHookInput(fixture(name));
  if (!read.ok) {
    throw new Error(read.reason);
  }
  const observed = toObservationRecord(read.event, context);
  if (observed === undefined) {
    throw new Error(`${name} records nothing`);
  }
  return observed;
}

describe("what each event records", () => {
  it("records the action from PreToolUse with the shape of its arguments, never a value", () => {
    const action = record("pre-tool-use.bash");
    expect(action).toMatchObject({
      kind: "action",
      host: "codex",
      hostVersion: "codex-cli 0.157.1",
      toolName: "Bash",
      sideEffectClass: "unknown",
      projectRoot: "/work/project",
    });
    expect(JSON.stringify(action)).not.toContain("marker.txt");
    expect(JSON.stringify(action)).not.toContain("touch");
  });

  it("records PermissionRequest by session and tool, since the host gives it no id", () => {
    expect(record("permission-request.bash")).toMatchObject({
      kind: "signal",
      signal: "permission-requested",
      toolName: "Bash",
    });
    expect(record("permission-request.bash")).not.toHaveProperty("actionId");
  });

  it("records PostToolUse as executed, by the action's id, and Stop as the turn's end", () => {
    const action = record("pre-tool-use.bash");
    const post = record("post-tool-use.bash");
    expect(post).toMatchObject({ kind: "signal", signal: "executed" });
    expect(post.kind === "signal" && post.actionId).toBe(
      action.kind === "action" && action.actionId,
    );
    expect(record("stop")).toMatchObject({ kind: "turn-ended" });
  });

  it("records nothing for events it has no use for", () => {
    for (const name of ["session-start", "user-prompt-submit"]) {
      const read = readHookInput(fixture(name));
      expect(
        read.ok && toObservationRecord(read.event, context),
      ).toBeUndefined();
    }
  });
});

describe("the four outcomes of RFX-092, from Codex's signals", () => {
  it("prompted and approved: PreToolUse, PermissionRequest, PostToolUse", () => {
    const [outcome] = assembleOutcomes([
      record("pre-tool-use.bash"),
      record("permission-request.bash"),
      record("post-tool-use.bash"),
    ]);
    expect(outcome).toMatchObject({
      prompted: "yes",
      executed: "yes",
      humanResponse: "approved",
    });
  });

  it("prompted and rejected: PreToolUse, PermissionRequest, then the turn ends", () => {
    const [outcome] = assembleOutcomes([
      record("pre-tool-use.bash"),
      record("permission-request.bash"),
      record("stop"),
    ]);
    expect(outcome).toMatchObject({
      prompted: "yes",
      executed: "no",
      humanResponse: "rejected",
    });
  });

  it("ran without a prompt: PreToolUse, PostToolUse", () => {
    const [outcome] = assembleOutcomes([
      record("pre-tool-use.bash"),
      record("post-tool-use.bash"),
    ]);
    expect(outcome).toMatchObject({
      prompted: "no",
      executed: "yes",
      humanResponse: "none",
    });
  });

  // Codex has no PermissionDenied or PostToolUseFailure: with no signal the
  // outcome says unknown, never "not prompted" or "did not run".
  it("no signal: unknown, and never folded into a certainty", () => {
    const [outcome] = assembleOutcomes([record("pre-tool-use.bash")]);
    expect(outcome).toMatchObject({
      prompted: "unknown",
      executed: "unknown",
      humanResponse: "unknown",
    });
  });
});
