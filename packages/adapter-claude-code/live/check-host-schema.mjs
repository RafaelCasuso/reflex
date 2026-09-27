#!/usr/bin/env node
/**
 * RFX-124 — the host hook schema canary.
 *
 * Compares the fields the adapter reads from the host's tool inputs
 * (`src/host-schema.ts`) and the recorded fixtures with the type
 * declarations a release of `@anthropic-ai/claude-code` ships in
 * `sdk-tools.d.ts`. Exit 0 when nothing drifted, 1 on drift, 2 when it
 * could not run. The scheduled job runs it against the latest release;
 * nothing here needs a logged-in host or spends anything.
 *
 *   node live/check-host-schema.mjs --latest             the latest release on npm
 *   node live/check-host-schema.mjs --version 2.1.276    one release
 *   node live/check-host-schema.mjs --installed          the package installed globally
 *   node live/check-host-schema.mjs --file <sdk-tools.d.ts>
 *
 * Needs `pnpm build` first: it imports the adapter's built module.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const PACKAGE = "@anthropic-ai/claude-code";
const DECLARATIONS = "sdk-tools.d.ts";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures", "claude-code-2.1");
const MODULE = join(HERE, "..", "dist", "host-schema.js");

function usage() {
  process.stderr.write(
    "usage: check-host-schema.mjs (--latest | --version <x.y.z> | --installed | --file <sdk-tools.d.ts>)\n",
  );
  return 2;
}

/** `npm pack` into a scratch directory; only the declarations are read. */
function declarationsOfRelease(spec) {
  const scratch = mkdtempSync(join(tmpdir(), "reflex-host-schema-"));
  try {
    const out = execFileSync(
      "npm",
      ["pack", `${PACKAGE}@${spec}`, "--ignore-scripts", "--pack-destination", scratch, "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const [packed] = JSON.parse(out);
    if (packed === undefined) {
      throw new Error("npm pack returned nothing");
    }
    execFileSync("tar", ["-xzf", join(scratch, packed.filename), "-C", scratch, `package/${DECLARATIONS}`], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return {
      version: packed.version,
      text: readFileSync(join(scratch, "package", DECLARATIONS), "utf8"),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function declarationsInstalled() {
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const directory = join(root, ...PACKAGE.split("/"));
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  return {
    version: manifest.version,
    text: readFileSync(join(directory, DECLARATIONS), "utf8"),
  };
}

function recordedFixtures() {
  return readdirSync(FIXTURES)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      const payload = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
      return typeof payload.tool_name === "string" &&
        typeof payload.tool_input === "object" &&
        payload.tool_input !== null &&
        payload.mcp_server === undefined
        ? [{ name: file, toolName: payload.tool_name, toolInput: payload.tool_input }]
        : [];
    });
}

async function main(argv) {
  const [flag, value] = argv;
  let source;
  try {
    switch (flag) {
      case "--latest":
        source = declarationsOfRelease("latest");
        break;
      case "--version":
        if (!/^\d+\.\d+\.\d+$/.test(value ?? "")) {
          return usage();
        }
        source = declarationsOfRelease(value);
        break;
      case "--installed":
        source = declarationsInstalled();
        break;
      case "--file":
        if (value === undefined || !existsSync(value)) {
          return usage();
        }
        source = { version: value, text: readFileSync(value, "utf8") };
        break;
      default:
        return usage();
    }
  } catch (error) {
    process.stderr.write(`could not read the declarations: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (!existsSync(MODULE)) {
    process.stderr.write(`${MODULE} does not exist. Run "pnpm build" first.\n`);
    return 2;
  }
  const { compareHostSchema } = await import(MODULE);
  const report = compareHostSchema(source.text, { fixtures: recordedFixtures() });
  process.stdout.write(
    `${JSON.stringify({ package: PACKAGE, version: source.version, ...report }, null, 2)}\n`,
  );
  if (!report.ok) {
    process.stderr.write(
      `host schema drift in ${PACKAGE} ${source.version}: ${report.drift.length} finding(s). The adapter's tables (src/translate.ts) and the fixtures need a look.\n`,
    );
    return 1;
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
