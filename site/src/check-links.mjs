#!/usr/bin/env node
/**
 * RFX-137 — a broken internal link fails CI.
 *
 *   node site/src/check-links.mjs [<built site directory>]
 *
 * Reads every HTML page of the built site, follows every link and
 * reference that points inside the site (absolute paths, relative paths,
 * fragments) and reports the ones that reach no file or no element id.
 * External links are not fetched: they are not this site's to keep.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE_ROOT = fileURLToPath(new URL("../", import.meta.url));

function htmlFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...htmlFiles(path));
    } else if (entry.name.endsWith(".html")) {
      found.push(path);
    }
  }
  return found;
}

function idsOf(html) {
  return new Set(
    [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]),
  );
}

/** Where a site path lands on disk: a directory's index, or a file. */
function targetOf(out, fromFile, reference) {
  const [path] = reference.split("#");
  if (path === "") {
    return fromFile;
  }
  const base = path.startsWith("/") ? out : dirname(fromFile);
  const resolved = path.startsWith("/") ? join(out, path) : resolve(base, path);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    return join(resolved, "index.html");
  }
  return resolved;
}

export function checkLinks(outputDirectory) {
  const out = resolve(outputDirectory ?? join(SITE_ROOT, "dist"));
  const problems = [];
  const pages = htmlFiles(out);
  const ids = new Map(
    pages.map((file) => [file, idsOf(readFileSync(file, "utf8"))]),
  );
  for (const file of pages) {
    const html = readFileSync(file, "utf8");
    const references = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map(
      (match) => match[1],
    );
    for (const reference of references) {
      if (/^(https?:|mailto:|data:)/.test(reference)) {
        continue;
      }
      const target = targetOf(out, file, reference);
      const page = posix.join("/", relative(out, file).split("\\").join("/"));
      if (!existsSync(target)) {
        problems.push(`${page}: ${reference} reaches nothing`);
        continue;
      }
      const fragment = reference.split("#")[1];
      if (fragment !== undefined && fragment !== "") {
        const known = ids.get(target) ?? idsOf(readFileSync(target, "utf8"));
        if (!known.has(fragment)) {
          problems.push(`${page}: ${reference} has no element #${fragment}`);
        }
      }
    }
  }
  return { pages: pages.length, problems };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = checkLinks(process.argv[2]);
  for (const problem of result.problems) {
    process.stderr.write(`${problem}\n`);
  }
  process.stdout.write(
    `${String(result.pages)} pages, ${String(result.problems.length)} broken link(s)\n`,
  );
  process.exitCode = result.problems.length === 0 ? 0 : 1;
}
