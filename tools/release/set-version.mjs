#!/usr/bin/env node
/**
 * RFX-127 — one version for every publishable package.
 *
 *   node tools/release/set-version.mjs 0.1.0
 *
 * Writes `version` into every workspace manifest that is not private, into
 * the root manifest, and into the CLI's own constant (`packages/cli/src/version.ts`,
 * what `rfx --version` prints), so that a release tag `v0.1.0` builds
 * packages that say 0.1.0 and depend on each other at `workspace:*`, which
 * pnpm rewrites to the published version when it packs. It runs before the
 * build that is packed. Private packages keep 0.0.0: they are never published.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const version = process.argv[2];
if (
  version === undefined ||
  !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)
) {
  process.stderr.write("usage: set-version.mjs <major.minor.patch[-pre]>\n");
  process.exit(2);
}

const manifests = [];
for (const parent of ["packages", "apps"]) {
  for (const entry of readdirSync(join(ROOT, parent), {
    withFileTypes: true,
  })) {
    if (entry.isDirectory()) {
      manifests.push(join(ROOT, parent, entry.name, "package.json"));
    }
  }
}

let changed = 0;
for (const file of manifests) {
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (manifest.private === true) {
    continue;
  }
  if (manifest.version !== version) {
    manifest.version = version;
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    changed += 1;
  }
}
const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
if (root.version !== version) {
  root.version = version;
  writeFileSync(
    join(ROOT, "package.json"),
    `${JSON.stringify(root, null, 2)}\n`,
  );
  changed += 1;
}

const versionModule = join(ROOT, "packages", "cli", "src", "version.ts");
const source = readFileSync(versionModule, "utf8");
const constant = /^export const CLI_VERSION = "[^"]*";$/m;
if (!constant.test(source)) {
  process.stderr.write(`${versionModule}: CLI_VERSION constant not found\n`);
  process.exit(1);
}
const rewritten = source.replace(
  constant,
  `export const CLI_VERSION = "${version}";`,
);
if (rewritten !== source) {
  writeFileSync(versionModule, rewritten);
  changed += 1;
}
process.stdout.write(`${String(changed)} file(s) set to ${version}\n`);
