import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MANAGED_MARKER } from "@reflex/adapter-claude-code";
import {
  ObservationLog,
  RECORD_VERSION,
  type ObservationRecord,
} from "@reflex/telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nodeFileSystem } from "../backups/file-system.js";
import {
  renderInitPlan,
  renderStatus,
  renderUninstallPlan,
} from "../output/render.js";
import { statePaths, type Environment } from "../state.js";
import { applyInit, planInit, type InitProbes } from "./init.js";
import { collectStatus } from "./status.js";
import { applyUninstall, planUninstallCommand } from "./uninstall.js";

let root: string;
let env: Environment;
let settings: string;

const NOW = new Date("2026-09-19T10:00:00.000Z");
const probes: InitProbes = {
  hostVersion: () => Promise.resolve("2.1.276 (Claude Code)"),
  isGitIgnored: () => Promise.resolve(true),
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-cli-"));
  env = {
    homeDir: join(root, "home"),
    projectDir: join(root, "project"),
    reflexHomeOverride: join(root, "reflex-home"),
    platform: "linux",
    nodePath: "/usr/local/bin/node",
    entryPath: "/opt/reflex/dist/bin.js",
    now: () => NOW,
  };
  settings = join(env.projectDir, ".claude", "settings.local.json");
  await mkdir(join(env.projectDir, ".claude"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function listAll(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { recursive: true })).sort();
  } catch {
    return [];
  }
}

async function install(): Promise<void> {
  const plan = await planInit(env, "local", nodeFileSystem, probes);
  if (plan.kind !== "install") {
    throw new Error(`expected an install plan, got ${plan.kind}`);
  }
  const result = await applyInit(plan, nodeFileSystem, env.now);
  expect(result.ok).toBe(true);
}

async function uninstall(): Promise<void> {
  const plan = await planUninstallCommand(env, nodeFileSystem);
  const result = await applyUninstall(plan, nodeFileSystem, env.now);
  expect(result.ok).toBe(true);
}

/** RFX-041 / RFX-052 — read-only detection, deterministic plan, then mutate. */
describe("rfx init: the plan", () => {
  it("is read-only: planning creates and changes nothing", async () => {
    await writeFile(settings, '{\n  "model": "opus"\n}\n');
    const before = await listAll(root);

    const plan = await planInit(env, "local", nodeFileSystem, probes);

    expect(plan.kind).toBe("install");
    expect(await listAll(root)).toEqual(before);
    expect(await readFile(settings, "utf8")).toBe('{\n  "model": "opus"\n}\n');
  });

  it("is deterministic: the same state gives the same plan, byte for byte", async () => {
    await writeFile(settings, '{\n  "model": "opus"\n}\n');
    const first = await planInit(env, "local", nodeFileSystem, probes);
    const second = await planInit(env, "local", nodeFileSystem, probes);

    expect(renderInitPlan(first)).toBe(renderInitPlan(second));
    if (first.kind === "install" && second.kind === "install") {
      // Only the random local IDs may differ; the settings bytes may not.
      expect(first.writes[0]).toEqual(second.writes[0]);
    }
  });

  it("says exactly what it will do before doing it", async () => {
    const text = renderInitPlan(
      await planInit(env, "local", nodeFileSystem, probes),
    );
    expect(text).toContain(`create  ${settings}`);
    expect(text).toContain("PreToolUse, PermissionRequest, PostToolUse");
    expect(text).toContain(`${MANAGED_MARKER} '/usr/local/bin/node'`);
    expect(text).toContain("never blocks, approves or prompts");
    expect(text).toContain("never their values");
  });

  it("refuses to touch a settings file it cannot read", async () => {
    await writeFile(settings, '{"hooks": {');
    const plan = await planInit(env, "local", nodeFileSystem, probes);

    expect(plan).toMatchObject({ kind: "blocked", settingsPath: settings });
    expect(renderInitPlan(plan)).toContain("will not touch it");
    expect(await readFile(settings, "utf8")).toBe('{"hooks": {');
  });

  // CLAUDE.md principle 5: an install that can never run is said out loud.
  it("warns when something would leave REFLEX installed and never run", async () => {
    await mkdir(join(env.homeDir, ".claude"), { recursive: true });
    await writeFile(
      join(env.homeDir, ".claude", "settings.json"),
      '{"disableAllHooks": true}',
    );
    const plan = await planInit(env, "local", nodeFileSystem, {
      hostVersion: () => Promise.resolve(undefined),
      isGitIgnored: () => Promise.resolve(false),
    });

    expect(plan.kind === "install" && plan.warnings.map((w) => w.kind)).toEqual(
      ["hooks-disabled", "not-git-ignored", "host-not-found"],
    );
    expect(renderInitPlan(plan)).toContain("would be installed and never run");
  });

  it("warns before writing a machine-specific path into the shared file", async () => {
    const plan = await planInit(env, "project", nodeFileSystem, probes);
    expect(plan.kind === "install" && plan.warnings.map((w) => w.kind)).toEqual(
      ["shared-settings-file"],
    );
  });
});

describe("rfx init: applying the plan", () => {
  it("installs the hooks, the registry and a private anonymous identity", async () => {
    await install();
    const paths = statePaths(env.reflexHomeOverride ?? "");

    expect(await readFile(settings, "utf8")).toContain(MANAGED_MARKER);
    const identity = JSON.parse(await readFile(paths.identity, "utf8")) as {
      agentId: string;
    };
    expect(identity.agentId).toMatch(/^agt_[0-9a-f]{32}$/);
    // Nothing about the user or the machine is in it.
    expect(Object.keys(identity).sort()).toEqual([
      "agentId",
      "createdAt",
      "version",
    ]);
    // REFLEX's own state is readable by the user only.
    expect((await stat(paths.identity)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.installs)).mode & 0o777).toBe(0o600);
  });

  it("keeps one identity and one project ID across re-installs", async () => {
    await install();
    const paths = statePaths(env.reflexHomeOverride ?? "");
    const identity = await readFile(paths.identity, "utf8");
    const projectId = (
      JSON.parse(await readFile(paths.installs, "utf8")) as {
        installs: { projectId: string }[];
      }
    ).installs[0]?.projectId;

    await uninstall();
    await install();

    expect(await readFile(paths.identity, "utf8")).toBe(identity);
    expect(
      (
        JSON.parse(await readFile(paths.installs, "utf8")) as {
          installs: { projectId: string }[];
        }
      ).installs[0]?.projectId,
    ).toBe(projectId);
  });

  it("is idempotent", async () => {
    await install();
    const once = await readFile(settings, "utf8");
    const plan = await planInit(env, "local", nodeFileSystem, probes);

    expect(plan.kind).toBe("already-installed");
    expect(await readFile(settings, "utf8")).toBe(once);
  });

  // Adversarial: the user approved a plan for specific bytes.
  it("writes nothing if the file changed while the plan was on screen", async () => {
    await writeFile(settings, '{\n  "model": "opus"\n}\n');
    const plan = await planInit(env, "local", nodeFileSystem, probes);
    await writeFile(settings, '{\n  "model": "sonnet"\n}\n');

    expect(plan.kind).toBe("install");
    if (plan.kind === "install") {
      const result = await applyInit(plan, nodeFileSystem, env.now);
      expect(result).toMatchObject({ ok: false, reason: "changed-since-plan" });
    }
    expect(await readFile(settings, "utf8")).toBe(
      '{\n  "model": "sonnet"\n}\n',
    );
    expect(await listAll(env.reflexHomeOverride ?? "")).toEqual([]);
  });
});

/** RFX-044 / RFX-057 — uninstall. */
describe("rfx uninstall", () => {
  const ORIGINAL = '{\n\t"model": "opus",\n\t"env": { "A": "1" }\n}';

  it("restores the file byte for byte when nothing changed since install", async () => {
    await writeFile(settings, ORIGINAL);
    await chmod(settings, 0o600);
    await install();
    expect(await readFile(settings, "utf8")).not.toBe(ORIGINAL);

    const plan = await planUninstallCommand(env, nodeFileSystem);
    expect(plan.removals).toEqual([
      { settingsPath: settings, method: "exact-restore" },
    ]);
    await uninstall();

    expect(await readFile(settings, "utf8")).toBe(ORIGINAL);
    expect((await stat(settings)).mode & 0o777).toBe(0o600);
  });

  it("removes a settings file that REFLEX itself created", async () => {
    await install();
    await uninstall();
    expect(await nodeFileSystem.read(settings)).toBeUndefined();
  });

  it("keeps the edits the user made after installing", async () => {
    await writeFile(settings, '{\n  "model": "opus"\n}\n');
    await install();
    const edited = (await readFile(settings, "utf8")).replace(
      '"model": "opus"',
      '"model": "sonnet",\n  "permissions": { "deny": ["Bash(curl *)"] }',
    );
    await writeFile(settings, edited);

    const plan = await planUninstallCommand(env, nodeFileSystem);
    expect(plan.removals).toEqual([
      { settingsPath: settings, method: "surgical" },
    ]);
    expect(renderUninstallPlan(plan)).toContain("keep your changes");
    await uninstall();

    const after = await readFile(settings, "utf8");
    expect(after).not.toContain(MANAGED_MARKER);
    expect(JSON.parse(after)).toEqual({
      model: "sonnet",
      permissions: { deny: ["Bash(curl *)"] },
    });
  });

  it("is idempotent, and says so", async () => {
    await install();
    await uninstall();
    const plan = await planUninstallCommand(env, nodeFileSystem);

    expect(plan.writes).toEqual([]);
    expect(renderUninstallPlan(plan)).toContain("Nothing to do");
  });

  it("finds hooks that its own registry has lost track of", async () => {
    await install();
    await rm(statePaths(env.reflexHomeOverride ?? "").installs);

    const plan = await planUninstallCommand(env, nodeFileSystem);
    expect(plan.removals).toEqual([
      { settingsPath: settings, method: "surgical" },
    ]);
    await uninstall();
    expect(await readFile(settings, "utf8")).not.toContain(MANAGED_MARKER);
  });

  it("leaves other projects' installs alone", async () => {
    await install();
    const other = { ...env, projectDir: join(root, "other") };
    await mkdir(join(other.projectDir, ".claude"), { recursive: true });
    const plan = await planInit(other, "local", nodeFileSystem, probes);
    if (plan.kind === "install") {
      await applyInit(
        plan,
        nodeFileSystem,
        () => new Date(NOW.getTime() + 1_000),
      );
    }

    await uninstall();

    const registry = JSON.parse(
      await readFile(statePaths(env.reflexHomeOverride ?? "").installs, "utf8"),
    ) as { installs: { projectDir: string }[] };
    expect(registry.installs.map((entry) => entry.projectDir)).toEqual([
      other.projectDir,
    ]);
    expect(
      await readFile(
        join(other.projectDir, ".claude", "settings.local.json"),
        "utf8",
      ),
    ).toContain(MANAGED_MARKER);
  });

  // Adversarial: a tampered backup must not be "restored" over the user's file.
  it("falls back to surgical removal when the backup was tampered with", async () => {
    await writeFile(settings, '{\n  "model": "opus"\n}\n');
    await install();
    const backups = join(env.reflexHomeOverride ?? "", "backups");
    const [run] = await readdir(backups);
    await writeFile(
      join(backups, run ?? "", "000.bak"),
      '{"model":"attacker"}',
    );

    const plan = await planUninstallCommand(env, nodeFileSystem);
    expect(plan.removals[0]?.method).toBe("surgical");
    await uninstall();
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({
      model: "opus",
    });
  });
});

/** RFX-056 — status works locally, without a dashboard. */
describe("rfx status", () => {
  it("says so when nothing is installed", async () => {
    const report = await collectStatus(env, nodeFileSystem);
    expect(report.adapters).toEqual([]);
    expect(renderStatus(report, NOW)).toContain('Run "rfx init"');
  });

  it("reports an active adapter, the identity and an empty history", async () => {
    await install();
    const report = await collectStatus(env, nodeFileSystem);

    expect(report).toMatchObject({
      mode: "observe",
      adapters: [{ host: "claude-code", health: "active" }],
      summary: { actions: 0 },
    });
    expect(renderStatus(report, NOW)).toContain("nothing yet");
  });

  // REFLEX must never be silently absent: status re-reads the file itself.
  it("notices a hook that was removed behind its back", async () => {
    await install();
    const text = await readFile(settings, "utf8");
    await writeFile(
      settings,
      text.replace(/"PreToolUse": \[[\s\S]*?\],\s*/, ""),
    );

    const report = await collectStatus(env, nodeFileSystem);
    expect(report.adapters[0]?.health).toBe("missing");
    expect(renderStatus(report, NOW)).toContain("HOOK MISSING");
  });

  it("notices hooks being switched off", async () => {
    await install();
    const text = await readFile(settings, "utf8");
    await writeFile(
      settings,
      text.replace("{", '{\n  "disableAllHooks": true,'),
    );

    const report = await collectStatus(env, nodeFileSystem);
    expect(report.adapters[0]?.health).toBe("disabled");
    expect(renderStatus(report, NOW)).toContain("REFLEX is not running");
  });

  it("summarizes this project's outcomes and keeps unknown apart", async () => {
    await install();
    const log = new ObservationLog({
      directory: statePaths(env.reflexHomeOverride ?? "").observe,
    });
    const at = (second: number) =>
      new Date(NOW.getTime() - 60_000 + second * 1_000).toISOString();
    const action = (
      id: string,
      tool: string,
      second: number,
      projectRoot: string,
    ) =>
      ({
        kind: "action",
        recordVersion: RECORD_VERSION,
        recordedAt: at(second),
        hookMs: 20 + second,
        actionId: `act_${id}`,
        sessionId: "ses_one",
        host: "claude-code",
        toolName: tool,
        sideEffectClass: "unknown",
        projectRoot,
        createdAt: at(second),
        argumentShape: { type: "object", keys: {}, otherKeys: 0 },
      }) satisfies ObservationRecord;
    const signal = (
      id: string,
      name: "executed" | "permission-requested",
      second: number,
    ) =>
      ({
        kind: "signal",
        recordVersion: RECORD_VERSION,
        recordedAt: at(second),
        actionId: `act_${id}`,
        sessionId: "ses_one",
        signal: name,
      }) satisfies ObservationRecord;

    for (const record of [
      action("a", "Read", 1, env.projectDir),
      signal("a", "executed", 2),
      action("b", "Bash", 3, join(env.projectDir, "packages", "x")),
      signal("b", "permission-requested", 4),
      signal("b", "executed", 5),
      action("c", "Bash", 6, env.projectDir),
      action("z", "Bash", 7, join(root, "some-other-project")),
    ]) {
      await log.append(record);
    }

    const report = await collectStatus(env, nodeFileSystem);
    expect(report.summary).toEqual({
      actions: 3,
      prompted: 1,
      approved: 1,
      rejected: 0,
      ranWithoutPrompt: 1,
      blockedByHost: 0,
      unknown: 1,
    });
    expect(report.lastAction?.toolName).toBe("Bash");
    // Three, not four: the fourth timed record belongs to another project.
    expect(report.overhead).toMatchObject({ samples: 3 });
  });

  // Adversarial: an MCP server chooses its tool names, and a terminal runs
  // escape sequences.
  it("never prints a tool name's control characters", async () => {
    await install();
    await new ObservationLog({
      directory: statePaths(env.reflexHomeOverride ?? "").observe,
    }).append({
      kind: "action",
      recordVersion: RECORD_VERSION,
      recordedAt: NOW.toISOString(),
      actionId: "act_evil",
      host: "claude-code",
      toolName: "\x1b[2J\x1b[31mAll actions approved\x07\n",
      toolNamespace: "evil\x1b]0;pwned\x07",
      sideEffectClass: "unknown",
      projectRoot: env.projectDir,
      createdAt: NOW.toISOString(),
      argumentShape: { type: "object", keys: {}, otherKeys: 0 },
    });

    const text = renderStatus(await collectStatus(env, nodeFileSystem), NOW);
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\x07");
    expect(text).toContain("All actions approved");
  });
});
