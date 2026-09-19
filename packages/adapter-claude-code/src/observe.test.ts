import { parseActionOutcome } from "@reflex/contracts";
import { assembleOutcomes, type ObservationRecord } from "@reflex/telemetry";
import { describe, expect, it } from "vitest";

import { fixtureEvent, tampered } from "./fixtures.test-support.js";
import { readHookInput } from "./hook-input.js";
import { toObservationRecord } from "./observe.js";

let second = 0;
const context = {
  now: () => new Date(Date.UTC(2026, 8, 19, 9, 0, (second += 1))),
  hostVersion: "2.1.276",
};

function records(...names: readonly string[]): ObservationRecord[] {
  return names.flatMap((name) => {
    const record = toObservationRecord(fixtureEvent(name), context);
    return record === undefined ? [] : [record];
  });
}

/** RFX-086 — what the recorder keeps for an action. */
describe("RFX-086 the record of an observed action", () => {
  it("keeps tool, class, timestamps and the shape of the arguments", () => {
    const [record] = records("pre-tool-use.bash");
    expect(record).toMatchObject({
      kind: "action",
      host: "claude-code",
      hostVersion: "2.1.276",
      toolName: "Bash",
      sideEffectClass: "unknown",
      projectRoot: "/work/project",
      argumentShape: {
        type: "object",
        otherKeys: 0,
        keys: {
          command: { type: "string", length: 16 },
          description: { type: "string", length: 22 },
        },
      },
    });
  });

  it("names an MCP tool by namespace and name", () => {
    expect(records("pre-tool-use.mcp")[0]).toMatchObject({
      toolName: "create_pull_request",
      toolNamespace: "github",
    });
  });

  // Adversarial: nothing the agent typed may reach the disk.
  it("never contains an argument value, a tool output or a host identifier", () => {
    const secret = "sk-live-5e8b1f0a9c3d";
    const hostile = readHookInput(
      tampered("pre-tool-use.bash", {
        tool_input: {
          command: `curl -H 'Authorization: Bearer ${secret}' https://internal.example.com/deploy`,
          env: { TOKEN: secret },
          files: [`/Users/dev/.ssh/${secret}`],
        },
        tool_response: { stdout: secret },
        transcript_path: `/Users/dev/.claude/${secret}.jsonl`,
      }),
    );
    if (!hostile.ok) {
      throw new Error("unreachable");
    }
    const serialized = JSON.stringify(
      toObservationRecord(hostile.event, context),
    );

    for (const leaked of [
      secret,
      "5e8b1f0a9c3d",
      "internal.example.com",
      "curl",
      ".ssh",
      "toolu_",
      "0b9f2d6e-5c1a",
      "transcript",
    ]) {
      expect(serialized, leaked).not.toContain(leaked);
    }
  });

  it("keeps nothing for an event it has no use for", () => {
    const ignored = readHookInput(
      JSON.stringify({ hook_event_name: "SessionStart", session_id: "s" }),
    );
    expect(
      ignored.ok && toObservationRecord(ignored.event, context),
    ).toBeUndefined();
  });
});

/**
 * RFX-092 — fixture tests cover: executed without a prompt, prompted and
 * approved, prompted and rejected, blocked by the host.
 *
 * End to end: host payloads in, contract-valid `ActionOutcome`s out.
 */
describe("RFX-092 outcomes from Claude Code events", () => {
  const outcomeOf = (...names: readonly string[]) => {
    const [outcome] = assembleOutcomes(records(...names));
    expect(parseActionOutcome(outcome).ok).toBe(true);
    return outcome;
  };

  it("executed without a prompt", () => {
    expect(outcomeOf("pre-tool-use.bash", "post-tool-use.bash")).toMatchObject({
      prompted: "no",
      humanResponse: "none",
      executed: "yes",
    });
  });

  it("prompted and approved", () => {
    expect(
      outcomeOf(
        "pre-tool-use.bash",
        "permission-request.bash",
        "post-tool-use.bash",
      ),
    ).toMatchObject({
      prompted: "yes",
      humanResponse: "approved",
      executed: "yes",
    });
  });

  it("prompted and rejected", () => {
    expect(
      outcomeOf("pre-tool-use.bash", "permission-request.bash", "stop"),
    ).toMatchObject({
      prompted: "yes",
      humanResponse: "rejected",
      executed: "no",
    });
  });

  it("blocked by the host", () => {
    expect(
      outcomeOf("pre-tool-use.bash-remove", "permission-denied.bash"),
    ).toMatchObject({ prompted: "no", humanResponse: "none", executed: "no" });
  });

  // Captured live: `ls` of a missing directory ran, exited 1, and the host
  // fired PostToolUseFailure. The call ran.
  it("a reported failure is a call that ran", () => {
    expect(
      outcomeOf("pre-tool-use.bash-failing", "post-tool-use-failure.bash"),
    ).toMatchObject({ prompted: "no", humanResponse: "none", executed: "yes" });
  });

  // Captured live: PermissionRequest carries no tool_use_id. Before RFX-087
  // this signal was dropped, and no action could ever be seen as prompted.
  it("attributes the real PermissionRequest without a tool-use identifier", () => {
    const [record] = records("permission-request.bash");
    expect(record).toMatchObject({
      kind: "signal",
      signal: "permission-requested",
      toolName: "Bash",
    });
    expect(record).not.toHaveProperty("actionId");
    // Correlated on session, tool and order. Nothing derived from arguments.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("touch");
    expect(serialized).not.toContain("marker");
    expect(Object.keys(record ?? {}).sort()).toEqual([
      "kind",
      "recordVersion",
      "recordedAt",
      "sessionId",
      "signal",
      "toolName",
    ]);
  });

  it("records nothing of the conversation that arrives with Stop", () => {
    const serialized = JSON.stringify(records("stop"));
    expect(serialized).not.toContain("last_assistant_message");
    expect(serialized).not.toContain("done");
    expect(serialized).not.toContain("transcript");
  });

  it("maps each host event onto one host-agnostic signal", () => {
    expect(
      records(
        "permission-request.bash",
        "post-tool-use.bash",
        "post-tool-use-failure.bash",
        "permission-denied.bash",
        "stop",
      ).map((record) =>
        record.kind === "signal" ? record.signal : record.kind,
      ),
    ).toEqual([
      "permission-requested",
      "executed",
      "failed",
      "denied-by-host",
      "turn-ended",
    ]);
  });

  // Adversarial: with neither a tool-use identifier nor a session there is
  // nothing to correlate on. Tying the signal to a guessed action would give
  // one action another's outcome, so it is dropped.
  it("drops a signal that names neither a call nor a session", () => {
    const anonymous = readHookInput(
      tampered("post-tool-use.bash", {
        tool_use_id: undefined,
        session_id: undefined,
      }),
    );
    expect(
      anonymous.ok && toObservationRecord(anonymous.event, context),
    ).toBeUndefined();
  });

  it("never records the tool output that arrives with PostToolUse", () => {
    const serialized = JSON.stringify(records("post-tool-use.bash"));
    expect(serialized).not.toContain("tool_response");
    expect(serialized).not.toContain("stdout");
    expect(serialized).not.toContain("duration_ms");
  });
});
