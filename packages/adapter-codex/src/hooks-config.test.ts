import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

import {
  buildHookCommand,
  HOOK_TIMEOUT_SECONDS,
  inspectHooksFile,
  MANAGED_MARKER,
  OBSERVED_EVENTS,
  planInstall,
  planUninstall,
} from "./hooks-config.js";

/** RFX-050 — one hooks.json representation, installed and removed surgically. */
const COMMAND = buildHookCommand(
  "/usr/local/bin/node",
  "/opt/reflex/dist/bin.js",
);

const USER_FILE = `{
\t"description": "My hooks",
\t// a comment the user wrote
\t"hooks": {
\t\t"PreToolUse": [
\t\t\t{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "python3 ~/.codex/hooks/policy.py" }] }
\t\t],
\t\t"SessionStart": [
\t\t\t{ "matcher": "startup", "hooks": [{ "type": "command", "command": "python3 ~/.codex/hooks/notes.py" }] }
\t\t]
\t}
}
`;

const events = (text: string): Record<string, unknown[]> =>
  (parse(text) as { hooks: Record<string, unknown[]> }).hooks;

describe("the hook command", () => {
  it("is marked, quoted, and ends in hook codex", () => {
    expect(COMMAND).toBe(
      "REFLEX_MANAGED=1 '/usr/local/bin/node' '/opt/reflex/dist/bin.js' hook codex",
    );
    expect(buildHookCommand("/p/it's node", "/e")).toContain(
      "'/p/it'\\''s node'",
    );
  });
});

describe("installing into hooks.json", () => {
  it("creates the file with one hook per observed event, 5 s each", () => {
    const plan = planInstall(undefined, COMMAND);
    expect(plan.kind).toBe("create");
    if (plan.kind !== "create") {
      return;
    }
    expect(plan.events).toEqual([
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "Stop",
    ]);
    const hooks = events(plan.newText);
    for (const { event, matcher } of OBSERVED_EVENTS) {
      expect(hooks[event]).toEqual([
        {
          ...(matcher === undefined ? {} : { matcher }),
          hooks: [
            {
              type: "command",
              command: COMMAND,
              timeout: HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ]);
    }
  });

  it("keeps the user's hooks, comments, tabs and description byte for byte", () => {
    const plan = planInstall(USER_FILE, COMMAND);
    expect(plan.kind).toBe("modify");
    if (plan.kind !== "modify") {
      return;
    }
    expect(plan.newText).toContain('"description": "My hooks"');
    expect(plan.newText).toContain("// a comment the user wrote");
    expect(plan.newText).toContain("python3 ~/.codex/hooks/policy.py");
    expect(plan.newText).toContain("python3 ~/.codex/hooks/notes.py");
    expect(plan.newText.startsWith("{\n\t")).toBe(true);
    const hooks = events(plan.newText);
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.SessionStart).toHaveLength(1);
    expect(inspectHooksFile(plan.newText, COMMAND)).toEqual({
      state: "valid",
      installedEvents: [
        "PreToolUse",
        "SessionStart",
        "PermissionRequest",
        "PostToolUse",
        "Stop",
      ].filter((event) => event !== "SessionStart"),
      alteredEvents: [],
      foreignHooks: 2,
    });
  });

  it("is idempotent, and self-heals a moved rfx", () => {
    const first = planInstall(USER_FILE, COMMAND);
    if (first.kind !== "modify") {
      throw new Error(first.kind);
    }
    expect(planInstall(first.newText, COMMAND)).toEqual({
      kind: "already-installed",
    });
    const moved = planInstall(
      first.newText,
      buildHookCommand("/new/node", "/new/bin.js"),
    );
    expect(moved.kind).toBe("modify");
    if (moved.kind === "modify") {
      expect(moved.newText).not.toContain("/usr/local/bin/node");
      expect(events(moved.newText).PreToolUse).toHaveLength(2);
    }
  });

  it("refuses a file it cannot read, and one whose hooks member is not an object", () => {
    expect(planInstall('{"hooks": [', COMMAND)).toEqual({
      kind: "unparseable",
    });
    expect(planInstall('{"hooks": []}', COMMAND)).toEqual({
      kind: "unparseable",
    });
    expect(inspectHooksFile('{"hooks": 1}').state).toBe("unparseable");
  });
});

describe("uninstalling from hooks.json", () => {
  it("removes exactly REFLEX's entries and leaves the user's file as it was", () => {
    const installed = planInstall(USER_FILE, COMMAND);
    if (installed.kind !== "modify") {
      throw new Error(installed.kind);
    }
    const removed = planUninstall(installed.newText);
    expect(removed.kind).toBe("modify");
    if (removed.kind === "modify") {
      // The same hooks as before, comment and description kept. Byte-exact
      // restoration is the CLI's job, from its backup.
      expect(parse(removed.newText)).toEqual(parse(USER_FILE));
      expect(removed.newText).toContain("// a comment the user wrote");
      expect(removed.newText).not.toContain(MANAGED_MARKER);
      expect([...removed.removedEvents].sort()).toEqual([
        "PermissionRequest",
        "PostToolUse",
        "PreToolUse",
        "Stop",
      ]);
    }
    expect(planUninstall(USER_FILE)).toEqual({ kind: "nothing-to-remove" });
  });

  // Adversarial: the user put their own hook into REFLEX's group. Only ours goes.
  it("takes only its own hook out of a group the user also used", () => {
    const shared = JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [
                { type: "command", command: COMMAND, timeout: 5 },
                { type: "command", command: "echo mine" },
              ],
            },
          ],
        },
      },
      null,
      2,
    );
    const removed = planUninstall(shared);
    expect(removed.kind).toBe("modify");
    if (removed.kind === "modify") {
      expect(events(removed.newText).PreToolUse).toEqual([
        { matcher: "*", hooks: [{ type: "command", command: "echo mine" }] },
      ]);
    }
  });

  it("removes the hooks object and leaves the rest when nothing else is in it", () => {
    const created = planInstall('{ "description": "d" }\n', COMMAND);
    if (created.kind !== "modify") {
      throw new Error(created.kind);
    }
    const removed = planUninstall(created.newText);
    expect(removed.kind === "modify" && parse(removed.newText)).toEqual({
      description: "d",
    });
  });

  it("notices a managed hook that was altered (RFX-103)", () => {
    const installed = planInstall(undefined, COMMAND);
    if (installed.kind !== "create") {
      throw new Error(installed.kind);
    }
    const altered = installed.newText.replaceAll(
      COMMAND,
      `${MANAGED_MARKER} true`,
    );
    expect(inspectHooksFile(altered, COMMAND).alteredEvents).toEqual([
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "Stop",
    ]);
  });
});
