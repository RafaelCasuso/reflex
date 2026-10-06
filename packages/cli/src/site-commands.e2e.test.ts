import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
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
 * RFX-137 — every command on the public documentation runs.
 *
 * Each docs page under site/content/docs is read; every `rfx` line of its
 * fenced `sh` blocks is run, in the page's order, against the built CLI, in
 * a temporary project with a temporary REFLEX home, and must exit 0. A
 * page's policy examples (`yaml` blocks) are written where the page says
 * they go, so that the commands act on them. A command that the docs show
 * and that would fail is a lie the test catches; `npm install` lines are
 * the site workflow's to run, against the released package.
 */
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const DOCS = fileURLToPath(
  new URL("../../../site/content/docs/", import.meta.url),
);

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function rfx(args: readonly string[], cwd: string, home: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...process.env, REFLEX_HOME: home },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

/** A shell line into arguments: words and quoted words, nothing else the docs use. */
function wordsOf(line: string): string[] {
  const words: string[] = [];
  for (const match of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return words;
}

interface Block {
  readonly language: string;
  readonly body: string;
}

function blocksOf(markdown: string): Block[] {
  return [...markdown.matchAll(/^```(\w+)\n([\s\S]*?)^```$/gm)].map(
    (match) => ({
      language: match[1] ?? "",
      body: match[2] ?? "",
    }),
  );
}

let root: string;
let home: string;
let project: string;

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`build the CLI first: ${BIN} is missing`);
  }
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "reflex-docs-")));
  home = join(root, "home");
  project = join(root, "work", "api");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(join(project, ".git"), { recursive: true });
  await writeFile(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(
    join(project, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:acme/api.git\n',
  );
});

afterEach(async () => {
  const { stopDaemon } = await import("./daemon/lifecycle.js");
  await stopDaemon(home, { graceMs: 2_000 });
  await rm(root, { recursive: true, force: true });
});

/**
 * Where a page's yaml blocks go, in order. The quick start edits the
 * project's policy; the team policy page writes the organization's and
 * production's documents, then the project's mapping.
 */
const YAML_TARGETS: Readonly<Record<string, readonly string[]>> = {
  "quick-start": [".reflex/policy.yaml"],
  "team-policy": [
    "organization.yaml",
    "production.yaml",
    ".reflex/policy.yaml",
  ],
};

const pages = (await readdir(DOCS))
  .filter((file) => file.endsWith(".md"))
  .sort();

describe.each(pages)("the commands of %s", (file) => {
  const slug = file.slice(0, -3);

  it("all run and exit 0, in order", async () => {
    const markdown = await readFile(join(DOCS, file), "utf8");
    const blocks = blocksOf(markdown);
    const yamlTargets = YAML_TARGETS[slug] ?? [];
    let yamlIndex = 0;

    // Every page assumes an installed project, as the install page says;
    // the quick start installs by itself and the second init is a no-op.
    const installed = await rfx(
      ["init", "--yes", "--host", "claude-code"],
      project,
      home,
    );
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);

    let ran = 0;
    for (const block of blocks) {
      if (block.language === "yaml") {
        const target = yamlTargets[yamlIndex];
        yamlIndex += 1;
        if (target !== undefined) {
          const path = join(project, target);
          await mkdir(join(path, ".."), { recursive: true });
          await writeFile(path, block.body);
        }
        continue;
      }
      if (block.language !== "sh") {
        continue;
      }
      for (const line of block.body.split("\n")) {
        const command = line.trim();
        if (!command.startsWith("rfx ")) {
          continue;
        }
        let words = wordsOf(command).slice(1);
        // The docs subscribe to an example URL; here, to the snapshot the
        // same page just wrote, which is what the URL would serve.
        words = words.map((word) =>
          word.startsWith("https://")
            ? join(project, "reflex-policy.json")
            : word,
        );
        const run = await rfx(words, project, home);
        expect(run.code, `${command}\n${run.stdout}${run.stderr}`).toBe(0);
        ran += 1;
      }
    }
    // A page that shows no command (the threat model, storage, hosts) runs
    // nothing; a page that shows one runs all of them.
    const shown = blocks.some(
      (block) => block.language === "sh" && block.body.includes("rfx "),
    );
    expect(ran > 0).toBe(shown);
  }, 60_000);
});
