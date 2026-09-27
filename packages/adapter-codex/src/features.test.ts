import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

import {
  inspectConfig,
  planDisableHooks,
  planEnableHooks,
} from "./features.js";

/** RFX-047 / RFX-050 — config.toml: read for trust, written for one flag. */
const USER_CONFIG = `model = "gpt-5.3-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[projects."/work/project"]
trust_level = "trusted"

[features]
web_search = true   # the user's own
`;

const flag = (text: string): unknown =>
  (parse(text) as { features?: { hooks?: unknown } }).features?.hooks;

describe("inspecting config.toml", () => {
  it("reports the flag, the policy, the sandbox and the project's trust", () => {
    expect(inspectConfig(USER_CONFIG, "/work/project")).toEqual({
      state: "valid",
      hooksEnabled: undefined,
      inlineHookEvents: [],
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      trustLevel: "trusted",
    });
    expect(inspectConfig(USER_CONFIG, "/elsewhere").trustLevel).toBeUndefined();
    expect(inspectConfig(undefined).state).toBe("absent");
    expect(inspectConfig("[features\nhooks = true").state).toBe("unparseable");
  });

  it("sees an inline [hooks] table and the deprecated alias, and never touches either", () => {
    const inline = `[features]\ncodex_hooks = true\n\n[[hooks.PreToolUse]]\nmatcher = "Bash"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "python3 policy.py"\n`;
    const inspected = inspectConfig(inline);
    expect(inspected.hooksEnabled).toBe(true);
    expect(inspected.inlineHookEvents).toEqual(["PreToolUse"]);
    expect(planEnableHooks(inline)).toEqual({ kind: "unchanged" });
  });
});

describe("enabling features.hooks", () => {
  it("creates the file when there is none", () => {
    const plan = planEnableHooks(undefined);
    expect(plan).toEqual({
      kind: "create",
      newText: "[features]\nhooks = true\n",
    });
  });

  it("appends a [features] table to a file without one, keeping every byte before it", () => {
    const text =
      'model = "gpt-5.3-codex"\n\n[projects."/work/project"]\ntrust_level = "trusted"\n';
    const plan = planEnableHooks(text);
    expect(plan.kind).toBe("modify");
    if (plan.kind === "modify") {
      expect(plan.newText.startsWith(text)).toBe(true);
      expect(plan.newText.endsWith("\n[features]\nhooks = true\n")).toBe(true);
      expect(flag(plan.newText)).toBe(true);
      expect((parse(plan.newText) as { model: string }).model).toBe(
        "gpt-5.3-codex",
      );
    }
  });

  it("adds one line under an existing [features] table and keeps the user's keys and comments", () => {
    const plan = planEnableHooks(USER_CONFIG);
    expect(plan.kind).toBe("modify");
    if (plan.kind === "modify") {
      expect(plan.newText).toBe(
        USER_CONFIG.replace("[features]\n", "[features]\nhooks = true\n"),
      );
      expect(flag(plan.newText)).toBe(true);
    }
  });

  it("flips a false to true on the line that sets it, dotted or in the table", () => {
    const inTable = planEnableHooks("[features]\nhooks = false # off\n");
    expect(inTable.kind === "modify" && inTable.newText).toBe(
      "[features]\nhooks = true # off\n",
    );
    const dotted = planEnableHooks('model = "m"\nfeatures.hooks = false\n');
    expect(dotted.kind === "modify" && dotted.newText).toBe(
      'model = "m"\nfeatures.hooks = true\n',
    );
  });

  it("does nothing when the flag is already on, and leaves an inline table to the user", () => {
    expect(planEnableHooks("[features]\nhooks = true\n")).toEqual({
      kind: "unchanged",
    });
    expect(planEnableHooks("features = { web_search = true }\n")).toMatchObject(
      { kind: "unsupported" },
    );
    expect(planEnableHooks("[features\n")).toEqual({ kind: "unparseable" });
  });

  it("keeps CRLF line endings", () => {
    const plan = planEnableHooks(
      'model = "m"\r\n[features]\r\nweb_search = true\r\n',
    );
    expect(plan.kind === "modify" && plan.newText).toBe(
      'model = "m"\r\n[features]\r\nhooks = true\r\nweb_search = true\r\n',
    );
  });
});

describe("disabling features.hooks on uninstall", () => {
  it("removes the line REFLEX added and a header it leaves empty, and nothing else", () => {
    const enabled = planEnableHooks(USER_CONFIG);
    if (enabled.kind !== "modify") {
      throw new Error(enabled.kind);
    }
    const disabled = planDisableHooks(enabled.newText);
    expect(disabled.kind === "modify" && disabled.newText).toBe(USER_CONFIG);

    const created = planEnableHooks('model = "m"\n');
    if (created.kind !== "modify") {
      throw new Error(created.kind);
    }
    const back = planDisableHooks(created.newText);
    expect(back.kind === "modify" && back.newText).toBe('model = "m"\n');
  });

  it("is a no-op when the flag is not on, and refuses shapes it did not write", () => {
    expect(planDisableHooks('model = "m"\n')).toEqual({ kind: "unchanged" });
    expect(planDisableHooks("features = { hooks = true }\n")).toMatchObject({
      kind: "unsupported",
    });
  });
});
