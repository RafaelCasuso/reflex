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
