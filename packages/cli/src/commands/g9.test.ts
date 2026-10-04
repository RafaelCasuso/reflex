import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STARTER_POLICY_YAML } from "@reflex/policy-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nodeFileSystem } from "../backups/file-system.js";
import type { Environment } from "../state.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { explain, renderExplanation } from "./explain.js";
import { applyInit, planInit, type InitProbes } from "./init.js";
import {
  currentPause,
  pauseEnforcement,
  resumeEnforcement,
} from "./pause-command.js";
import { writeStarterPolicy } from "./starter.js";
import {
  describeAllowRules,
  readProjectPolicy,
  trustProjectPolicy,
} from "./trust.js";

/**
 * G9 — the starter policy (RFX-054), trust (RFX-104), explain (RFX-099),
 * pause (RFX-126) and doctor (RFX-055), on a real temporary file system.
 */
let root: string;
let env: Environment;
const NOW = new Date("2026-10-04T10:00:00.000Z");
const probes: InitProbes = {
  hostVersion: (host) =>
    Promise.resolve(
      host === "claude-code" ? "2.1.283 (Claude Code)" : undefined,
    ),
  isGitIgnored: () => Promise.resolve(true),
};

const REPO_POLICY = `version: 1
rules:
  - id: repo.allow-curl
    name: The repository allows curl
    effect: allow
    conditions:
      - { field: command.name, operator: equals, value: curl }
  - id: repo.deny-touch
    name: The repository denies touch
    effect: deny
    conditions:
      - { field: command.name, operator: equals, value: touch }
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-g9-"));
  env = {
    homeDir: join(root, "home"),
    projectDir: join(root, "home", "work", "project"),
    reflexHomeOverride: join(root, "reflex-home"),
    platform: "linux",
    nodePath: process.execPath,
    // A real file, so that doctor finds the entry the hook command names.
    entryPath: process.execPath,
    now: () => NOW,
  };
  await mkdir(join(env.projectDir, ".claude"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function install(): Promise<void> {
  const plan = await planInit(
    env,
    "claude-code",
    "local",
    nodeFileSystem,
    probes,
  );
  if (plan.kind !== "install") {
    throw new Error(plan.kind);
  }
  expect((await applyInit(plan, nodeFileSystem, env.now)).ok).toBe(true);
}

describe("RFX-054 the starter policy", () => {
  it("is written by rfx init when the project has none, trusted as written, and never over an existing file", async () => {
    const policyPath = join(env.projectDir, ".reflex", "policy.yaml");
    const plan = await planInit(
      env,
      "claude-code",
      "local",
      nodeFileSystem,
      probes,
    );
    expect(plan.kind === "install" && plan.starterPolicyPath).toBe(policyPath);
    await install();
    expect(await readFile(policyPath, "utf8")).toBe(STARTER_POLICY_YAML);
    const status = await readProjectPolicy(env, nodeFileSystem);
    expect(status.reading).toMatchObject({
      path: policyPath,
      trusted: true,
      problems: [],
    });

    // The user edits it: still theirs, untrusted again, and init leaves it alone.
    await writeFile(policyPath, REPO_POLICY);
    const again = await planInit(
      env,
      "claude-code",
      "local",
      nodeFileSystem,
      probes,
    );
    expect(again.kind).toBe("already-installed");
    expect(await readFile(policyPath, "utf8")).toBe(REPO_POLICY);
    expect(
      (await readProjectPolicy(env, nodeFileSystem)).reading?.trusted,
    ).toBe(false);
  });

  it("refuses to replace an existing file without --force, and keeps a copy with it", async () => {
    const policyPath = join(env.projectDir, ".reflex", "policy.yaml");
    await mkdir(join(env.projectDir, ".reflex"), { recursive: true });
    await writeFile(policyPath, REPO_POLICY);
    expect(await writeStarterPolicy(env, nodeFileSystem)).toEqual({
      kind: "exists",
      path: policyPath,
    });
    expect(await readFile(policyPath, "utf8")).toBe(REPO_POLICY);
    const replaced = await writeStarterPolicy(env, nodeFileSystem, {
      force: true,
    });
    expect(replaced.kind).toBe("replaced");
    expect(await readFile(policyPath, "utf8")).toBe(STARTER_POLICY_YAML);
    if (replaced.kind === "replaced" && replaced.backup !== undefined) {
      expect(await readFile(replaced.backup, "utf8")).toBe(REPO_POLICY);
    }
  });
});

describe("RFX-104 trust", () => {
  it("shows the allow rules in full, trusts this content, and loses it when the content changes", async () => {
    const policyPath = join(env.projectDir, ".reflex", "policy.yaml");
    await mkdir(join(env.projectDir, ".reflex"), { recursive: true });
    await writeFile(policyPath, REPO_POLICY);
    const before = await readProjectPolicy(env, nodeFileSystem);
    expect(before.reading?.trusted).toBe(false);
    const shown = describeAllowRules(before.reading?.allowRules ?? []);
    expect(shown[0]).toContain("allow  repo.allow-curl");
    expect(shown[1]).toContain('when command.name equals "curl"');
    // Never the deny rule: trusting changes nothing about it.
    expect(shown.join("\n")).not.toContain("deny-touch");

    const trusted = await trustProjectPolicy(env, nodeFileSystem);
    expect(trusted.kind).toBe("trusted");
    expect(
      (await readProjectPolicy(env, nodeFileSystem)).reading?.trusted,
    ).toBe(true);

    await writeFile(
      policyPath,
      REPO_POLICY.replace("value: curl", "value: rm"),
    );
    expect(
      (await readProjectPolicy(env, nodeFileSystem)).reading?.trusted,
    ).toBe(false);
    expect(
      await trustProjectPolicy(env, nodeFileSystem, { revoke: true }),
    ).toEqual({ kind: "revoked", path: policyPath });
  });

  it("has nothing to trust without a project policy, and refuses one that does not load", async () => {
    expect(await trustProjectPolicy(env, nodeFileSystem)).toEqual({
      kind: "no-policy",
    });
    await mkdir(join(env.projectDir, ".reflex"), { recursive: true });
    await writeFile(
      join(env.projectDir, ".reflex", "policy.yaml"),
      "version: 1\nrules: [\n",
    );
    expect((await trustProjectPolicy(env, nodeFileSystem)).kind).toBe(
      "unparseable",
    );
  });
});

describe("RFX-099 explain", () => {
  it("explains from the same evaluation the daemon makes: matches, sources, precedence, effect, modes", async () => {
    await install();
    const allowed = await explain(
      { host: "claude-code", command: "git status" },
      env,
      nodeFileSystem,
    );
    expect(allowed.effect).toBe("allow");
    expect(allowed.matches[0]).toMatchObject({
      ruleId: "starter.allow-reads",
      source: "project",
      decides: true,
    });
    expect(allowed.byMode).toEqual({
      observe: "ask",
      assist: "allow",
      autopilot: "allow",
    });
    const text = renderExplanation(allowed, env);
    expect(text).toContain("Effect       allow");
    expect(text).toContain("<- decides");
    expect(text).toContain("trusted");

    const open = await explain(
      { host: "claude-code", command: "curl https://example.test" },
      env,
      nodeFileSystem,
    );
    expect(open.effect).toBeUndefined();
    expect(open.unresolved).toBe("semantic");
    expect(open.byMode.autopilot).toBe("ask");
    expect(renderExplanation(open, env)).toContain("unresolved");

    const file = await explain(
      {
        host: "claude-code",
        tool: "Write",
        path: join(env.projectDir, ".reflex", "policy.yaml"),
      },
      env,
      nodeFileSystem,
    );
    // REFLEX's own rule: writing the policy through the agent asks a human.
    expect(
      file.matches.some(
        (match) =>
          match.ruleId === "reflex.protect-own-files" && match.mandatory,
      ),
    ).toBe(true);
    expect(file.byMode.autopilot).toBe("ask");
  });

  // Adversarial: the hostile clone, through explain. Its allow is shown as
  // ignored; its deny decides.
  it("shows an untrusted project policy's deny deciding and its allow ignored", async () => {
    await mkdir(join(env.projectDir, ".reflex"), { recursive: true });
    await writeFile(
      join(env.projectDir, ".reflex", "policy.yaml"),
      REPO_POLICY,
    );
    const denied = await explain(
      { host: "claude-code", command: "touch marker" },
      env,
      nodeFileSystem,
    );
    expect(denied.effect).toBe("deny");
    const notAllowed = await explain(
      { host: "claude-code", command: "curl https://example.test" },
      env,
      nodeFileSystem,
    );
    expect(notAllowed.effect).toBeUndefined();
    expect(renderExplanation(notAllowed, env)).toContain(
      "untrusted: its 1 allow rule(s) are ignored",
    );
  });
});

describe("RFX-126 pause", () => {
  it("needs a bounded duration, is visible, ends by itself, and is audited", async () => {
    expect(
      await pauseEnforcement(env, nodeFileSystem, undefined, undefined),
    ).toEqual({ kind: "bad-duration" });
    expect(
      await pauseEnforcement(env, nodeFileSystem, "3d", undefined),
    ).toEqual({ kind: "bad-duration" });
    const paused = await pauseEnforcement(
      env,
      nodeFileSystem,
      "30m",
      "daemon upgrade",
    );
    expect(paused.kind).toBe("paused");
    expect(await currentPause(env, nodeFileSystem)).toMatchObject({
      until: "2026-10-04T10:30:00.000Z",
    });
    const later: Environment = {
      ...env,
      now: () => new Date(NOW.getTime() + 31 * 60_000),
    };
    expect(await currentPause(later, nodeFileSystem)).toBeUndefined();
    const resumed = await resumeEnforcement(env, nodeFileSystem);
    expect(resumed).toEqual({
      kind: "resumed",
      wasPausedUntil: "2026-10-04T10:30:00.000Z",
    });
    expect(await resumeEnforcement(env, nodeFileSystem)).toEqual({
      kind: "not-paused",
    });
    const audit = await readFile(
      join(root, "reflex-home", "audit.jsonl"),
      "utf8",
    );
    expect(
      audit
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { kind: string }).kind),
    ).toEqual(["pause", "resume"]);
  });
});

describe("RFX-055 doctor", () => {
  const noDaemon = () =>
    Promise.resolve({ running: false, socketPath: "/nowhere" });

  it("fails with a remediation where nothing is installed", async () => {
    const report = await runDoctor(env, nodeFileSystem, noDaemon);
    expect(report.failures).toBeGreaterThan(0);
    const failing = report.checks.filter((entry) => entry.outcome === "fail");
    expect(failing.every((entry) => entry.remediation !== undefined)).toBe(
      true,
    );
    expect(renderDoctor(report)).toContain('Run "rfx init" here.');
  });

  it("passes on a healthy install and names each thing it checked", async () => {
    await install();
    const report = await runDoctor(env, nodeFileSystem, noDaemon);
    expect(report.failures).toBe(0);
    expect(report.checks.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "this project",
        "claude-code hooks",
        "daemon",
        "user policy",
        "project policy",
        "provider",
      ]),
    );
  });

  // Every failure says what to do: a hook removed behind REFLEX's back, a
  // policy that does not load, a provider without consent, a paused install.
  it("names a remediation for every failure it can find", async () => {
    await install();
    const settings = join(env.projectDir, ".claude", "settings.local.json");
    await writeFile(settings, '{"model": "opus"}\n');
    await writeFile(
      join(env.projectDir, ".reflex", "policy.yaml"),
      "version: 1\nrules: [\n",
    );
    await writeFile(
      join(root, "reflex-home", "config.json"),
      JSON.stringify({ version: 1, semanticProvider: "jev" }),
    );
    await pauseEnforcement(env, nodeFileSystem, "10m", undefined);
    const report = await runDoctor(env, nodeFileSystem, noDaemon);
    const byName = Object.fromEntries(
      report.checks.map((entry) => [entry.name, entry]),
    );
    expect(byName["claude-code hooks"]).toMatchObject({ outcome: "fail" });
    expect(byName["project policy"]).toMatchObject({ outcome: "fail" });
    expect(byName.provider).toMatchObject({ outcome: "warn" });
    expect(byName.pause).toMatchObject({ outcome: "warn" });
    for (const entry of report.checks) {
      if (entry.outcome === "fail" || entry.outcome === "warn") {
        expect(entry.remediation, entry.name).toBeTruthy();
      }
    }
  });
});
