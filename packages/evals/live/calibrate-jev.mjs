#!/usr/bin/env node
/**
 * RFX-110 — the calibration table against the real provider.
 *
 * Runs every case of the semantic corpus that says what a right assessment
 * is through `createJevProvider` as built in `dist/`, bins each answer by
 * the confidence the provider gave it, and writes the reliability table
 * per dimension with the threshold it suggests (`calibrate`, RFX-110). The
 * corpus is synthetic and nothing from this machine is sent.
 *
 * Paid: one request per case. Refuses to run without `--run`.
 *
 *   node --env-file=../../.env live/calibrate-jev.mjs --run [--target 0.9]
 *   node live/calibrate-jev.mjs --dry-run
 */
import { writeFileSync } from "node:fs";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

import { JEV_DEFAULT_MODEL, createJevProvider } from "@reflex/provider-jev";

import {
  calibrate,
  describeCalibration,
  readCorpusDirectory,
} from "../dist/index.js";

const SEMANTIC_CORPUS = fileURLToPath(
  new URL("../corpus/semantic/v1/", import.meta.url),
);
const RESULT = fileURLToPath(
  new URL("./results/calibration-jev.json", import.meta.url),
);

function parseArguments(argv) {
  const options = { run: false, dryRun: false, target: 0.9 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--run") {
      options.run = true;
    } else if (flag === "--dry-run") {
      options.dryRun = true;
    } else if (flag === "--target") {
      index += 1;
      const target = Number(argv[index]);
      if (!Number.isFinite(target) || target <= 0 || target > 1) {
        return { error: "--target needs a number in (0, 1]" };
      }
      options.target = target;
    } else {
      return { error: `unknown flag: ${flag}` };
    }
  }
  return options;
}

const say = (text) => process.stdout.write(`${text}\n`);
const options = parseArguments(process.argv.slice(2));
if (options.error !== undefined) {
  process.stderr.write(`${options.error}\n`);
  process.exit(2);
}

const loaded = readCorpusDirectory(SEMANTIC_CORPUS);
if (!loaded.ok) {
  process.stderr.write(
    `${loaded.issues.map((issue) => issue.message).join("\n")}\n`,
  );
  process.exit(2);
}
const cases = loaded.cases.filter(
  (testCase) => testCase.expectedAssessment !== undefined,
);

if (options.dryRun) {
  say(
    `${String(cases.length)} cases with an expected assessment; one request each against ${JEV_DEFAULT_MODEL}`,
  );
  process.exit(0);
}
if (!options.run) {
  process.stderr.write("refusing to spend without --run (or use --dry-run)\n");
  process.exit(2);
}
const apiKey = process.env.TYPESAFE_API_KEY;
if (apiKey === undefined || apiKey === "") {
  process.stderr.write(
    "TYPESAFE_API_KEY is not set; use node --env-file=../../.env\n",
  );
  process.exit(2);
}

const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
const provider = createJevProvider({
  apiKey,
  model: JEV_DEFAULT_MODEL,
  onUsage: (entry) => {
    usage.requests += 1;
    usage.inputTokens += entry.inputTokens ?? 0;
    usage.outputTokens += entry.outputTokens ?? 0;
  },
});

const startedAt = new Date().toISOString();
const report = await calibrate(provider, cases, { target: options.target });
const lines = describeCalibration(report);
for (const line of lines) {
  say(line);
}
say(
  `suggested threshold: ${report.suggestedThreshold === undefined ? "none" : report.suggestedThreshold.toFixed(1)} (target ${String(report.target)}, ${String(report.cases)} cases, ${String(report.unassessed)} unassessed)`,
);
say(
  `usage: ${String(usage.requests)} requests, ${String(usage.inputTokens)} input tokens, ${String(usage.outputTokens)} output tokens`,
);
writeFileSync(
  RESULT,
  `${JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), model: JEV_DEFAULT_MODEL, usage, report, lines }, null, 2)}\n`,
);
say(`written ${RESULT}`);
