#!/usr/bin/env node
/**
 * RFX-087 — what Claude Code really does when a hook fails.
 *
 * This runs the REAL host. Each case gets its own scratch project with one
 * hook that misbehaves in exactly one way, asks a headless Claude Code session
 * to run one harmless command, and records whether the command ran and which
 * hook events fired.
 *
 * It is NOT part of `pnpm test`: it needs a logged-in Claude Code and spends
 * the maintainer's quota (a few cents with the defaults below). Its recorded
 * output is checked in under live/results/, and `src/live-evidence.test.ts`
 * checks the documentation against that record in CI.
 *
 *   node live/verify-hook-failures.mjs --run                  run every case
 *   node live/verify-hook-failures.mjs --run --only exit-2    run some cases
 *   node live/verify-hook-failures.mjs --run --only exit-2 --merge
 *                                                  ...and update the record
 *   node live/verify-hook-failures.mjs --run --keep           keep the scratch dirs
 *
 * Nothing runs without `--run`: every other invocation, a typo included,
 * prints the usage and spends nothing.
 *
 * Safety: every session is confined to a scratch directory, may only run the
 * one command its case names, loads no user settings and no MCP servers, is
 * not persisted, and has a hard budget cap.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const MODEL = "haiku";
const BUDGET_USD = "0.30";
const SESSION_TIMEOUT_MS = 180_000;
const EVENTS = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "Stop",
];

const TOUCH = {
  prompt:
    "Run exactly this shell command with the Bash tool, one time: touch marker.txt\nThen reply with the single word done. If the command is refused or fails, do not try anything else: reply with the single word refused.",
  allowedTools: "Bash(touch *)",
};

const json = (value) => `printf '%s' '${JSON.stringify(value)}'`;

/**
 * `expectRan`: whether the tool call must have run. `null` means the case
 * exists to find out, and records without asserting.
 */
const CASES = [
  {
    id: "silent-exit-0",
    what: "exits 0 and prints nothing",
    hook: "exit 0",
    expectRan: true,
  },
  {
    id: "exit-1",
    what: "exits 1 with a message on stderr",
    hook: 'echo "test hook: failing with exit 1" >&2; exit 1',
    expectRan: true,
  },
  {
    id: "exit-2",
    what: "exits 2 with a message on stderr",
    hook: 'echo "test hook: blocking with exit 2" >&2; exit 2',
    expectRan: false,
  },
  {
    id: "invalid-json",
    what: "exits 0 and prints invalid JSON",
    hook: "printf '{'; exit 0",
    expectRan: true,
  },
  {
    id: "timeout",
    what: "runs past its configured timeout (2 s)",
    hook: "sleep 20; exit 2",
    hookTimeout: 2,
    expectRan: true,
  },
  {
    id: "missing-command",
    what: "points at a command that does not exist",
    hookCommand: "/nonexistent/reflex-test-hook",
    expectRan: true,
  },
  {
    id: "json-deny",
    what: "exits 0 and answers permissionDecision: deny",
    hook: json({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "denied by the test hook",
      },
    }),
    expectRan: false,
  },
  {
    id: "json-ask-headless",
    what: "exits 0 and answers permissionDecision: ask, with no human to ask",
    hook: json({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "the test hook wants a human",
      },
    }),
    expectRan: null,
  },
  {
    id: "hooks-disabled",
    what: "would block with exit 2, but disableAllHooks is true",
    hook: 'echo "test hook: blocking with exit 2" >&2; exit 2',
    settings: { disableAllHooks: true },
    expectRan: true,
  },
  {
    id: "needs-permission-headless",
    what: "is silent, and the tool is not pre-approved (no human to ask)",
    hook: "exit 0",
    allowedTools: null,
    expectRan: false,
  },
  {
    id: "failing-command",
    what: "is silent, and the command itself exits non-zero",
    hook: "exit 0",
    prompt:
      // A relative path: the host refuses paths outside the project outright,
      // which would test its sandbox instead of a failing command.
      "Run exactly this shell command with the Bash tool, one time: ls rfx087-this-directory-does-not-exist\nThen reply with the single word done. Do not try anything else.",
    allowedTools: "Bash(ls *)",
    expectRan: null,
  },
];

function write(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
}

function prepare(root, testCase) {
  const dir = join(root, testCase.id);
  const dump = join(dir, "hooks", "dump.sh");
  write(
    dump,
    `#!/bin/sh\nmkdir -p '${dir}/payloads'\ncat > '${dir}/payloads/'"$1.$$.json"\nexit 0\n`,
    0o755,
  );
  const misbehaving = join(dir, "hooks", "case.sh");
  write(misbehaving, `#!/bin/sh\n${testCase.hook ?? "exit 0"}\n`, 0o755);

  const observer = (event) => ({
    hooks: [{ type: "command", command: `'${dump}' ${event}`, timeout: 10 }],
  });
  const hooks = Object.fromEntries(
    EVENTS.map((event) => [event, [observer(event)]]),
  );
  hooks.PreToolUse.push({
    matcher: "Bash",
    hooks: [
      {
        type: "command",
        command: testCase.hookCommand ?? `'${misbehaving}'`,
        ...(testCase.hookTimeout === undefined
          ? {}
          : { timeout: testCase.hookTimeout }),
      },
    ],
  });

  write(
    join(dir, ".claude", "settings.json"),
    `${JSON.stringify({ ...testCase.settings, hooks }, null, 2)}\n`,
  );
  return dir;
}

function runSession(dir, testCase) {
  const allowed =
    testCase.allowedTools === undefined
      ? TOUCH.allowedTools
      : testCase.allowedTools;
  const args = [
    "-p",
    testCase.prompt ?? TOUCH.prompt,
    "--model",
    MODEL,
    "--output-format",
    "json",
    "--max-budget-usd",
    BUDGET_USD,
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--no-session-persistence",
    ...(allowed === null ? [] : ["--allowedTools", allowed]),
  ];

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("claude", args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), SESSION_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, seconds: (Date.now() - started) / 1000 });
    });
  });
}

/** Scratch paths and the user's home never reach the checked-in record. */
function sanitizer(dir) {
  // The host reports resolved paths (`/private/var/...` on macOS), so the
  // resolved form is replaced first: it contains the unresolved one.
  const real = realpathSync(dir);
  const replacements = [
    [real, "/work/project"],
    [dirname(real), "/work"],
    [dir, "/work/project"],
    [dirname(dir), "/work"],
    [homedir(), "/home/dev"],
  ];
  return (text) =>
    replacements.reduce((out, [from, to]) => out.replaceAll(from, to), text);
}

function collect(dir, testCase, session) {
  const clean = sanitizer(dir);
  const payloadDir = join(dir, "payloads");
  const files = existsSync(payloadDir) ? readdirSync(payloadDir).sort() : [];
  const events = {};
  const samples = {};
  for (const file of files) {
    const event = file.split(".")[0];
    events[event] = (events[event] ?? 0) + 1;
    if (samples[event] === undefined) {
      try {
        samples[event] = JSON.parse(
          clean(readFileSync(join(payloadDir, file), "utf8")),
        );
      } catch {
        samples[event] = "unparseable";
      }
    }
  }

  let result;
  try {
    result = JSON.parse(session.stdout);
  } catch {
    result = undefined;
  }

  const markerExists = existsSync(join(dir, "marker.txt"));
  const completed =
    (events.PostToolUse ?? 0) + (events.PostToolUseFailure ?? 0);
  const ran = testCase.id === "failing-command" ? completed > 0 : markerExists;

  return {
    id: testCase.id,
    recordedAt: new Date().toISOString(),
    hook: testCase.what,
    expectRan: testCase.expectRan,
    ran,
    markerExists,
    matchesExpectation:
      testCase.expectRan === null ? null : ran === testCase.expectRan,
    events,
    session: {
      exitCode: session.code,
      seconds: Math.round(session.seconds * 10) / 10,
      isError: result?.is_error ?? null,
      subtype: result?.subtype ?? null,
      turns: result?.num_turns ?? null,
      costUsd: result?.total_cost_usd ?? null,
      reply:
        typeof result?.result === "string"
          ? clean(result.result).slice(0, 300)
          : null,
      permissionDenials: Array.isArray(result?.permission_denials)
        ? result.permission_denials.map((denial) => denial.tool_name)
        : null,
      stderr: clean(session.stderr).slice(0, 300) || null,
    },
    samples,
  };
}

const say = (text) => process.stdout.write(`${text}\n`);

const USAGE = `RFX-087: runs the real Claude Code host. Spends the logged-in account's quota.

  --run            required: without it nothing runs and nothing is spent
  --only a,b       run only these cases and print them, leaving the record alone
  --merge          with --only: replace just those cases in the record
  --keep           keep the scratch directories

cases: ${CASES.map((c) => c.id).join(", ")}`;

/** Strict: a flag this does not know must never start a paid run. */
function parseArguments(argv) {
  const options = { run: false, keep: false, merge: false, only: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--run" || flag === "--keep" || flag === "--merge") {
      options[flag.slice(2)] = true;
    } else if (flag === "--only") {
      index += 1;
      const ids = (argv[index] ?? "").split(",").filter((id) => id !== "");
      const unknown = ids.filter((id) => !CASES.some((c) => c.id === id));
      if (ids.length === 0 || unknown.length > 0) {
        return {
          error: `--only needs known case ids, got: ${argv[index] ?? ""}`,
        };
      }
      options.only = ids;
    } else {
      return {
        error: flag === "--help" ? undefined : `unknown argument: ${flag}`,
      };
    }
  }
  if (options.merge && options.only === undefined) {
    return { error: "--merge only makes sense with --only" };
  }
  return options.run ? { options } : { error: undefined };
}

const parsed = parseArguments(process.argv.slice(2));
if (parsed.options === undefined) {
  say(parsed.error === undefined ? USAGE : `${parsed.error}\n\n${USAGE}`);
  process.exit(parsed.error === undefined ? 0 : 2);
}
const { only, keep, merge } = parsed.options;

const hostVersion = execFileSync("claude", ["--version"], {
  encoding: "utf8",
}).trim();
const root = mkdtempSync(join(tmpdir(), "reflex-rfx087-"));
const selected = CASES.filter((c) => only === undefined || only.includes(c.id));

say(`host: ${hostVersion}   model: ${MODEL}   budget per run: $${BUDGET_USD}`);
say(`scratch: ${root}\n`);

const results = [];
for (const testCase of selected) {
  const dir = prepare(root, testCase);
  const session = await runSession(dir, testCase);
  const outcome = collect(dir, testCase, session);
  results.push(outcome);
  const verdict =
    outcome.matchesExpectation === null
      ? "recorded"
      : outcome.matchesExpectation
        ? "as expected"
        : "UNEXPECTED";
  say(
    `${outcome.id.padEnd(28)} ran=${String(outcome.ran).padEnd(5)} ${verdict.padEnd(12)} events=${JSON.stringify(outcome.events)} $${String(outcome.session.costUsd ?? "?")} ${String(outcome.session.seconds)}s`,
  );
}

const version = /\d+\.\d+\.\d+/.exec(hostVersion)?.[0] ?? "unknown";
const recordPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "results",
  `claude-code-${version}.json`,
);

// `--only` alone prints and leaves the record alone. `--merge` replaces just
// the cases that were re-run, so one bad case does not cost a whole new batch.
const previous =
  merge && existsSync(recordPath)
    ? JSON.parse(readFileSync(recordPath, "utf8")).results
    : [];
const rerun = new Set(results.map((result) => result.id));
const merged = CASES.map(
  (testCase) =>
    results.find((result) => result.id === testCase.id) ??
    previous.find(
      (result) => result.id === testCase.id && !rerun.has(result.id),
    ),
).filter((result) => result !== undefined);

const record = {
  ticket: "RFX-087",
  host: hostVersion,
  model: MODEL,
  totalCostUsd:
    Math.round(
      merged.reduce((sum, r) => sum + (r.session.costUsd ?? 0), 0) * 10_000,
    ) / 10_000,
  results: merged,
};

if (only === undefined || merge) {
  write(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  say(`\nrecorded: ${recordPath} (${String(merged.length)} cases)`);
} else {
  say(`\n${JSON.stringify({ ...record, results }, null, 2)}`);
}
say(`total cost: $${String(record.totalCostUsd)}`);

if (!keep) {
  rmSync(root, { recursive: true, force: true });
}
process.exitCode = results.some((r) => r.matchesExpectation === false) ? 1 : 0;
