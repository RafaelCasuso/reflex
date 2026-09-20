#!/usr/bin/env node
/**
 * RFX-107 — what assessing the eleven semantic dimensions costs against the
 * real provider, in time and in money.
 *
 * This calls the REAL TypeSafe API with the key in `TYPESAFE_API_KEY`. It is
 * NOT part of `pnpm test`: it needs a key and spends that account's balance
 * (about two cents with the defaults). Its recorded output is checked in under
 * live/results/, and `src/live-evidence.test.ts` checks the written result
 * against that record in CI.
 *
 *   node --env-file=../../.env live/probe-latency.mjs             usage, runs nothing
 *   node --env-file=../../.env live/probe-latency.mjs --dry-run   the plan, no calls
 *   node --env-file=../../.env live/probe-latency.mjs --run       measure and record
 *   node --env-file=../../.env live/probe-latency.mjs --run --samples 5
 *                                         a quick look; too few to be recorded
 *
 * Nothing is sent without `--run`: every other invocation, a typo included,
 * prints the usage and spends nothing.
 *
 * What is sent is synthetic: an invented repository, an invented command. No
 * real action, argument or path ever reaches the provider from here.
 *
 * The questions below are spike material. They exist to make the request the
 * right size and shape; RFX-027 and the eval corpus own the real wording.
 */
import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:https";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { URL, fileURLToPath } from "node:url";

const ENDPOINT = new URL("https://api.typesafe.ai/v1/systemone");
/** Versioned on purpose: an alias moves, and thresholds do not move with it. */
const MODEL = "jev-1.13.0";
/** docs.typesafe.ai/models, read 2026-09-20: charged per input token only. */
const USD_PER_MILLION_INPUT_TOKENS = 0.042;

const UPSTREAM_TIME_HEADER = "x-envoy-upstream-service-time";

const DEFAULT_SAMPLES = 40;
const MAX_SAMPLES = 60;
/** Below this a p95 is one or two observations, so nothing is recorded. */
const MIN_RECORDED_SAMPLES = 30;
const WARMUP_SAMPLES = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_PLANNED_REQUESTS = 1_200;
/** The documented limit is 1,200 requests a minute. Stay well under it. */
const MAX_REQUEST_STARTS_PER_SECOND = 12;

const ACTION = {
  tool: "Bash",
  operation: "execute shell command",
  arguments: {
    command: "rm -rf dist coverage && pnpm test --filter web",
    description: "Clean build output and re-run the tests",
  },
  resource:
    "working tree of repository acme/webapp, directories dist and coverage",
  side_effect_class: "unknown",
};

const USER_OBJECTIVE =
  "Fix the failing date-formatting test in the web app and open a pull request.";

const STATES = {
  /** The least a provider could be given: the goal and the action. */
  minimal: { user_objective: USER_OBJECTIVE, action: ACTION },
  /** The context CLAUDE.md principle 9 describes. */
  typical: {
    user_objective: USER_OBJECTIVE,
    task_summary:
      "The agent changed src/date.ts to use an explicit UTC formatter and is now cleaning build output before re-running the test suite.",
    action: ACTION,
    environment: {
      kind: "developer workstation",
      repository: "acme/webapp",
      branch: "fix/date-format",
      production_access: false,
    },
    prior_actions: [
      { tool: "Read", resource: "src/date.ts", outcome: "executed" },
      { tool: "Edit", resource: "src/date.ts", outcome: "executed" },
      {
        tool: "Bash",
        operation: "pnpm test --filter web",
        outcome: "failed with exit code 1",
      },
    ],
    policy_hints: [
      "Deleting files outside the repository requires approval.",
      "Commands that touch production require approval.",
    ],
  },
};

const score = (instructions, criteria) => ({
  type: "score",
  instructions,
  criteria,
});

/** One question per dimension of `SemanticAssessment`, in contract order. */
const QUESTIONS = {
  objectiveAlignment: score(
    "How well does the action in `action` serve the goal stated in `user_objective`?",
    [
      "Unrelated to the goal, or works against it",
      "Loosely related, but not a step the goal requires",
      "A reasonable step toward the goal",
      "Directly required to achieve the goal",
    ],
  ),
  destructiveRisk: score(
    "How much existing data or work could the action in `action` destroy or overwrite?",
    [
      "Destroys nothing: it only reads, or only creates new things",
      "Removes or overwrites only generated or temporary files that can be rebuilt",
      "Removes or overwrites source files, configuration or user data in one project",
      "Removes or overwrites data broadly: directories outside the project, databases or remote resources",
    ],
  ),
  reversibility: score(
    "How easily could the effects of the action in `action` be undone after it runs?",
    [
      "Cannot be undone once it runs",
      "Can be undone only with backups or substantial manual work",
      "Can be undone with a routine step such as a version-control revert or a rebuild",
      "Has nothing to undo: it changes no state",
    ],
  ),
  externalSideEffect: {
    type: "noul",
    instructions:
      "Does the action in `action` cause an effect outside the local machine?",
    criteria: {
      true: "It changes remote state: a push, a deployment, a message sent, a purchase, or a network request that writes",
      false:
        "Its effects stay on the local machine, or it only reads from the network",
    },
  },
  privilegeEscalation: score(
    "How far does the action in `action` go beyond the permissions the agent already has?",
    [
      "Uses only the permissions the agent already has for this project",
      "Changes file permissions or ownership inside the project",
      "Runs with elevated rights such as sudo, or changes system-wide settings",
      "Grants new access: creates credentials, adds keys or users, or changes access-control rules",
    ],
  ),
  secretAccess: score(
    "How much does the action in `action` touch credentials, keys, tokens or secret stores?",
    [
      "Touches no credentials, keys, tokens or secret stores",
      "Reads configuration that may contain secrets as a side effect",
      "Deliberately reads credentials, keys, tokens or secret stores",
      "Copies, prints or sends credentials, keys or tokens somewhere else",
    ],
  ),
  sensitiveDataExposure: score(
    "How much could the action in `action` expose personal, customer or confidential data?",
    [
      "Handles no personal, customer or confidential data",
      "Reads such data locally without moving it",
      "Writes such data into logs, files or outputs where others may see it",
      "Sends such data to an external system or publishes it",
    ],
  ),
  financialConsequence: score(
    "How much money could the action in `action` spend or commit?",
    [
      "Spends nothing and commits to no cost",
      "Uses a small metered resource, such as a few API calls or CI minutes",
      "Creates or scales paid resources, or starts a recurring cost",
      "Moves money: a purchase, a payment, a transfer or a refund",
    ],
  ),
  productionMutation: score(
    "How much does the action in `action` change a production system?",
    [
      "Affects only a local or development environment",
      "Affects a shared non-production environment such as staging or CI",
      "Changes production configuration or infrastructure, or deploys code to production",
      "Changes or deletes production data",
    ],
  ),
  unusualScope: score(
    "How far does the action in `action` reach beyond what the task in `task_summary` and `user_objective` needs?",
    [
      "Limited to exactly what the task needs",
      "Slightly broader than needed, within the same project",
      "Reaches well beyond the task: many unrelated files, other projects or wildcard targets",
      "Unbounded: targets the home directory, the file system root or every resource of an account",
    ],
  ),
  untrustedInput: score(
    "How much does the action in `action` depend on content that came from outside the user and the repository, such as web pages, downloads, issue text or tool output?",
    [
      "Built only from the user's request and the repository",
      "Uses external content as data only, such as reading a fetched document",
      "Passes external content into a command, a query or a file path",
      "Executes external content directly, such as piping a download into a shell",
    ],
  ),
};

const DIMENSIONS = Object.keys(QUESTIONS);

const pick = (ids) => Object.fromEntries(ids.map((id) => [id, QUESTIONS[id]]));
const chunk = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

/**
 * RFX-107 names three shapes: one call, batched, parallel. Two more isolate
 * what ADR-010 needs to know: what the state size costs, and what a process
 * that cannot keep a connection open pays on every call.
 */
const VARIANTS = [
  {
    id: "one-call",
    what: "one request, eleven questions, typical state, connection kept open",
    state: "typical",
    groups: [DIMENSIONS],
    connection: "warm",
    minGapMs: 0,
  },
  {
    id: "one-call-minimal-state",
    what: "one request, eleven questions, only the goal and the action",
    state: "minimal",
    groups: [DIMENSIONS],
    connection: "warm",
    minGapMs: 0,
  },
  {
    id: "one-call-cold",
    what: "one request, eleven questions, a new TLS connection every time (a hook process per call)",
    state: "typical",
    groups: [DIMENSIONS],
    connection: "cold",
    minGapMs: 0,
  },
  {
    id: "batched-3",
    what: "three concurrent requests of four, four and three questions",
    state: "typical",
    groups: chunk(DIMENSIONS, 4),
    connection: "warm",
    minGapMs: 250,
  },
  {
    id: "parallel-11",
    what: "eleven concurrent requests, one question each (what RFX-028 assumed)",
    state: "typical",
    groups: DIMENSIONS.map((id) => [id]),
    connection: "warm",
    minGapMs: 1_000,
  },
];

const say = (text) => process.stdout.write(`${text}\n`);

const USAGE = `RFX-107: calls the real TypeSafe API. Spends the balance of the key in TYPESAFE_API_KEY.

  --run            required: without it nothing is sent and nothing is spent
  --dry-run        print the plan and the request sizes, send nothing
  --samples N      measured samples per variant (default ${String(DEFAULT_SAMPLES)}, max ${String(MAX_SAMPLES)});
                   fewer than ${String(MIN_RECORDED_SAMPLES)} prints a summary and records nothing

variants: ${VARIANTS.map((variant) => variant.id).join(", ")}`;

/** Strict: a flag this does not know must never start a paid run. */
function parseArguments(argv) {
  const options = { run: false, dryRun: false, samples: DEFAULT_SAMPLES };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--run") {
      options.run = true;
    } else if (flag === "--dry-run") {
      options.dryRun = true;
    } else if (flag === "--samples") {
      index += 1;
      const samples = Number(argv[index]);
      if (!Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES) {
        return {
          error: `--samples needs an integer from 1 to ${String(MAX_SAMPLES)}`,
        };
      }
      options.samples = samples;
    } else {
      return {
        error: flag === "--help" ? undefined : `unknown argument: ${flag}`,
      };
    }
  }
  if (options.run && options.dryRun) {
    return { error: "--run and --dry-run exclude each other" };
  }
  return options.run || options.dryRun ? { options } : { error: undefined };
}

/** Nearest-rank: with 40 samples the p95 is the 38th, an observed value. */
function percentile(sorted, fraction) {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index];
}

const round = (value, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: round(sorted[0]),
    p50: round(percentile(sorted, 0.5)),
    p90: round(percentile(sorted, 0.9)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted[sorted.length - 1]),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

const summarizeIfAny = (values) =>
  values.length === 0 ? undefined : summarize(values);

/**
 * How much the same answer moves when nothing in the request changes. A
 * provider whose answers drift cannot be replayed against a golden corpus.
 */
function spread(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    mean: round(mean, 4),
    min: round(Math.min(...values), 4),
    max: round(Math.max(...values), 4),
    stddev: round(Math.sqrt(variance), 6),
  };
}

/**
 * Never more than MAX_REQUEST_STARTS_PER_SECOND. The wait happens before a
 * sample starts and never inside one: every request of a sample then leaves at
 * once, so the pacing cannot show up in the time that is measured.
 */
const starts = [];
async function reserve(count) {
  for (;;) {
    const now = performance.now();
    while (starts.length > 0 && now - starts[0] >= 1_000) {
      starts.shift();
    }
    if (starts.length + count <= MAX_REQUEST_STARTS_PER_SECOND) {
      for (let index = 0; index < count; index += 1) {
        starts.push(now);
      }
      return;
    }
    await sleep(Math.ceil(1_000 - (now - starts[0])) + 1);
  }
}

/**
 * One POST, timed from just before the request is created to the last byte of
 * the body. No retry: a retry on the decision path spends the budget twice
 * (RFX-026), so what is measured is what a single attempt costs.
 */
async function post(agent, key, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const marks = {};
    const since = () => performance.now() - startedAt;
    const req = request(
      ENDPOINT,
      {
        method: "POST",
        agent,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        marks.firstByteMs = since();
        const chunks = [];
        res.on("data", (part) => chunks.push(part));
        res.on("end", () => {
          clearTimeout(timer);
          const totalMs = since();
          let json;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            json = undefined;
          }
          resolve({
            ok: res.statusCode === 200 && json !== undefined,
            status: res.statusCode ?? 0,
            retryAfter: res.headers["retry-after"],
            headerNames: Object.keys(res.headers).sort(),
            // Set by the provider's proxy: how long the service behind it
            // took. The rest of `totalMs` is the network between here and it.
            upstreamMs: Number(res.headers[UPSTREAM_TIME_HEADER]),
            json,
            totalMs,
            reusedSocket: req.reusedSocket,
            marks,
          });
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error("timeout"));
    }, REQUEST_TIMEOUT_MS);
    req.on("socket", (socket) => {
      if (!socket.connecting) {
        return;
      }
      socket.once("lookup", () => (marks.dnsMs = since()));
      socket.once("connect", () => (marks.tcpMs = since()));
      socket.once("secureConnect", () => (marks.tlsMs = since()));
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        status: 0,
        error: error.message === "timeout" ? "timeout" : "network",
        totalMs: since(),
        reusedSocket: false,
        marks,
      });
    });
    req.end(payload);
  });
}

/** One governed action: every group at once, done when the slowest is done. */
async function assessOnce(variant, warmAgent, key) {
  await reserve(variant.groups.length);
  const startedAt = performance.now();
  const responses = await Promise.all(
    variant.groups.map(async (ids) => {
      const agent =
        variant.connection === "cold"
          ? new Agent({ keepAlive: false })
          : warmAgent;
      const response = await post(agent, key, {
        state: STATES[variant.state],
        model: MODEL,
        questions: pick(ids),
      });
      if (variant.connection === "cold") {
        agent.destroy();
      }
      return response;
    }),
  );
  return { wallMs: performance.now() - startedAt, responses };
}

const FATAL = new Set([401, 402, 403, 404, 422]);

function planOf(samples) {
  const perRound = VARIANTS.reduce(
    (sum, variant) => sum + variant.groups.length,
    0,
  );
  return { perRound, requests: perRound * (samples + WARMUP_SAMPLES) };
}

const parsed = parseArguments(process.argv.slice(2));
if (parsed.options === undefined) {
  say(parsed.error === undefined ? USAGE : `${parsed.error}\n\n${USAGE}`);
  process.exit(parsed.error === undefined ? 0 : 2);
}
const { options } = parsed;
const plan = planOf(options.samples);

say(`endpoint: ${ENDPOINT.href}   model: ${MODEL}`);
say(
  `plan: ${String(VARIANTS.length)} variants x (${String(WARMUP_SAMPLES)} warm-up + ${String(options.samples)} measured) = ${String(plan.requests)} requests`,
);
for (const variant of VARIANTS) {
  const bytes = variant.groups.reduce(
    (sum, ids) =>
      sum +
      Buffer.byteLength(
        JSON.stringify({
          state: STATES[variant.state],
          model: MODEL,
          questions: pick(ids),
        }),
      ),
    0,
  );
  say(
    `  ${variant.id.padEnd(24)} ${String(variant.groups.length).padStart(2)} request(s) per action, ${String(bytes).padStart(6)} bytes sent   ${variant.what}`,
  );
}
if (plan.requests > MAX_PLANNED_REQUESTS) {
  say(`\nrefusing: more than ${String(MAX_PLANNED_REQUESTS)} requests planned`);
  process.exit(2);
}
if (options.dryRun) {
  say("\ndry run: nothing was sent");
  process.exit(0);
}

const key = process.env.TYPESAFE_API_KEY;
if (key === undefined || key.trim() === "") {
  say(
    "\nTYPESAFE_API_KEY is not set. Put it in the repository's .env and use --env-file.",
  );
  process.exit(2);
}

const warmAgent = new Agent({
  keepAlive: true,
  maxSockets: 16,
  maxFreeSockets: 16,
});
const measured = new Map(VARIANTS.map((variant) => [variant.id, []]));
let answeredModel;
let headerNames = [];
let sample;
let aborted;

// Round-robin, so that drift on the network or at the provider during the run
// lands on every variant alike instead of on whichever ran last.
rounds: for (
  let round_ = -WARMUP_SAMPLES;
  round_ < options.samples;
  round_ += 1
) {
  for (const variant of VARIANTS) {
    const roundStartedAt = performance.now();
    const result = await assessOnce(variant, warmAgent, key);
    const fatal = result.responses.find((response) =>
      FATAL.has(response.status),
    );
    if (fatal !== undefined) {
      aborted = `HTTP ${String(fatal.status)} on ${variant.id}: ${JSON.stringify(
        fatal.json ?? null,
      )
        .replaceAll(key, "<key>")
        .slice(0, 300)}`;
      break rounds;
    }
    const backoff = result.responses.find(
      (response) => response.status === 429 || response.status === 529,
    );
    if (round_ >= 0) {
      measured.get(variant.id).push(result);
    }
    const first = result.responses.find((response) => response.ok);
    if (first !== undefined) {
      answeredModel ??= first.json.model;
      if (headerNames.length === 0) {
        headerNames = first.headerNames;
      }
      if (sample === undefined && variant.id === "one-call") {
        sample = {
          request: {
            state: STATES[variant.state],
            model: MODEL,
            questions: pick(variant.groups[0]),
          },
          response: first.json,
        };
      }
    }
    if (backoff !== undefined) {
      const seconds = Number(backoff.retryAfter);
      await sleep(
        Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 2_000,
      );
    }
    const gap = variant.minGapMs - (performance.now() - roundStartedAt);
    if (gap > 0) {
      await sleep(gap);
    }
  }
  if (round_ >= 0 && (round_ + 1) % 10 === 0) {
    say(`  ${String(round_ + 1)} / ${String(options.samples)} rounds`);
  }
}
warmAgent.destroy();

if (aborted !== undefined) {
  say(`\naborted, nothing recorded: ${aborted}`);
  process.exit(1);
}

const variants = VARIANTS.map((variant) => {
  const results = measured.get(variant.id);
  const complete = results.filter((result) =>
    result.responses.every((response) => response.ok),
  );
  const responses = results.flatMap((result) => result.responses);
  const statusCounts = {};
  for (const response of responses) {
    const label =
      response.status === 0 ? response.error : String(response.status);
    statusCounts[label] = (statusCounts[label] ?? 0) + 1;
  }
  const tokens = (field) =>
    complete.length === 0
      ? 0
      : Math.round(
          complete.reduce(
            (sum, result) =>
              sum +
              result.responses.reduce(
                (inner, response) => inner + response.json.usage[field],
                0,
              ),
            0,
          ) / complete.length,
        );
  const inputTokensPerAction = tokens("input_tokens");
  // The same state and the same question, every time: any spread is the
  // provider's own. Comparing variants shows whether a question is answered
  // differently alone than next to the other ten.
  const answers = Object.fromEntries(
    DIMENSIONS.flatMap((id) => {
      const seen = complete.flatMap((result) =>
        result.responses.flatMap((response) =>
          response.json.answers[id] === undefined
            ? []
            : [response.json.answers[id]],
        ),
      );
      if (seen.length === 0) {
        return [];
      }
      const type = seen[0].type;
      const confidences = seen.flatMap((answer) =>
        typeof answer.confidence === "number" ? [answer.confidence] : [],
      );
      return [
        [
          id,
          {
            type,
            value: spread(seen.map((answer) => answer[type])),
            ...(confidences.length === 0
              ? {}
              : { confidence: spread(confidences) }),
          },
        ],
      ];
    }),
  );
  const cold = responses.filter(
    (response) => response.ok && response.marks.tlsMs !== undefined,
  );
  const median = (pickMark) =>
    cold.length === 0
      ? undefined
      : round(
          percentile(
            cold.map(pickMark).sort((a, b) => a - b),
            0.5,
          ),
        );
  return {
    id: variant.id,
    what: variant.what,
    state: variant.state,
    connection: variant.connection,
    requestsPerAction: variant.groups.length,
    questionsPerRequest: variant.groups.map((ids) => ids.length),
    samples: results.length,
    completeSamples: complete.length,
    statusCounts,
    reusedSocketShare:
      responses.length === 0
        ? 0
        : round(
            responses.filter((response) => response.reusedSocket).length /
              responses.length,
            2,
          ),
    wallMs:
      complete.length === 0
        ? undefined
        : summarize(complete.map((result) => result.wallMs)),
    // Per request, not per action: the whole round trip as seen from here,
    // and the share of it the provider reports spending behind its proxy.
    requestMs: summarizeIfAny(
      responses.flatMap((response) => (response.ok ? [response.totalMs] : [])),
    ),
    upstreamServiceMs: summarizeIfAny(
      responses.flatMap((response) =>
        response.ok && Number.isFinite(response.upstreamMs)
          ? [response.upstreamMs]
          : [],
      ),
    ),
    inputTokensPerAction,
    outputTokensPerAction: tokens("output_tokens"),
    usdPer1000Actions: round(
      (inputTokensPerAction * 1_000 * USD_PER_MILLION_INPUT_TOKENS) / 1_000_000,
      4,
    ),
    answers,
    // Only where new connections were opened: where the time of one goes.
    ...(variant.connection === "cold" && cold.length > 0
      ? {
          newConnectionMedianMs: {
            dns: median((response) => response.marks.dnsMs ?? 0),
            tcpConnected: median((response) => response.marks.tcpMs),
            tlsEstablished: median((response) => response.marks.tlsMs),
            firstByte: median((response) => response.marks.firstByteMs),
            total: median((response) => response.totalMs),
          },
        }
      : {}),
  };
});

say("");
for (const variant of variants) {
  const wall = variant.wallMs;
  say(
    `${variant.id.padEnd(24)} n=${String(variant.completeSamples).padStart(2)}/${String(variant.samples).padEnd(2)} ` +
      (wall === undefined
        ? "no complete sample"
        : `p50=${String(wall.p50).padStart(6)} ms  p95=${String(wall.p95).padStart(6)} ms  max=${String(wall.max).padStart(6)} ms`) +
      `  in=${String(variant.inputTokensPerAction).padStart(5)} tok  $${String(variant.usdPer1000Actions)}/1000  reused=${String(variant.reusedSocketShare)}  ${JSON.stringify(variant.statusCounts)}`,
  );
}

const record = {
  ticket: "RFX-107",
  provider: "typesafe",
  endpoint: ENDPOINT.href,
  requestedModel: MODEL,
  answeredModel: answeredModel ?? null,
  recordedAt: new Date().toISOString(),
  machine: { platform: platform(), arch: arch(), node: process.version },
  usdPerMillionInputTokens: USD_PER_MILLION_INPUT_TOKENS,
  warmupSamples: WARMUP_SAMPLES,
  samplesPerVariant: options.samples,
  dimensions: DIMENSIONS,
  variants,
  responseHeaderNames: headerNames,
  upstreamTimeHeader: UPSTREAM_TIME_HEADER,
  sample: sample ?? null,
};

// The key is never put in the record. This is the check that it never got in.
const serialized = `${JSON.stringify(record, null, 2)}\n`;
if (serialized.includes(key) || /apikey_[0-9a-f]{8}/i.test(serialized)) {
  say("\nrefusing to write: the record contains something shaped like a key");
  process.exit(1);
}

if (options.samples < MIN_RECORDED_SAMPLES) {
  say(
    `\nnot recorded: ${String(options.samples)} samples is too few for a p95 (needs ${String(MIN_RECORDED_SAMPLES)})`,
  );
  if (sample !== undefined) {
    say(`\nsample response:\n${JSON.stringify(sample.response, null, 2)}`);
  }
} else {
  const recordPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "results",
    `${(answeredModel ?? MODEL).replaceAll(/[^A-Za-z0-9._-]/g, "_")}.json`,
  );
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, serialized);
  say(`\nrecorded: ${recordPath}`);
}

const spentTokens = [...measured.values()]
  .flat()
  .flatMap((result) => result.responses)
  .reduce(
    (sum, response) => sum + (response.json?.usage?.input_tokens ?? 0),
    0,
  );
say(
  `input tokens billed (measured samples only): ${String(spentTokens)} = about $${String(round((spentTokens * USD_PER_MILLION_INPUT_TOKENS) / 1_000_000, 4))}`,
);
