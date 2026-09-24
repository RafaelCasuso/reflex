#!/usr/bin/env node
/**
 * RFX-111 — mutation testing for the decision paths.
 *
 * For every file in `tools/mutation-targets.json` this applies one small
 * change at a time (a flipped comparison, a swapped effect literal, a
 * negated boolean, `&&` for `||`, `max` for `min`), runs the package's
 * tests, and expects them to fail. A mutant the tests do not catch has
 * found a branch nobody is holding. It survives the check only if
 * `tools/mutation-allowlist.json` names it with a reason.
 *
 * In-house on purpose: the mutation frameworks tried could not activate
 * mutants under this repository's test runner (Stryker 10 with Vitest 5:
 * every mutant survived with every test running). This does one thing,
 * visibly: it edits the file, runs the tests, puts the file back.
 *
 *   node tools/mutate.mjs [--package <dir>] [--file <path>] [--dry-run]
 *                         [--json <file>] [--allow-dirty]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TARGETS = JSON.parse(
  readFileSync(join(ROOT, "tools/mutation-targets.json"), "utf8"),
).targets;
const ALLOWLIST = JSON.parse(
  readFileSync(join(ROOT, "tools/mutation-allowlist.json"), "utf8"),
).justified;

/** Each operator: a regex with one capture, and what the capture becomes. */
const OPERATORS = [
  { name: "eq-to-neq", regex: /(===)/g, replace: () => "!==" },
  { name: "neq-to-eq", regex: /(!==)/g, replace: () => "===" },
  { name: "gte-to-gt", regex: / (>=) /g, replace: () => ">" },
  { name: "lte-to-lt", regex: / (<=) /g, replace: () => "<" },
  { name: "gt-to-gte", regex: / (>) (?!=)/g, replace: () => ">=" },
  { name: "lt-to-lte", regex: / (<) (?!=)/g, replace: () => "<=" },
  { name: "and-to-or", regex: / (&&) /g, replace: () => "||" },
  { name: "or-to-and", regex: / (\|\|) /g, replace: () => "&&" },
  { name: "allow-to-deny", regex: /("allow")/g, replace: () => '"deny"' },
  { name: "deny-to-ask", regex: /("deny")/g, replace: () => '"ask"' },
  { name: "ask-to-allow", regex: /("ask")/g, replace: () => '"allow"' },
  { name: "true-to-false", regex: /\b(true)\b/g, replace: () => "false" },
  { name: "false-to-true", regex: /\b(false)\b/g, replace: () => "true" },
  { name: "max-to-min", regex: /Math\.(max)\(/g, replace: () => "min" },
  { name: "min-to-max", regex: /Math\.(min)\(/g, replace: () => "max" },
];

function parseArguments(argv) {
  const options = {
    packageFilter: undefined,
    fileFilter: undefined,
    dryRun: false,
    json: undefined,
    allowDirty: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--package") {
      options.packageFilter = argv[++index];
    } else if (flag === "--file") {
      options.fileFilter = argv[++index];
    } else if (flag === "--dry-run") {
      options.dryRun = true;
    } else if (flag === "--json") {
      options.json = argv[++index];
    } else if (flag === "--allow-dirty") {
      options.allowDirty = true;
    } else {
      return { error: `unknown flag: ${flag}` };
    }
  }
  return options;
}

/**
 * A line that is only a comment is not code, and a type member (an
 * interface or type-literal property, which ends in `;`) changes nothing at
 * run time; a mutant in either is noise. An object literal's member ends in
 * `,` or `}` and is mutated.
 */
function isNotCode(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    /^(?:readonly\s+)?[A-Za-z_$][\w$]*\??:\s.*;$/.test(trimmed) ||
    /^(?:export\s+)?(?:type|interface)\s/.test(trimmed) ||
    /^\|\s/.test(trimmed)
  );
}
/** Every mutant of a file: where, which operator, and the mutated text. */
function mutantsOf(source) {
  const lines = source.split("\n");
  const mutants = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (isNotCode(line)) {
      continue;
    }
    for (const operator of OPERATORS) {
      operator.regex.lastIndex = 0;
      for (const match of line.matchAll(operator.regex)) {
        const offset = match.index + match[0].indexOf(match[1]);
        const mutatedLine =
          line.slice(0, offset) +
          operator.replace() +
          line.slice(offset + match[1].length);
        const mutated = [...lines];
        mutated[lineIndex] = mutatedLine;
        mutants.push({
          line: lineIndex + 1,
          column: offset + 1,
          operator: operator.name,
          original: line.trim(),
          mutatedLine: mutatedLine.trim(),
          source: mutated.join("\n"),
        });
      }
    }
  }
  return mutants;
}

function runTests(packageDir) {
  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "--reporter=dot"],
    {
      cwd: packageDir,
      encoding: "utf8",
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      timeout: 180_000,
    },
  );
  return {
    killed: result.status !== 0,
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}

function isClean(paths) {
  const result = spawnSync("git", ["diff", "--quiet", "--", ...paths], {
    cwd: ROOT,
  });
  return result.status === 0;
}

function justificationFor(target, file, mutant) {
  return ALLOWLIST.find(
    (entry) =>
      entry.package === target.package &&
      entry.file === file &&
      entry.line === mutant.line &&
      entry.operator === mutant.operator,
  );
}

const say = (text) => process.stdout.write(`${text}\n`);

const options = parseArguments(process.argv.slice(2));
if (options.error !== undefined) {
  process.stderr.write(`${options.error}\n`);
  process.exit(2);
}

const targets = TARGETS.filter(
  (target) =>
    options.packageFilter === undefined ||
    target.package === options.packageFilter,
).map((target) => ({
  ...target,
  files: target.files.filter(
    (file) => options.fileFilter === undefined || file === options.fileFilter,
  ),
}));

const allPaths = targets.flatMap((target) =>
  target.files.map((file) => join(target.package, file)),
);
if (!options.allowDirty && !isClean(allPaths)) {
  process.stderr.write(
    "the target files have uncommitted changes; commit them or pass --allow-dirty\n",
  );
  process.exit(2);
}

const report = { ran: new Date().toISOString(), targets: [] };
let unjustifiedSurvivors = 0;
const started = performance.now();

for (const target of targets) {
  const packageDir = join(ROOT, target.package);
  for (const file of target.files) {
    const path = join(packageDir, file);
    const original = readFileSync(path, "utf8");
    const mutants = mutantsOf(original);
    const entry = {
      package: target.package,
      file,
      mutants: mutants.length,
      killed: 0,
      survived: [],
      justified: [],
      timedOut: 0,
    };
    say(
      `${target.package}/${file}: ${String(mutants.length)} mutants${options.dryRun ? " (dry run)" : ""}`,
    );
    if (options.dryRun) {
      report.targets.push(entry);
      continue;
    }
    try {
      for (const mutant of mutants) {
        writeFileSync(path, mutant.source);
        const outcome = runTests(packageDir);
        if (outcome.timedOut) {
          entry.timedOut += 1;
          entry.killed += 1; // a mutant that hangs the suite did not pass it
          continue;
        }
        if (outcome.killed) {
          entry.killed += 1;
          continue;
        }
        const justification = justificationFor(target, file, mutant);
        const record = {
          line: mutant.line,
          column: mutant.column,
          operator: mutant.operator,
          original: mutant.original,
          mutated: mutant.mutatedLine,
        };
        if (justification === undefined) {
          entry.survived.push(record);
          unjustifiedSurvivors += 1;
          say(
            `  SURVIVED ${file}:${String(mutant.line)}:${String(mutant.column)} ${mutant.operator}\n    - ${mutant.original}\n    + ${mutant.mutatedLine}`,
          );
        } else {
          entry.justified.push({ ...record, reason: justification.reason });
        }
      }
    } finally {
      writeFileSync(path, original);
    }
    if (readFileSync(path, "utf8") !== original) {
      process.stderr.write(`${relative(ROOT, path)} was not restored\n`);
      process.exit(1);
    }
    report.targets.push(entry);
    say(
      `  killed ${String(entry.killed)}/${String(mutants.length)}, survived ${String(entry.survived.length)}, justified ${String(entry.justified.length)}`,
    );
  }
}

report.elapsedSeconds = Math.round((performance.now() - started) / 1000);
report.unjustifiedSurvivors = unjustifiedSurvivors;
if (options.json !== undefined) {
  writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
}
if (!options.dryRun) {
  say(
    `\n${String(unjustifiedSurvivors)} unjustified survivor(s) in ${String(report.elapsedSeconds)} s`,
  );
  process.exit(unjustifiedSurvivors === 0 ? 0 : 1);
}
