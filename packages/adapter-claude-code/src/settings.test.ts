import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

import { DEFAULT_SCOPE, managedSettingsPaths, settingsPath } from "./detect.js";
import {
  HOOK_TIMEOUT_SECONDS,
  MANAGED_MARKER,
  OBSERVED_EVENTS,
  buildHookCommand,
  inspectSettings,
  planInstall,
  planUninstall,
} from "./settings.js";

const COMMAND = buildHookCommand("/usr/local/bin/node", "/opt/reflex/rfx.js");
const EVENTS = OBSERVED_EVENTS.map(({ event }) => event);

const USER_SETTINGS = `{
  "model": "opus",
  "permissions": {
    "allow": ["Bash(git status)"],
    "deny": ["Read(./.env)"]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "~/bin/audit.sh" }]
      }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "afplay ding.aiff" }] }
    ]
  }
}
`;

function installed(text: string | undefined, command = COMMAND): string {
  const plan = planInstall(text, command);
  if (plan.kind !== "create" && plan.kind !== "modify") {
    throw new Error(`expected an install plan, got ${plan.kind}`);
  }
  return plan.newText;
}

function uninstalled(text: string): string {
  const plan = planUninstall(text);
  if (plan.kind !== "modify") {
    throw new Error(`expected an uninstall plan, got ${plan.kind}`);
  }
  return plan.newText;
}

/** RFX-041 — detection is read-only and returns the exact mutation plan. */
describe("RFX-041 detection", () => {
  const roots = { projectDir: "/work/app", homeDir: "/home/dev" };

  it("installs into the personal project file by default", () => {
    expect(DEFAULT_SCOPE).toBe("local");
    expect(settingsPath("local", roots)).toBe(
      "/work/app/.claude/settings.local.json",
    );
    expect(settingsPath("project", roots)).toBe(
      "/work/app/.claude/settings.json",
    );
    expect(settingsPath("user", roots)).toBe("/home/dev/.claude/settings.json");
  });

  it("knows where administrators deploy settings, to warn and never to write", () => {
    expect(managedSettingsPaths("darwin")[0]).toContain("/Library/");
    expect(managedSettingsPaths("linux")[0]).toContain("/etc/");
    expect(managedSettingsPaths("win32")[0]).toContain("ProgramData");
  });

  it("reports what is there without changing it", () => {
    expect(inspectSettings(undefined)).toMatchObject({ state: "absent" });
    expect(inspectSettings(USER_SETTINGS)).toEqual({
      state: "valid",
      hooksDisabled: false,
      managedHooksOnly: false,
      installedEvents: [],
      alteredEvents: [],
      foreignHooks: 2,
    });
    expect(inspectSettings(installed(USER_SETTINGS))).toMatchObject({
      installedEvents: expect.arrayContaining(EVENTS) as unknown,
      foreignHooks: 2,
    });
  });

  // RFX-103: a hook that keeps REFLEX's marker and runs something else.
  it("tells a hook that runs the expected command from one that was altered", () => {
    const text = installed(USER_SETTINGS);
    expect(inspectSettings(text, COMMAND).alteredEvents).toEqual([]);
    // Without an expected command there is nothing to compare with.
    expect(inspectSettings(text).alteredEvents).toEqual([]);

    const altered = text.replace(
      JSON.stringify(COMMAND),
      JSON.stringify("REFLEX_MANAGED=1 true"),
    );
    expect(altered).not.toBe(text);
    const inspection = inspectSettings(altered, COMMAND);
    expect(inspection.alteredEvents).toHaveLength(1);
    // Still counted as installed: the marker is there, which is the point.
    expect(inspection.installedEvents).toEqual(
      expect.arrayContaining(EVENTS) as unknown,
    );
  });

  // An install that can never run must be said out loud (CLAUDE.md §5).
  it("sees the switches that would leave REFLEX installed and never run", () => {
    expect(inspectSettings('{"disableAllHooks": true}').hooksDisabled).toBe(
      true,
    );
    expect(
      inspectSettings('{"allowManagedHooksOnly": true}').managedHooksOnly,
    ).toBe(true);
    // Only the literal `true` counts. Anything else is not the switch.
    expect(inspectSettings('{"disableAllHooks": "true"}').hooksDisabled).toBe(
      false,
    );
  });

  it.each([
    ["truncated", '{"hooks": {'],
    ["an array", "[]"],
    ["a string", '"settings"'],
    ["hooks of the wrong type", '{"hooks": []}'],
    ["hooks as a string", '{"hooks": "none"}'],
  ])(
    "says a file it does not understand is unparseable: %s",
    (_label, text) => {
      expect(inspectSettings(text).state).toBe("unparseable");
      expect(planInstall(text, COMMAND).kind).toBe("unparseable");
      expect(planUninstall(text).kind).toBe("unparseable");
    },
  );
});

/** RFX-044 — a reversible installer. */
describe("RFX-044 install plan", () => {
  it("creates a settings file when there is none", () => {
    const plan = planInstall(undefined, COMMAND);
    expect(plan.kind).toBe("create");
    const root = parse(installed(undefined)) as {
      hooks: Record<string, { matcher?: string; hooks: unknown[] }[]>;
    };

    expect(Object.keys(root.hooks)).toEqual(EVENTS);
    expect(root.hooks.PreToolUse).toEqual([
      {
        matcher: "*",
        hooks: [
          { type: "command", command: COMMAND, timeout: HOOK_TIMEOUT_SECONDS },
        ],
      },
    ]);
    // Stop is not a tool event: it takes no matcher.
    expect(root.hooks.Stop?.[0]).not.toHaveProperty("matcher");
  });

  it("bounds the hook with an explicit timeout far below the host default", () => {
    expect(HOOK_TIMEOUT_SECONDS).toBeLessThanOrEqual(10);
  });

  it("leaves every byte the user wrote exactly where it was", () => {
    const after = installed(USER_SETTINGS);
    // Every original line survives, in order.
    let cursor = 0;
    for (const line of USER_SETTINGS.split("\n").filter(
      (l) => l.trim() !== "",
    )) {
      const found = after.indexOf(line.trimEnd(), cursor);
      expect(found, `lost or moved: ${line}`).toBeGreaterThanOrEqual(0);
      cursor = found;
    }
    const root = parse(after) as {
      model: string;
      permissions: unknown;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(root.model).toBe("opus");
    expect(root.permissions).toEqual({
      allow: ["Bash(git status)"],
      deny: ["Read(./.env)"],
    });
    // The user's own hook is still first; ours was appended after it.
    expect(root.hooks.PreToolUse?.map((g) => g.hooks[0]?.command)).toEqual([
      "~/bin/audit.sh",
      COMMAND,
    ]);
    expect(root.hooks.Notification).toHaveLength(1);
  });

  it.each([
    ["two spaces", '{\n  "model": "opus"\n}\n'],
    ["four spaces", '{\n    "model": "opus"\n}\n'],
    ["tabs", '{\n\t"model": "opus"\n}\n'],
    ["CRLF line endings", '{\r\n  "model": "opus"\r\n}\r\n'],
    ["no trailing newline", '{\n  "model": "opus"\n}'],
    ["comments and a trailing comma", '{\n  // mine\n  "model": "opus",\n}\n'],
    ["a compact file", '{"model":"opus"}'],
    ["an empty object", "{}\n"],
    ["an empty file", ""],
  ])("installs into a file written with %s and can undo it", (_label, text) => {
    const after = installed(text);
    expect(inspectSettings(after).installedEvents).toEqual(EVENTS);
    expect(after.includes("\r\n")).toBe(text.includes("\r\n"));
    if (text.includes("\t")) {
      expect(after).toContain('\n\t"hooks"');
    }

    // Undoing it leaves the user's content, and no trace of REFLEX.
    const restored = uninstalled(after);
    expect(restored).not.toContain(MANAGED_MARKER);
    expect(parse(restored || "{}", [], { allowTrailingComma: true })).toEqual(
      parse(text || "{}", [], { allowTrailingComma: true }),
    );
    if (text.includes("// mine")) {
      expect(restored).toContain("// mine");
    }
  });

  it("is idempotent", () => {
    const once = installed(USER_SETTINGS);
    expect(planInstall(once, COMMAND)).toEqual({ kind: "already-installed" });
  });

  it("heals a partial or outdated install instead of stacking a second one", () => {
    const old = installed(
      USER_SETTINGS,
      buildHookCommand("/old/node", "/old/rfx.js"),
    );
    // The user also deleted one of our entries by hand.
    const partial = uninstalled(old).replace("{", '{\n  "x": 1,');
    const broken = installed(
      partial,
      buildHookCommand("/old/node", "/old/rfx.js"),
    ).replace(/"PermissionDenied": \[[\s\S]*?\],\s*/, "");

    const healed = installed(broken);
    expect(healed).not.toContain("/old/rfx.js");
    expect(inspectSettings(healed).installedEvents).toEqual(
      expect.arrayContaining(EVENTS),
    );
    const root = parse(healed) as { hooks: Record<string, unknown[]> };
    // One REFLEX group per event, never two.
    expect(root.hooks.PostToolUse).toHaveLength(1);
    expect(root.hooks.PreToolUse).toHaveLength(2);
  });

  it("quotes a path with spaces, quotes and dollars so the shell sees one word", () => {
    const command = buildHookCommand(
      "/Applications/My Node/bin/node",
      "/Users/o'brien/$HOME/rfx.js",
    );
    expect(command).toBe(
      `${MANAGED_MARKER} '/Applications/My Node/bin/node' '/Users/o'\\''brien/$HOME/rfx.js' hook claude-code`,
    );
    const root = parse(installed(undefined, command)) as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    expect(root.hooks.PreToolUse[0]?.hooks[0]?.command).toBe(command);
  });
});

describe("RFX-044 uninstall plan", () => {
  it("removes exactly what REFLEX added", () => {
    const restored = uninstalled(installed(USER_SETTINGS));
    expect(parse(restored)).toEqual(parse(USER_SETTINGS));
    expect(restored).not.toContain(MANAGED_MARKER);
    expect(restored).toContain("~/bin/audit.sh");
  });

  it("keeps edits the user made after installing", () => {
    const after = installed(USER_SETTINGS)
      .replace('"model": "opus"', '"model": "sonnet"')
      .replace(
        '"deny": ["Read(./.env)"]',
        '"deny": ["Read(./.env)", "Bash(curl *)"]',
      );
    const root = parse(uninstalled(after)) as {
      model: string;
      permissions: { deny: string[] };
    };
    expect(root.model).toBe("sonnet");
    expect(root.permissions.deny).toEqual(["Read(./.env)", "Bash(curl *)"]);
  });

  it("removes the hooks object it created, and not one the user had", () => {
    expect(parse(uninstalled(installed('{"model":"opus"}')))).toEqual({
      model: "opus",
    });
    expect(parse(uninstalled(installed(USER_SETTINGS)))).toHaveProperty(
      "hooks",
    );
  });

  it("is idempotent", () => {
    expect(planUninstall(USER_SETTINGS)).toEqual({ kind: "nothing-to-remove" });
    expect(planUninstall(uninstalled(installed(USER_SETTINGS)))).toEqual({
      kind: "nothing-to-remove",
    });
  });

  it("takes only its own hook out of a group the user also uses", () => {
    const shared = `{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "~/bin/mine.sh" },
          { "type": "command", "command": "${COMMAND.replaceAll("'", "\\u0027")}" }
        ]
      }
    ]
  }
}
`;
    const root = parse(uninstalled(shared)) as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    expect(root.hooks.PreToolUse[0]?.hooks).toEqual([
      { type: "command", command: "~/bin/mine.sh" },
    ]);
  });

  // Adversarial: the marker identifies REFLEX's entries. A user hook that
  // merely mentions it must survive an uninstall.
  it("does not mistake a user hook that mentions the marker for its own", () => {
    const lookalikes = `{
  "hooks": {
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "echo ${MANAGED_MARKER} >> log" }] },
      { "hooks": [{ "type": "command", "command": "X=1 ${MANAGED_MARKER} ./mine.sh" }] },
      { "hooks": [{ "type": "command", "command": "${MANAGED_MARKER}0 ./mine.sh" }] },
      { "hooks": [{ "type": "prompt", "prompt": "${MANAGED_MARKER} is fine" }] }
    ]
  }
}
`;
    expect(planUninstall(lookalikes)).toEqual({ kind: "nothing-to-remove" });
    expect(inspectSettings(lookalikes)).toMatchObject({
      installedEvents: [],
      foreignHooks: 4,
    });
  });
});
