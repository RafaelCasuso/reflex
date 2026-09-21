#!/usr/bin/env node
/**
 * RFX-089 — what Claude Code really sends for file edits, a fetch and an MCP
 * call.
 *
 * ADR-001 was accepted before a single real payload had been seen, and the
 * fixtures for `Write`, `Edit` and an MCP tool were built from documentation.
 * This runs the REAL host once per tool, in a scratch project whose only hook
 * writes down what it is given, and records the payloads. `Bash` was captured
 * by `verify-hook-failures.mjs` (RFX-087).
 *
 * It is NOT part of `pnpm test`: it needs a logged-in Claude Code and spends
 * that account's quota (a few cents a case). Its output is checked in under
 * live/payloads/, and `src/live-payloads.test.ts` holds the adapter and
 * docs/canonical-action-review.md to that record in CI.
 *
 *   node live/capture-tool-payloads.mjs                     usage, runs nothing
 *   node live/capture-tool-payloads.mjs --run               every case, rewrites the record
 *   node live/capture-tool-payloads.mjs --run --only mcp    some cases, printed and not recorded
 *   node live/capture-tool-payloads.mjs --run --keep        keep the scratch directories
 *
 * Nothing runs without `--run`: every other invocation, a typo included,
 * prints the usage and spends nothing.
 *
 * Safety: every session is confined to a scratch directory, may use only the
 * tools its case names, loads no user settings and no MCP server but the one
 * written here, is not persisted, and has a hard budget cap. The MCP server is
 * forty lines of this file, has one tool, and that tool appends a line to a
 * file in the scratch directory.
 *
 * It shares no code with `verify-hook-failures.mjs` on purpose. Each script
 * spends money, and each can be read from top to bottom without the other.
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

const ONLY_THEN_DONE =
  "Do exactly that and nothing else. Then reply with the single word done. If it is refused or fails, do not try anything else: reply with the single word refused.";

const MCP_SERVER = `#!/usr/bin/env node
// A dependency-free MCP server over stdio, with one tool. RFX-089.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import process from "node:process";

const calls = process.argv[2];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") {
    reply({
      protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "notes", version: "0.0.0" },
    });
  } else if (message.method === "tools/list") {
    reply({
      tools: [
        {
          name: "save_note",
          description: "Save a short note.",
          inputSchema: {
            type: "object",
            properties: { title: { type: "string" }, body: { type: "string" } },
            required: ["title", "body"],
          },
        },
      ],
    });
  } else if (message.method === "tools/call") {
    appendFileSync(calls, JSON.stringify(message.params) + "\\n");
    reply({ content: [{ type: "text", text: "saved" }] });
  } else if (message.id !== undefined) {
    reply({});
  }
});
`;

/**
 * `happened(dir)` reads the disk, not the model: did the tool really run?
 */
const CASES = [
  {
    id: "write",
    what: "the Write tool creates a file",
    prompt: `Use the Write tool to create a file named notes.txt in the current directory whose whole content is the single line: hello from reflex\n${ONLY_THEN_DONE}`,
    allowedTools: "Write",
    happened: (dir) =>
      existsSync(join(dir, "notes.txt")) &&
      readFileSync(join(dir, "notes.txt"), "utf8").includes(
        "hello from reflex",
      ),
  },
  {
    id: "edit",
    what: "the Read tool, then the Edit tool on an existing file",
    files: { "greeting.txt": "hello world\n" },
    prompt: `Read the file greeting.txt, then use the Edit tool to replace the word world with the word reflex in it.\n${ONLY_THEN_DONE}`,
    allowedTools: "Read,Edit",
    happened: (dir) =>
      readFileSync(join(dir, "greeting.txt"), "utf8").includes("hello reflex"),
  },
  {
    id: "mcp",
    what: "a tool of an MCP server",
    mcp: true,
    prompt: `Call the save_note tool of the notes server one time, with the title first and the body remember the milk.\n${ONLY_THEN_DONE}`,
    allowedTools: "mcp__notes__save_note",
    happened: (dir) =>
      existsSync(join(dir, "mcp-calls.jsonl")) &&
      readFileSync(join(dir, "mcp-calls.jsonl"), "utf8").includes("save_note"),
  },
  {
    id: "webfetch",
    what: "the WebFetch tool",
    prompt: `Use the WebFetch tool one time to fetch https://example.com/ with the prompt: what is the title of this page?\n${ONLY_THEN_DONE}`,
    allowedTools: "WebFetch(domain:example.com)",
    // A fetch leaves nothing on the disk. The completion event is the evidence.
    happened: () => null,
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
  // `$$` alone repeats within a second on a fast machine; the counter does not.
  write(
    dump,
    `#!/bin/sh\nmkdir -p '${dir}/payloads'\nn=$(ls '${dir}/payloads' | wc -l | tr -d ' ')\ncat > '${dir}/payloads/'"$(printf '%03d' "$n").$1.$$.json"\nexit 0\n`,
    0o755,
  );
  const hooks = Object.fromEntries(
    EVENTS.map((event) => [
      event,
      [
        {
          hooks: [
            { type: "command", command: `'${dump}' ${event}`, timeout: 10 },
          ],
        },
      ],
    ]),
  );
  write(
    join(dir, ".claude", "settings.json"),
    `${JSON.stringify({ hooks }, null, 2)}\n`,
  );
  for (const [name, content] of Object.entries(testCase.files ?? {})) {
    write(join(dir, name), content);
  }
  if (testCase.mcp === true) {
    write(join(dir, "mcp-server.mjs"), MCP_SERVER);
    write(
      join(dir, "mcp.json"),
      `${JSON.stringify({
        mcpServers: {
          notes: {
            command: process.execPath,
            args: [join(dir, "mcp-server.mjs"), join(dir, "mcp-calls.jsonl")],
          },
        },
      })}\n`,
    );
  }
  return dir;
}

function runSession(dir, testCase) {
  const args = [
    "-p",
    testCase.prompt,
    "--model",
    MODEL,
    "--output-format",
    "json",
    "--max-budget-usd",
    BUDGET_USD,
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    ...(testCase.mcp === true ? ["--mcp-config", join(dir, "mcp.json")] : []),
    "--no-session-persistence",
    "--allowedTools",
    testCase.allowedTools,
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
    [process.execPath, "/usr/local/bin/node"],
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
  const sequence = [];
  const samples = {};
  for (const file of files) {
    let payload;
    try {
      payload = JSON.parse(clean(readFileSync(join(payloadDir, file), "utf8")));
    } catch {
      continue;
    }
    const event = String(payload.hook_event_name ?? file.split(".")[1]);
    const key =
      typeof payload.tool_name === "string"
        ? `${event}:${payload.tool_name}`
        : event;
    events[key] = (events[key] ?? 0) + 1;
    sequence.push(key);
    samples[key] ??= payload;
  }

  let result;
  try {
    result = JSON.parse(session.stdout);
  } catch {
    result = undefined;
  }
  return {
    id: testCase.id,
    what: testCase.what,
    allowedTools: testCase.allowedTools,
    happened: testCase.happened(dir),
    events,
    sequence,
    session: {
      exitCode: session.code,
      seconds: Math.round(session.seconds * 10) / 10,
      isError: result?.is_error ?? null,
      turns: result?.num_turns ?? null,
      costUsd: result?.total_cost_usd ?? null,
      reply:
        typeof result?.result === "string"
          ? clean(result.result).slice(0, 200)
          : null,
      permissionDenials: Array.isArray(result?.permission_denials)
        ? result.permission_denials.length
        : null,
      stderr: clean(session.stderr).slice(0, 300) || null,
    },
    samples,
  };
}

const say = (text) => process.stdout.write(`${text}\n`);

const USAGE = `RFX-089: runs the real Claude Code host. Spends the logged-in account's quota.

  --run            required: without it nothing runs and nothing is spent
  --only a,b       run only these cases and print them, leaving the record alone
  --keep           keep the scratch directories

cases: ${CASES.map((c) => c.id).join(", ")}`;

/** Strict: a flag this does not know must never start a paid run. */
function parseArguments(argv) {
  const options = { run: false, keep: false, only: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--run" || flag === "--keep") {
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
  return options.run ? { options } : { error: undefined };
}

const parsed = parseArguments(process.argv.slice(2));
if (parsed.options === undefined) {
  say(parsed.error === undefined ? USAGE : `${parsed.error}\n\n${USAGE}`);
  process.exit(parsed.error === undefined ? 0 : 2);
}
const { only, keep } = parsed.options;

const hostVersion = execFileSync("claude", ["--version"], {
  encoding: "utf8",
}).trim();
const root = mkdtempSync(join(tmpdir(), "reflex-rfx089-"));
const selected = CASES.filter((c) => only === undefined || only.includes(c.id));

say(`host: ${hostVersion}   model: ${MODEL}   budget per run: $${BUDGET_USD}`);
say(`scratch: ${root}\n`);

const results = [];
for (const testCase of selected) {
  const dir = prepare(root, testCase);
  const session = await runSession(dir, testCase);
  const outcome = collect(dir, testCase, session);
  results.push(outcome);
  say(
    `${outcome.id.padEnd(10)} happened=${String(outcome.happened).padEnd(5)} events=${JSON.stringify(outcome.events)} $${String(outcome.session.costUsd ?? "?")} ${String(outcome.session.seconds)}s`,
  );
}

const version = /\d+\.\d+\.\d+/.exec(hostVersion)?.[0] ?? "unknown";
const record = {
  ticket: "RFX-089",
  host: hostVersion,
  model: MODEL,
  totalCostUsd:
    Math.round(
      results.reduce((sum, r) => sum + (r.session.costUsd ?? 0), 0) * 10_000,
    ) / 10_000,
  results,
};

if (only === undefined) {
  const recordPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "payloads",
    `claude-code-${version}.json`,
  );
  write(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  say(`\nrecorded: ${recordPath} (${String(results.length)} cases)`);
} else {
  say(`\n${JSON.stringify(record, null, 2)}`);
}
say(`total cost: $${String(record.totalCostUsd)}`);

if (!keep) {
  rmSync(root, { recursive: true, force: true });
}
process.exitCode = results.some((r) => r.happened === false) ? 1 : 0;
