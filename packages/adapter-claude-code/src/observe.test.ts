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
      projectRoot: "/Users/dev/code/webapp",
      argumentShape: {
        type: "object",
        otherKeys: 0,
        keys: {
          command: { type: "string", length: 10 },
          description: { type: "string", length: 24 },
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

  it("a reported failure leaves execution unknown", () => {
    expect(
      outcomeOf("pre-tool-use.bash", "post-tool-use-failure.bash"),
    ).toMatchObject({ executed: "unknown" });
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

  // Adversarial: a signal that cannot be tied to an action is dropped. Tying
  // it to a guessed action would give one action another's outcome.
  it("drops a signal the host did not identify", () => {
    const anonymous = readHookInput(
      tampered("post-tool-use.bash", { tool_use_id: undefined }),
    );
    expect(
      anonymous.ok && toObservationRecord(anonymous.event, context),
    ).toBeUndefined();
  });

  it("never records the tool output that arrives with PostToolUse", () => {
    const serialized = JSON.stringify(records("post-tool-use.bash"));
    expect(serialized).not.toContain("nothing to commit");
    expect(serialized).not.toContain("stdout");
  });
});
