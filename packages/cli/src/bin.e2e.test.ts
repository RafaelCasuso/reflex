import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { consentDigest, consentRecord } from "@reflex/semantic-provider";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The real `rfx` binary, run as the host runs it: a new process, a payload on
 * stdin. This is where the Observe guarantee is checked for real (RFX-086):
 * the hook never changes what the host does.
 *
 * To Claude Code, a hook speaks through three channels: stdout (JSON there can
 * be a permission decision), stderr (shown to the user or fed to the model)
 * and the exit code (2 blocks the call). An observer uses none of them.
 */
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const FIXTURES = fileURLToPath(
  new URL(
    "../../adapter-claude-code/fixtures/claude-code-2.1/",
    import.meta.url,
  ),
);

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function rfx(
  args: readonly string[],
  options: {
    stdin?: string | Buffer;
    env?: Record<string, string>;
    cwd?: string;
  },
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
  });
}

const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.json`), "utf8");

const CODEX_FIXTURES = fileURLToPath(
  new URL("../../adapter-codex/fixtures/codex-hooks-doc/", import.meta.url),
);
/** A documented Codex payload, addressed to a project of the test's choosing. */
const codexFixture = (name: string, cwd: string): string =>
  JSON.stringify({
    ...(JSON.parse(
      readFileSync(join(CODEX_FIXTURES, `${name}.json`), "utf8"),
    ) as Record<string, unknown>),
    cwd,
  });

let root: string;
let reflexHome: string;

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(
      `${BIN} does not exist. Run "pnpm build" first (turbo does this for "pnpm test").`,
    );
  }
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-e2e-"));
  reflexHome = join(root, "reflex-home");
});

afterEach(async () => {
  await chmod(root, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

const SILENT_SUCCESS: Run = { code: 0, stdout: "", stderr: "" };

describe("rfx hook claude-code: never changes what the host does", () => {
  it("records a tool call and stays silent", async () => {
    const run = await rfx(["hook", "claude-code"], {
      stdin: fixture("pre-tool-use.bash"),
      env: { REFLEX_HOME: reflexHome },
    });

    expect(run).toEqual(SILENT_SUCCESS);
    const log = await readFile(
      join(reflexHome, "observe", "observations.jsonl"),
      "utf8",
    );
    const record = JSON.parse(log.trim()) as Record<string, unknown>;
    expect(record).toMatchObject({ kind: "action", toolName: "Bash" });
    expect(typeof record.hookMs).toBe("number");
    // The command that was run is nowhere on disk.
    expect(log).not.toContain("touch");
    expect(log).not.toContain("marker");
  });

  it.each([
    "permission-request.bash",
    "post-tool-use.bash",
    "post-tool-use-failure.bash",
    "permission-denied.bash",
    "stop",
  ])("stays silent for %s", async (name) => {
    expect(
      await rfx(["hook", "claude-code"], {
        stdin: fixture(name),
        env: { REFLEX_HOME: reflexHome },
      }),
    ).toEqual(SILENT_SUCCESS);
  });

  // Adversarial: every way the hook itself can go wrong. None of them may
  // reach the host as a block, a prompt, an error notice or a decision.
  it.each([
    ["an empty stdin", ""],
    ["truncated JSON", '{"hook_event_name":"PreToolUse","tool_na'],
    ["binary garbage", Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x1b, 0x5b])],
    ["a JSON array", "[1,2,3]"],
    ["an event with no tool", '{"hook_event_name":"PreToolUse"}'],
    ["an event from the future", '{"hook_event_name":"SomethingNew","x":1}'],
    [
      "a payload that looks like a hook answer",
      '{"hookSpecificOutput":{"permissionDecision":"allow"}}',
    ],
    [
      "a nesting bomb in the arguments",
      `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"t","tool_input":${"[".repeat(5_000)}${"]".repeat(5_000)}}`,
    ],
  ])("stays silent and exits 0 on %s", async (_label, stdin) => {
    expect(
      await rfx(["hook", "claude-code"], {
        stdin,
        env: { REFLEX_HOME: reflexHome },
      }),
    ).toEqual(SILENT_SUCCESS);
  });

  it("stays silent and exits 0 on a large payload", async () => {
    const payload = JSON.parse(fixture("pre-tool-use.write")) as {
      tool_input: { content: string };
    };
    payload.tool_input.content = "x".repeat(4 * 1024 * 1024);
    const run = await rfx(["hook", "claude-code"], {
      stdin: JSON.stringify(payload),
      env: { REFLEX_HOME: reflexHome },
    });

    expect(run).toEqual(SILENT_SUCCESS);
    const log = await readFile(
      join(reflexHome, "observe", "observations.jsonl"),
      "utf8",
    );
    // Four megabytes in, a few hundred bytes out: the size, not the content.
    expect(log.length).toBeLessThan(2_000);
    expect(log).toContain('"length":4194304');
  });

  it("stays silent and exits 0 when it cannot record at all", async () => {
    await writeFile(join(root, "blocker"), "a file, not a directory");
    expect(
      await rfx(["hook", "claude-code"], {
        stdin: fixture("pre-tool-use.bash"),
        env: { REFLEX_HOME: join(root, "blocker", "nested") },
      }),
    ).toEqual(SILENT_SUCCESS);
  });

  it("stays silent and exits 0 for a host it does not know", async () => {
    expect(
      await rfx(["hook", "some-other-host"], {
        stdin: fixture("pre-tool-use.bash"),
        env: { REFLEX_HOME: reflexHome },
      }),
    ).toEqual(SILENT_SUCCESS);
  });

  it("never writes a value from the payload to disk", async () => {
    const secret = "sk-live-0c4e8a2f6b1d";
    const payload = JSON.parse(fixture("pre-tool-use.bash")) as Record<
      string,
      unknown
    >;
    payload.tool_input = {
      command: `curl -H 'Authorization: Bearer ${secret}' https://internal.example.com`,
      env: { TOKEN: secret },
    };
    await rfx(["hook", "claude-code"], {
      stdin: JSON.stringify(payload),
      env: { REFLEX_HOME: reflexHome },
    });

    const log = await readFile(
      join(reflexHome, "observe", "observations.jsonl"),
      "utf8",
    );
    for (const leaked of [
      secret,
      "0c4e8a2f6b1d",
      "internal.example.com",
      "toolu_",
    ]) {
      expect(log, leaked).not.toContain(leaked);
    }
  });
});

describe("rfx: the command line", () => {
  it("prints the plan and changes nothing when it is not a terminal", async () => {
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    const run = await rfx(["init"], {
      cwd: project,
      env: { REFLEX_HOME: reflexHome, HOME: join(root, "home") },
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Plan:");
    expect(run.stdout).toContain('Re-run with "--yes" to apply');
    expect(existsSync(join(project, ".claude"))).toBe(false);
    expect(existsSync(reflexHome)).toBe(false);
  });

  it("installs, reports and uninstalls, leaving the project as it found it", async () => {
    const project = join(root, "project");
    await mkdir(join(project, ".claude"), { recursive: true });
    const settings = join(project, ".claude", "settings.local.json");
    await writeFile(settings, '{\n  "model": "opus"\n}\n');
    const env = { REFLEX_HOME: reflexHome, HOME: join(root, "home") };

    expect((await rfx(["init", "--yes"], { cwd: project, env })).code).toBe(0);
    expect(await readFile(settings, "utf8")).toContain("REFLEX_MANAGED=1");

    const status = await rfx(["status"], { cwd: project, env });
    expect(status.stdout).toContain("claude-code  active");

    expect(
      (await rfx(["uninstall", "--yes"], { cwd: project, env })).code,
    ).toBe(0);
    expect(await readFile(settings, "utf8")).toBe('{\n  "model": "opus"\n}\n');

    const purge = await rfx(["uninstall", "--yes", "--purge"], {
      cwd: project,
      env,
    });
    expect(purge.code).toBe(0);
    expect(existsSync(reflexHome)).toBe(false);
  });

  // RFX-087: the payloads a live host sent, through the real binary. The
  // permission event names no call, and the prompt must still be counted.
  it("counts a prompt the host did not tie to a call", async () => {
    await mkdir(join(root, "project", ".claude"), { recursive: true });
    // Resolved, as the host reports it and as the CLI sees its own cwd.
    const project = await realpath(join(root, "project"));
    const env = { REFLEX_HOME: reflexHome, HOME: join(root, "home") };
    expect((await rfx(["init", "--yes"], { cwd: project, env })).code).toBe(0);
    const inProject = (name: string): string =>
      JSON.stringify({
        ...(JSON.parse(fixture(name)) as Record<string, unknown>),
        cwd: project,
      });
    expect(fixture("permission-request.bash")).not.toContain("tool_use_id");

    for (const name of [
      "pre-tool-use.bash",
      "permission-request.bash",
      "post-tool-use.bash",
      "pre-tool-use.bash-failing",
      "post-tool-use-failure.bash",
      "stop",
    ]) {
      expect(
        await rfx(["hook", "claude-code"], { stdin: inProject(name), env }),
      ).toEqual(SILENT_SUCCESS);
    }

    const status = await rfx(["status"], { cwd: project, env });
    expect(status.code).toBe(0);
    const summary = status.stdout.replace(/[ ]+/g, " ");
    expect(summary).toContain("2 actions");
    expect(summary).toContain("ran without a prompt 1");
    expect(summary).toContain("prompted 1 (approved 1, rejected 0)");
    expect(summary).toContain("not yet known 0");
  });

  it("rejects an unknown scope and an unknown command", async () => {
    expect((await rfx(["init", "--scope", "everywhere"], {})).code).toBe(2);
    expect((await rfx(["frobnicate"], {})).code).toBe(2);
  });
});

/**
 * RFX-043, RFX-045, RFX-046 — the hook with a decision: Observe answers
 * nothing; Assist allows what a rule allows and hands the rest to the
 * host's own approval, never blocking; Autopilot blocks what is denied;
 * and when the daemon cannot be started the client answers by itself,
 * inside the host's timeout. The real binary, the real daemon, in a
 * temporary REFLEX home.
 */
const POLICY_FOR_FIXTURES = `version: 1
defaults:
  unresolved: ask
rules:
  - id: allow-touch
    name: Allow touch
    effect: allow
    conditions:
      - { field: command.name, operator: equals, value: touch }
  - id: deny-rm
    name: Deny rm
    effect: deny
    conditions:
      - { field: command.name, operator: equals, value: rm }
`;

async function installedIn(
  home: string,
  mode: "observe" | "assist" | "autopilot",
  failureMode: "fail-open" | "fail-ask" | "fail-closed" = "fail-ask",
): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, "installs.json"),
    JSON.stringify({
      version: 1,
      installs: [
        {
          host: "claude-code",
          scope: "local",
          settingsPath: "/work/project/.claude/settings.local.json",
          projectDir: "/work/project",
          projectId: "prj_00000000000000000000000000000001",
          manifestPath: join(home, "backups", "manifest.json"),
          installedAt: "2026-09-27T10:00:00.000Z",
          mode,
          failureMode,
        },
      ],
      projects: [],
    }),
  );
  await writeFile(join(home, "policy.yaml"), POLICY_FOR_FIXTURES);
}

const answerOf = (run: Run): unknown =>
  run.stdout === "" ? undefined : JSON.parse(run.stdout.trim());

describe("the hook with a decision (RFX-043)", () => {
  let decisionHome: string;

  beforeEach(() => {
    decisionHome = join(root, "decision-home");
  });

  afterEach(async () => {
    const { stopDaemon } = await import("./daemon/lifecycle.js");
    await stopDaemon(decisionHome, { graceMs: 2_000 });
  });

  it("in Observe answers nothing, whatever the policy says (RFX-045)", async () => {
    await installedIn(decisionHome, "observe");
    for (const name of ["pre-tool-use.bash", "pre-tool-use.bash-remove"]) {
      expect(
        await rfx(["hook", "claude-code"], {
          stdin: fixture(name),
          env: { REFLEX_HOME: decisionHome },
        }),
      ).toEqual(SILENT_SUCCESS);
    }
  });

  it("in Assist allows what a rule allows, and answers within the budget from a cold daemon", async () => {
    await installedIn(decisionHome, "assist");
    const started = Date.now();
    const run = await rfx(["hook", "claude-code"], {
      stdin: fixture("pre-tool-use.bash"),
      env: { REFLEX_HOME: decisionHome },
    });
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(answerOf(run)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "REFLEX: allowed by rule allow-touch",
      },
    });
    // The observation is still recorded.
    const log = await readFile(
      join(decisionHome, "observe", "observations.jsonl"),
      "utf8",
    );
    expect(log).toContain('"toolName":"Bash"');
    expect(log).not.toContain("marker");
  });

  it("in Assist an unsafe action reaches the host's own approval, never a block (RFX-046)", async () => {
    await installedIn(decisionHome, "assist");
    const denied = await rfx(["hook", "claude-code"], {
      stdin: fixture("pre-tool-use.bash-remove"),
      env: { REFLEX_HOME: decisionHome },
    });
    expect(answerOf(denied)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason:
          "REFLEX: needs your approval, rule deny-rm (destructive)",
      },
    });
    // Unresolved: the policy default asks, and so does the answer.
    const open = await rfx(["hook", "claude-code"], {
      stdin: fixture("pre-tool-use.write"),
      env: { REFLEX_HOME: decisionHome },
    });
    expect(
      (answerOf(open) as { hookSpecificOutput: { permissionDecision: string } })
        .hookSpecificOutput.permissionDecision,
    ).toBe("ask");
  });

  it("in Autopilot blocks what a rule denies", async () => {
    await installedIn(decisionHome, "autopilot");
    const run = await rfx(["hook", "claude-code"], {
      stdin: fixture("pre-tool-use.bash-remove"),
      env: { REFLEX_HOME: decisionHome },
    });
    expect(run.code).toBe(0);
    const answer = answerOf(run) as {
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    expect(answer).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
    expect(answer.hookSpecificOutput.permissionDecisionReason).toMatch(
      /^REFLEX: denied by rule deny-rm \(destructive\)\. To let it through once, a human runs: rfx override dec_[0-9a-f]{32}$/,
    );
  });

  // RFX-125: the way out of a deny, by a human, once.
  it("lets a denied action through once after rfx override, and denies it again after", async () => {
    await installedIn(decisionHome, "autopilot");
    // Each retry is a new tool call of the host: a new tool_use_id, the same
    // command. With the same id the daemon would replay its first answer
    // (RFX-120), which is what idempotency is for.
    let call = 0;
    const hook = () => {
      call += 1;
      const payload = JSON.parse(fixture("pre-tool-use.bash-remove")) as Record<
        string,
        unknown
      >;
      payload.tool_use_id = `toolu_override_${String(call)}`;
      return rfx(["hook", "claude-code"], {
        stdin: JSON.stringify(payload),
        env: { REFLEX_HOME: decisionHome },
      });
    };
    const reasonOf = (run: Run): string =>
      (
        answerOf(run) as {
          hookSpecificOutput: { permissionDecisionReason: string };
        }
      ).hookSpecificOutput.permissionDecisionReason;
    const denied = await hook();
    const id = /rfx override (dec_[0-9a-f]{32})$/.exec(reasonOf(denied))?.[1];
    expect(id).toBeDefined();

    const overridden = await rfx(["override", id ?? ""], {
      env: { REFLEX_HOME: decisionHome },
    });
    expect(overridden.code).toBe(0);
    expect(overridden.stdout).toContain(`Override recorded for ${id ?? ""}`);

    const allowed = await hook();
    expect(answerOf(allowed)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "allow",
        permissionDecisionReason:
          "REFLEX: allowed by human override (destructive)",
      },
    });
    const again = await hook();
    expect(reasonOf(again)).toMatch(/^REFLEX: denied by rule deny-rm/);

    // Twice for the same decision, an unknown one, and a bad id.
    const twice = await rfx(["override", id ?? ""], {
      env: { REFLEX_HOME: decisionHome },
    });
    expect(twice.code).toBe(1);
    expect(twice.stdout).toContain("Not overridden");
    const unknown = await rfx(
      ["override", "dec_00000000000000000000000000000099"],
      { env: { REFLEX_HOME: decisionHome } },
    );
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toContain("does not remember that decision");
    const bad = await rfx(["override", "nope"], {
      env: { REFLEX_HOME: decisionHome },
    });
    expect(bad.code).toBe(2);
  }, 30_000);

  it("keeps observing the other events silently in every mode", async () => {
    await installedIn(decisionHome, "autopilot");
    for (const name of [
      "post-tool-use.bash",
      "permission-request.bash",
      "stop",
    ]) {
      expect(
        await rfx(["hook", "claude-code"], {
          stdin: fixture(name),
          env: { REFLEX_HOME: decisionHome },
        }),
      ).toEqual(SILENT_SUCCESS);
    }
  });

  // Adversarial: the daemon cannot start (it is asked for a provider it
  // cannot build), so the client must answer on its own, in time, as the
  // failure mode says. Never silence: silence would let the host run it.
  it("answers by itself, in time, when the daemon cannot be started", async () => {
    await installedIn(decisionHome, "autopilot", "fail-closed");
    await writeFile(
      join(decisionHome, "config.json"),
      JSON.stringify({ version: 1, semanticProvider: "jev" }),
    );
    // RFX-123: with consent, jev is passed to the daemon, which then cannot
    // build it without a key. Without consent see "keeps deciding with
    // policy alone" below: the daemon starts, with no provider.
    await writeFile(
      join(decisionHome, "consent.json"),
      JSON.stringify(consentRecord("jev", new Date())),
    );
    const started = Date.now();
    const run = await rfx(["hook", "claude-code"], {
      stdin: fixture("pre-tool-use.bash"),
      env: { REFLEX_HOME: decisionHome, TYPESAFE_API_KEY: "" },
    });
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(answerOf(run)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "REFLEX: the local daemon could not be started or reached; blocked as configured (fail-closed)",
      },
    });
    const assist = await rfx(["hook", "claude-code"], {
      stdin: fixture("pre-tool-use.bash"),
      env: { REFLEX_HOME: decisionHome, TYPESAFE_API_KEY: "" },
    });
    // Under Autopilot with fail-ask (the registry says fail-closed here): the
    // same daemon, the same answer, still deny. Switch the registry to see ask.
    expect(
      (
        answerOf(assist) as {
          hookSpecificOutput: { permissionDecision: string };
        }
      ).hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  }, 20_000);

  // RFX-123, adversarial: config.json names jev and nobody agreed (edited by
  // hand, or by the agent). The daemon starts with policy alone, decides,
  // and the request never carries a provider flag: nothing leaves.
  it("keeps deciding with policy alone when a remote provider is configured without consent", async () => {
    await installedIn(decisionHome, "assist");
    await writeFile(
      join(decisionHome, "config.json"),
      JSON.stringify({ version: 1, semanticProvider: "jev" }),
    );
    const run = await rfx(["hook", "claude-code"], {
      stdin: fixture("pre-tool-use.bash"),
      env: { REFLEX_HOME: decisionHome, TYPESAFE_API_KEY: "" },
    });
    expect(run.code).toBe(0);
    expect(answerOf(run)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "REFLEX: allowed by rule allow-touch",
      },
    });
    const { daemonPaths, probeDaemon } = await import("./daemon/lifecycle.js");
    const probe = await probeDaemon(daemonPaths(decisionHome));
    expect(probe.state).toBe("running");
    if (probe.state === "running") {
      expect(probe.health.raw).toMatchObject({
        semanticProvider: { id: "none" },
      });
    }
    const shown = await rfx(["provider"], {
      env: { REFLEX_HOME: decisionHome },
    });
    expect(shown.stdout).toContain("jev configured without consent");
  }, 20_000);
});

describe("rfx provider (RFX-123)", () => {
  let home: string;

  beforeEach(() => {
    home = join(root, "provider-home");
  });

  it("shows none by default and refuses an unknown provider", async () => {
    const shown = await rfx(["provider"], { env: { REFLEX_HOME: home } });
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("provider: none");
    expect(shown.stdout).toContain("nothing leaves this machine");
    const unknown = await rfx(["provider", "reflex"], {
      env: { REFLEX_HOME: home },
    });
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toContain("Unknown provider");
  });

  it("shows the statement and writes nothing without a yes", async () => {
    const run = await rfx(["provider", "jev"], { env: { REFLEX_HOME: home } });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("What is sent, per action:");
    expect(run.stdout).toContain("What is redacted first, on this machine:");
    expect(run.stdout).toContain("api.typesafe.ai");
    expect(run.stdout).toContain('Re-run with "--consent"');
    expect(existsSync(join(home, "config.json"))).toBe(false);
    expect(existsSync(join(home, "consent.json"))).toBe(false);
  });

  it("records the consent with --consent, and withdraws it with none", async () => {
    const agreed = await rfx(["provider", "jev", "--consent"], {
      env: { REFLEX_HOME: home },
    });
    expect(agreed.code).toBe(0);
    expect(agreed.stdout).toContain("provider: jev, consent given");
    const consent = JSON.parse(
      await readFile(join(home, "consent.json"), "utf8"),
    ) as { provider: string; statementDigest: string };
    expect(consent.provider).toBe("jev");
    expect(consent.statementDigest).toBe(consentDigest("jev"));
    expect(
      JSON.parse(await readFile(join(home, "config.json"), "utf8")),
    ).toEqual({ version: 1, semanticProvider: "jev" });

    const withdrawn = await rfx(["provider", "none"], {
      env: { REFLEX_HOME: home },
    });
    expect(withdrawn.code).toBe(0);
    expect(withdrawn.stdout).toContain("provider: none");
    expect(existsSync(join(home, "consent.json"))).toBe(false);
  });

  it("pins the local provider to its checkpoint", async () => {
    const unpinned = await rfx(["provider", "local"], {
      env: { REFLEX_HOME: home },
    });
    expect(unpinned.code).toBe(2);
    expect(unpinned.stdout).toContain("--model");
    const pinned = await rfx(["provider", "local", "--model", "rdm-0.1.0"], {
      env: { REFLEX_HOME: home },
    });
    expect(pinned.code).toBe(0);
    expect(pinned.stdout).toContain("provider: local, model rdm-0.1.0");
    expect(existsSync(join(home, "consent.json"))).toBe(false);
  });
});

/**
 * G8 — the Codex hook, against the real binary and the real daemon. Its
 * payloads are the documented ones (`adapter-codex/fixtures`): nothing here
 * was captured from a live Codex yet, and `docs/codex-hook.md` says so.
 */
describe("rfx hook codex (RFX-048, RFX-049, RFX-051, RFX-093)", () => {
  let home: string;
  const PROJECT = "/work/project";

  beforeEach(() => {
    home = join(root, "codex-home");
  });

  afterEach(async () => {
    const { stopDaemon } = await import("./daemon/lifecycle.js");
    await stopDaemon(home).catch(() => undefined);
  });

  async function codexInstalledIn(
    mode: "observe" | "assist" | "autopilot",
    failureMode: "fail-open" | "fail-ask" | "fail-closed" = "fail-ask",
  ): Promise<void> {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, "installs.json"),
      JSON.stringify({
        version: 1,
        installs: [
          {
            host: "codex",
            scope: "user",
            settingsPath: join(root, "home", ".codex", "hooks.json"),
            projectDir: PROJECT,
            projectId: "prj_00000000000000000000000000000002",
            manifestPath: join(home, "backups", "manifest.json"),
            installedAt: "2026-09-27T10:00:00.000Z",
            mode,
            failureMode,
          },
        ],
        projects: [],
      }),
    );
    await writeFile(join(home, "policy.yaml"), POLICY_FOR_FIXTURES);
  }

  const hook = (name: string, cwd = PROJECT) =>
    rfx(["hook", "codex"], {
      stdin: codexFixture(name, cwd),
      env: { REFLEX_HOME: home },
    });

  it("in Observe records the documented events silently, and outcomes come out of them", async () => {
    await codexInstalledIn("observe");
    for (const name of [
      "pre-tool-use.bash",
      "permission-request.bash",
      "post-tool-use.bash",
      "pre-tool-use.apply-patch",
      "pre-tool-use.mcp",
      "stop",
      "session-start",
    ]) {
      expect(await hook(name), name).toEqual(SILENT_SUCCESS);
    }
    const log = await readFile(
      join(home, "observe", "observations.jsonl"),
      "utf8",
    );
    expect(log).toContain('"host":"codex"');
    expect(log).not.toContain("marker.txt");
    expect(log).not.toContain("src/app.ts");
    const { assembleOutcomes } = await import("@reflex/telemetry");
    const records = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as never);
    const outcomes = assembleOutcomes(records);
    expect(outcomes[0]).toMatchObject({
      prompted: "yes",
      executed: "yes",
      humanResponse: "approved",
    });
    expect(outcomes[1]).toMatchObject({
      prompted: "unknown",
      executed: "unknown",
    });
  });

  // RFX-050: the user-scoped hook fires everywhere and keeps to installed projects.
  it("records nothing for a project REFLEX was not installed in", async () => {
    await codexInstalledIn("autopilot");
    expect(await hook("pre-tool-use.bash-remove", "/somewhere/else")).toEqual(
      SILENT_SUCCESS,
    );
    expect(existsSync(join(home, "observe", "observations.jsonl"))).toBe(false);
    // A subdirectory of the project is the project.
    expect(await hook("pre-tool-use.bash", `${PROJECT}/src`)).toMatchObject({
      code: 0,
      stderr: "",
    });
  });

  it("in Assist allows on PermissionRequest, asks on PreToolUse, and never denies", async () => {
    await codexInstalledIn("assist");
    // Allowed by rule: PreToolUse says nothing (Codex proceeds on its own),
    // PermissionRequest approves, so the prompt is eliminated.
    expect(await hook("pre-tool-use.bash")).toEqual(SILENT_SUCCESS);
    expect(answerOf(await hook("permission-request.bash"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    // Denied by rule: in Assist that is ask. PreToolUse asks with the
    // documented value; PermissionRequest abstains so the native prompt goes on.
    const asked = answerOf(await hook("pre-tool-use.bash-remove")) as {
      hookSpecificOutput: {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(asked.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(asked.hookSpecificOutput.permissionDecisionReason).toMatch(
      /^REFLEX: needs your approval, rule deny-rm \(destructive\)$/,
    );
    const request = JSON.parse(
      codexFixture("permission-request.bash", PROJECT),
    ) as Record<string, unknown>;
    request.tool_input = { command: "rm -rf build" };
    expect(
      await rfx(["hook", "codex"], {
        stdin: JSON.stringify(request),
        env: { REFLEX_HOME: home },
      }),
    ).toEqual(SILENT_SUCCESS);
  }, 20_000);

  it("in Autopilot blocks on PreToolUse and denies on PermissionRequest", async () => {
    await codexInstalledIn("autopilot");
    const blocked = answerOf(await hook("pre-tool-use.bash-remove")) as {
      hookSpecificOutput: {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(blocked.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(blocked.hookSpecificOutput.permissionDecisionReason).toMatch(
      /^REFLEX: denied by rule deny-rm \(destructive\)\. To let it through once, a human runs: rfx override dec_[0-9a-f]{32}$/,
    );
    const request = JSON.parse(
      codexFixture("permission-request.bash", PROJECT),
    ) as Record<string, unknown>;
    request.tool_input = { command: "rm -rf build" };
    const denied = answerOf(
      await rfx(["hook", "codex"], {
        stdin: JSON.stringify(request),
        env: { REFLEX_HOME: home },
      }),
    ) as {
      hookSpecificOutput: { decision: { behavior: string; message: string } };
    };
    expect(denied.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(denied.hookSpecificOutput.decision.message).toMatch(
      /^REFLEX: denied by rule deny-rm/,
    );
  }, 20_000);

  // ADR-003 §4 on Codex's two channels: PreToolUse asks (or blocks under
  // fail-closed), PermissionRequest abstains (or denies).
  it("answers by itself when the daemon cannot be started", async () => {
    await codexInstalledIn("autopilot", "fail-closed");
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ version: 1, semanticProvider: "jev" }),
    );
    await writeFile(
      join(home, "consent.json"),
      JSON.stringify(consentRecord("jev", new Date())),
    );
    const env = { REFLEX_HOME: home, TYPESAFE_API_KEY: "" };
    const pre = answerOf(
      await rfx(["hook", "codex"], {
        stdin: codexFixture("pre-tool-use.bash", PROJECT),
        env,
      }),
    ) as { hookSpecificOutput: { permissionDecision: string } };
    expect(pre.hookSpecificOutput.permissionDecision).toBe("deny");
    const request = answerOf(
      await rfx(["hook", "codex"], {
        stdin: codexFixture("permission-request.bash", PROJECT),
        env,
      }),
    ) as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(request.hookSpecificOutput.decision.behavior).toBe("deny");
  }, 20_000);
});

describe("rfx init for Codex, end to end", () => {
  it("installs into the user's Codex files with --host codex, reports, and uninstalls back", async () => {
    const project = join(root, "project");
    const userHome = join(root, "home");
    await mkdir(project, { recursive: true });
    await mkdir(join(userHome, ".codex"), { recursive: true });
    const original = 'model = "gpt-5.3-codex"\n';
    await writeFile(join(userHome, ".codex", "config.toml"), original);
    const env = { REFLEX_HOME: reflexHome, HOME: userHome };
    const init = await rfx(["init", "--host", "codex", "--yes"], {
      cwd: project,
      env,
    });
    expect(init.code).toBe(0);
    expect(init.stdout).toContain("REFLEX will observe Codex");
    expect(init.stdout).toContain("run /hooks");
    expect(
      await readFile(join(userHome, ".codex", "hooks.json"), "utf8"),
    ).toContain("hook codex");
    expect(
      await readFile(join(userHome, ".codex", "config.toml"), "utf8"),
    ).toBe(`${original}\n[features]\nhooks = true\n`);
    const status = await rfx(["status"], { cwd: project, env });
    expect(status.stdout).toContain("codex  active");
    expect(
      (await rfx(["uninstall", "--yes"], { cwd: project, env })).code,
    ).toBe(0);
    expect(existsSync(join(userHome, ".codex", "hooks.json"))).toBe(false);
    expect(
      await readFile(join(userHome, ".codex", "config.toml"), "utf8"),
    ).toBe(original);
    expect(
      (await rfx(["init", "--host", "nope"], { cwd: project, env })).code,
    ).toBe(2);
  });
});

/**
 * G9 — the starter policy, trust, explain, pause and doctor through the
 * real binary and the real daemon (RFX-054, RFX-104, RFX-099, RFX-126,
 * RFX-055).
 */
describe("G9: policy, trust, pause and doctor, end to end", () => {
  const REPO_POLICY = `version: 1
rules:
  - id: repo.allow-touch
    name: The repository allows touch
    effect: allow
    conditions:
      - { field: command.name, operator: equals, value: touch }
  - id: repo.deny-ls
    name: The repository denies ls
    effect: deny
    conditions:
      - { field: command.name, operator: equals, value: ls }
`;

  it("init writes the starter policy, trusts it, and never overwrites a file the user has", async () => {
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    const env = { REFLEX_HOME: reflexHome, HOME: join(root, "home") };
    const init = await rfx(["init", "--host", "claude-code", "--yes"], {
      cwd: project,
      env,
    });
    expect(init.code).toBe(0);
    expect(init.stdout).toContain("a conservative starter policy");
    const policy = await readFile(
      join(project, ".reflex", "policy.yaml"),
      "utf8",
    );
    expect(policy).toContain("starter.allow-reads");
    const status = await rfx(["status"], { cwd: project, env });
    expect(status.stdout).toMatch(/Policy\s+.*policy\.yaml, trusted/);

    await writeFile(join(project, ".reflex", "policy.yaml"), REPO_POLICY);
    expect(
      (
        await rfx(["init", "--host", "claude-code", "--yes"], {
          cwd: project,
          env,
        })
      ).code,
    ).toBe(0);
    expect(
      await readFile(join(project, ".reflex", "policy.yaml"), "utf8"),
    ).toBe(REPO_POLICY);
    const starter = await rfx(["policy", "starter"], { cwd: project, env });
    expect(starter.code).toBe(1);
    expect(starter.stdout).toContain("was not touched");
    expect(
      await readFile(join(project, ".reflex", "policy.yaml"), "utf8"),
    ).toBe(REPO_POLICY);
  });

  // RFX-104 adversarial, through the real daemon: a repository policy the
  // user never trusted. Its deny applies; its allow does not, until
  // `rfx trust`, and not after the file changes.
  it("applies an untrusted project policy's deny and ignores its allow until the user trusts it", async () => {
    const home = join(root, "trust-home");
    const project = await realpath(
      await (async () => {
        const dir = join(root, "home", "work", "repo");
        await mkdir(join(dir, ".reflex"), { recursive: true });
        return dir;
      })(),
    );
    await writeFile(join(project, ".reflex", "policy.yaml"), REPO_POLICY);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, "installs.json"),
      JSON.stringify({
        version: 1,
        installs: [
          {
            host: "claude-code",
            scope: "local",
            settingsPath: join(project, ".claude", "settings.local.json"),
            projectDir: project,
            projectId: "prj_00000000000000000000000000000003",
            manifestPath: join(home, "backups", "manifest.json"),
            installedAt: "2026-10-04T10:00:00.000Z",
            mode: "autopilot",
            failureMode: "fail-ask",
          },
        ],
        projects: [],
      }),
    );
    // A user policy that asks for everything unresolved, so that the
    // project's allow is the only way to an allow.
    await writeFile(
      join(home, "policy.yaml"),
      "version: 1\ndefaults:\n  unresolved: ask\nrules: []\n",
    );
    const env = { REFLEX_HOME: home, HOME: join(root, "home") };
    const inProject = (name: string, toolUseId: string): string =>
      JSON.stringify({
        ...(JSON.parse(fixture(name)) as Record<string, unknown>),
        cwd: project,
        tool_use_id: toolUseId,
      });
    const hook = (name: string, id: string) =>
      rfx(["hook", "claude-code"], { stdin: inProject(name, id), env });
    const decisionOf = (run: Run): string =>
      (answerOf(run) as { hookSpecificOutput: { permissionDecision: string } })
        .hookSpecificOutput.permissionDecision;
    try {
      // touch: the repository allows it, but nobody trusted the repository.
      expect(decisionOf(await hook("pre-tool-use.bash", "toolu_trust_1"))).toBe(
        "ask",
      );
      const explain = await rfx(["explain", "touch", "marker.txt"], {
        cwd: project,
        env,
      });
      expect(explain.stdout).toContain(
        "untrusted: its 1 allow rule(s) are ignored",
      );

      const trusted = await rfx(["trust", "--yes"], { cwd: project, env });
      expect(trusted.code).toBe(0);
      expect(trusted.stdout).toContain("allow  repo.allow-touch");
      expect(decisionOf(await hook("pre-tool-use.bash", "toolu_trust_2"))).toBe(
        "allow",
      );

      // The repository changes its policy: trust is gone with the content.
      await writeFile(
        join(project, ".reflex", "policy.yaml"),
        REPO_POLICY.replace("allows touch", "allows touch, edited"),
      );
      expect(decisionOf(await hook("pre-tool-use.bash", "toolu_trust_3"))).toBe(
        "ask",
      );
      const status = await rfx(["status"], { cwd: project, env });
      expect(status.stdout).toContain("UNTRUSTED");
    } finally {
      const { stopDaemon } = await import("./daemon/lifecycle.js");
      await stopDaemon(home).catch(() => undefined);
    }
  }, 30_000);

  it("pauses enforcement for a bounded time: the hook observes and answers nothing, status says so, resume ends it", async () => {
    const home = join(root, "pause-home");
    await installedIn(home, "autopilot");
    const env = { REFLEX_HOME: home };
    const hook = () =>
      rfx(["hook", "claude-code"], {
        stdin: fixture("pre-tool-use.bash-remove"),
        env,
      });
    try {
      expect(answerOf(await hook())).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect((await rfx(["pause"], { env })).code).toBe(2);
      const paused = await rfx(
        ["pause", "--for", "15m", "--reason", "upgrading"],
        { env },
      );
      expect(paused.code).toBe(0);
      expect(await hook()).toEqual(SILENT_SUCCESS);
      const status = await rfx(["status"], { env, cwd: "/work/project" }).catch(
        () => undefined,
      );
      if (status !== undefined) {
        expect(status.stdout).toContain("PAUSED");
      }
      const observed = await readFile(
        join(home, "observe", "observations.jsonl"),
        "utf8",
      );
      expect(
        observed.split("\n").filter(Boolean).length,
      ).toBeGreaterThanOrEqual(2);
      expect((await rfx(["resume"], { env })).code).toBe(0);
      expect(answerOf(await hook())).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      const audit = await readFile(join(home, "audit.jsonl"), "utf8");
      expect(audit).toContain('"kind":"pause"');
      expect(audit).toContain('"kind":"resume"');
    } finally {
      const { stopDaemon } = await import("./daemon/lifecycle.js");
      await stopDaemon(home).catch(() => undefined);
    }
  }, 30_000);

  it("doctor exits 1 with remediations where nothing is installed, and 0 on a healthy install", async () => {
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    const env = { REFLEX_HOME: reflexHome, HOME: join(root, "home") };
    const sick = await rfx(["doctor"], { cwd: project, env });
    expect(sick.code).toBe(1);
    expect(sick.stdout).toContain("FAIL");
    expect(sick.stdout).toContain('-> Run "rfx init" here.');
    expect(
      (
        await rfx(["init", "--host", "claude-code", "--yes"], {
          cwd: project,
          env,
        })
      ).code,
    ).toBe(0);
    const healthy = await rfx(["doctor"], { cwd: project, env });
    expect(healthy.code).toBe(0);
    expect(healthy.stdout).toContain("claude-code hooks");
    const json = await rfx(["doctor", "--json"], { cwd: project, env });
    expect((JSON.parse(json.stdout) as { failures: number }).failures).toBe(0);
  });
});

describe("rfx mode", () => {
  it("shows, changes and refuses an unknown mode", async () => {
    const home = join(root, "mode-home");
    const project = join(root, "mode-project");
    await mkdir(project, { recursive: true });
    await installedIn(home, "observe");
    // The registry above names /work/project; this project is not installed.
    const notInstalled = await rfx(["mode"], {
      env: { REFLEX_HOME: home },
      cwd: project,
    });
    expect(notInstalled.stdout).toContain("Not installed");
    const unknown = await rfx(["mode", "yolo"], {
      env: { REFLEX_HOME: home },
      cwd: project,
    });
    expect(unknown.code).toBe(2);
  });
});
