#!/usr/bin/env node
/**
 * RFX-150, RFX-137 — the public site, built from files in this repository.
 *
 *   node site/src/build.mjs [<output directory>]
 *
 * Nothing on the pages is typed in twice: the positioning paragraph comes
 * from docs/product.md, the consent statement from the semantic-provider
 * package (built first), every number from the benchmark record, the hook
 * cost table and the corpus files, every terminal block from a capture
 * that tools/site/capture.sh made by running the CLI. The reference pages
 * (policy language, threat model) are docs/ files rendered as they are.
 * tests/site.test.ts builds this and holds each of those to its source.
 *
 * The output is static HTML and CSS, self-hosted fonts, no script: nothing
 * runs in the visitor's browser and no request leaves it for a third party.
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Marked } from "marked";

export const SITE_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const REPO_ROOT = resolve(SITE_ROOT, "..");
export const REPOSITORY_URL = "https://github.com/RafaelCasuso/reflex";
export const SITE_ORIGIN = "https://rafaelcasuso.github.io";
/**
 * Where the site is served from under its origin. GitHub Pages serves a
 * project site under `/<repository>/`; a local check or Lighthouse serves
 * the built directory at the root. Every root-absolute reference the pages
 * make (`/install/`, `/fonts/...`, the stylesheet) is prefixed with it at
 * the end of the build, so templates and docs are written once.
 */
export const BASE_PATH = (process.env.SITE_BASE_PATH ?? "/reflex").replace(
  /\/+$/,
  "",
);
export const INSTALL_COMMAND = "npm install -g @reflex-control/cli && rfx init";

const DOCS_ORDER = [
  "quick-start",
  "decisions",
  "modes",
  "policy-language",
  "team-policy",
  "hosts",
  "threat-model",
  "stored",
  "troubleshooting",
];

/** Markdown files of docs/ that are published as they are, by site slug. */
const DOCS_FROM_REPOSITORY = {
  "policy-language": "docs/policy-language.md",
  "threat-model": "docs/security.md",
};

/** Repository paths that a docs link may point at, and where they live on the site. */
const REPOSITORY_LINKS = {
  "docs/policy-language.md": "/docs/policy-language/",
  "docs/security.md": "/docs/threat-model/",
};

export function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function read(relative) {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

function fail(message) {
  throw new Error(`site: ${message}`);
}

/* ---------- the numbers, each from the file that measured it ---------- */

const ms = (value) => `${value.toFixed(1)} ms`;

export function readNumbers() {
  const bench = JSON.parse(
    read("apps/decision-gateway/bench/results/apple-m1-max-node24.json"),
  );
  const typical = bench.cases.find((entry) => entry.label === "typical read");
  if (typical === undefined) {
    fail("the benchmark record has no typical read case");
  }

  const hookDoc = read("docs/claude-code-hook.md");
  const hookRow = hookDoc
    .split("\n")
    .find((line) => line.startsWith("| Hook, `PreToolUse`"));
  if (hookRow === undefined) {
    fail("docs/claude-code-hook.md has no PreToolUse row");
  }
  const hookCells = hookRow
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "");
  const hookP50 = hookCells[2];
  const hookP95 = hookCells[3];
  const hookBaseline =
    /^Baseline, (\d{4}-\d{2}-\d{2})\. (.+?)\.\s+(\d+) sequential runs/m.exec(
      hookDoc,
    );
  if (hookBaseline === null) {
    fail("docs/claude-code-hook.md has no baseline line");
  }

  const countCases = (directory) =>
    readdirSync(join(REPO_ROOT, directory))
      .filter((file) => file.endsWith(".json"))
      .reduce((total, file) => {
        const parsed = JSON.parse(read(join(directory, file)));
        return total + (Array.isArray(parsed.cases) ? parsed.cases.length : 0);
      }, 0);
  const injection = JSON.parse(
    read("packages/evals/corpus/semantic/injection-v1.json"),
  );

  return {
    bench: {
      machine: `${bench.machine.cpu}, Node ${bench.machine.node.replace(/^v/, "")}`,
      measuredAt: bench.measuredAt.slice(0, 10),
      warmRuns: bench.runs.warm,
      endToEndRuns: bench.runs.endToEnd,
      rules: bench.policy.rules,
      socketHitP95: ms(typical.overSocketHitMs.p95),
      socketMissP95: ms(typical.overSocketMissMs.p95),
      endToEndP50: ms(typical.endToEndNetClientMs.p50),
      endToEndP95: ms(typical.endToEndNetClientMs.p95),
    },
    hook: {
      p50: hookP50,
      p95: hookP95,
      measuredAt: hookBaseline[1],
      machine: hookBaseline[2],
      runs: hookBaseline[3],
    },
    corpus: {
      golden: countCases("packages/evals/corpus/v1"),
      semantic: countCases("packages/evals/corpus/semantic/v1"),
      injectionPairs: Array.isArray(injection.pairs)
        ? injection.pairs.length
        : 0,
    },
  };
}

/* ---------- the words that are already written somewhere ---------- */

export function readPositioning() {
  const product = read("docs/product.md");
  const start = product.indexOf("**More autonomy. Less supervision.**");
  if (start === -1) {
    fail("docs/product.md has no positioning block");
  }
  const after = product.slice(start).split("\n\n")[1];
  if (after === undefined) {
    fail("docs/product.md has no positioning paragraph");
  }
  return after.replaceAll("\n", " ").trim();
}

export async function readConsentStatement() {
  const built = join(REPO_ROOT, "packages/semantic-provider/dist/consent.js");
  if (!existsSync(built)) {
    fail("packages/semantic-provider is not built; run pnpm build first");
  }
  const consent = await import(pathToFileURL(built).href);
  return consent.consentStatement("jev");
}

export function readCliVersion() {
  // The published version is what the install page's command gets; the
  // repository's manifest says 0.0.0 until a release tag (docs/releasing.md).
  return "latest";
}

/* ---------- the captures ---------- */

const VERDICT = /\b(allow|ask|deny)\b/g;

function highlightCapture(text) {
  return escapeHtml(text)
    .split("\n")
    .map((line, index) => {
      if (index === 0 && line.startsWith("$ ")) {
        return `<span class="prompt">$</span> <span class="command">${line.slice(2)}</span>`;
      }
      // The verdict words of the product, in their colour, where the CLI
      // prints them as verdicts: the Matched rows, the Effect line, the
      // By-mode line and the hook's answer.
      if (
        /^ {2}(allow|ask|deny) {2}/.test(line) ||
        /^(Effect|By mode) /.test(line) ||
        line.includes("permissionDecision")
      ) {
        return line.replace(
          VERDICT,
          (word) => `<span class="v-${word}">${word}</span>`,
        );
      }
      return line;
    })
    .join("\n");
}

export function readCaptures() {
  const directory = join(SITE_ROOT, "captures");
  const captures = {};
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".txt")) {
      continue;
    }
    const text = readFileSync(join(directory, file), "utf8").replace(
      /\n+$/,
      "",
    );
    captures[file.slice(0, -4)] = {
      text,
      html: `<pre class="terminal" tabindex="0"><code>${highlightCapture(text)}</code></pre>`,
    };
  }
  return captures;
}

/* ---------- markdown ---------- */

function slugOf(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function rewriteLink(href) {
  if (/^(https?:|mailto:|#)/.test(href)) {
    return href;
  }
  const [path, fragment] = href.split("#");
  const anchor = fragment === undefined ? "" : `#${fragment}`;
  const cleaned = path.replace(/^\.\//, "");
  if (cleaned === "") {
    return href;
  }
  // A docs page of the site, by slug.
  const asSlug = cleaned.replace(/\.md$/, "").replace(/\/$/, "");
  if (DOCS_ORDER.includes(asSlug)) {
    return `/docs/${asSlug}/${anchor}`;
  }
  // A repository file: where it lives on the site, else on GitHub.
  const repositoryPath = cleaned.replace(/^(\.\.\/)+/, "");
  const onSite = REPOSITORY_LINKS[repositoryPath];
  if (onSite !== undefined) {
    return `${onSite}${anchor}`;
  }
  if (/^(docs|packages|apps|tools|\.github)\//.test(repositoryPath)) {
    return `${REPOSITORY_URL}/blob/main/${repositoryPath}${anchor}`;
  }
  return href;
}

export function createMarkdown() {
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ text, depth, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const id = slugOf(text);
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const target = rewriteLink(href);
        const external = /^https?:/.test(target);
        return `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ""}${external ? ' rel="noopener"' : ""}>${inner}</a>`;
      },
      code({ text, lang }) {
        const language = (lang ?? "").split(/\s+/)[0];
        const classes =
          language === "" ? "" : ` class="language-${escapeHtml(language)}"`;
        return `<pre tabindex="0"><code${classes}>${escapeHtml(text)}</code></pre>\n`;
      },
    },
  });
  return marked;
}

/* ---------- pages ---------- */

/** Root-absolute references, prefixed with the base path. */
export function withBasePath(html) {
  if (BASE_PATH === "") {
    return html;
  }
  return html
    .replaceAll(
      /\s(href|src)="\/(?!\/)/g,
      (_match, attribute) => ` ${attribute}="${BASE_PATH}/`,
    )
    .replaceAll(/url\("\/(?!\/)/g, `url("${BASE_PATH}/`);
}

export function render(template, context) {
  return template
    .replaceAll(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_match, path) =>
      String(lookup(context, path)),
    )
    .replaceAll(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path) =>
      escapeHtml(String(lookup(context, path))),
    );
}

function lookup(context, path) {
  let value = context;
  for (const key of path.split(".")) {
    if (value === undefined || value === null || !(key in value)) {
      fail(`template asks for ${path}, which the build does not have`);
    }
    value = value[key];
  }
  return value;
}

function titleOf(markdown, fallback) {
  const match = /^# (.+)$/m.exec(markdown);
  return match === null ? fallback : match[1].trim();
}

function descriptionOf(markdown) {
  const paragraph = markdown
    .split("\n\n")
    .map((block) => block.trim())
    .find(
      (block) =>
        block !== "" &&
        !block.startsWith("#") &&
        !block.startsWith("```") &&
        !block.startsWith("|") &&
        !block.startsWith("-"),
    );
  const text = (paragraph ?? "").replaceAll("\n", " ").replace(/[*`_]/g, "");
  if (text.length <= 160) {
    return text;
  }
  // Whole sentences, never a word cut in half.
  const cut = text.slice(0, 160);
  const sentence = cut.lastIndexOf(". ");
  if (sentence > 40) {
    return cut.slice(0, sentence + 1);
  }
  const word = cut.lastIndexOf(" ");
  return `${cut.slice(0, word > 40 ? word : 160)}…`;
}

export async function build(outputDirectory) {
  const out = resolve(outputDirectory ?? join(SITE_ROOT, "dist"));
  const numbers = readNumbers();
  const positioning = readPositioning();
  const consent = await readConsentStatement();
  const captures = readCaptures();
  const cliVersion = readCliVersion();
  const shell = readFileSync(join(SITE_ROOT, "src", "shell.html"), "utf8");
  const css = readFileSync(join(SITE_ROOT, "src", "site.css"), "utf8");
  const cssHash = createHash("sha256").update(css).digest("hex").slice(0, 8);
  const cssFile = `site.${cssHash}.css`;
  const marked = createMarkdown();

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, cssFile), withBasePath(css));
  cpSync(join(SITE_ROOT, "fonts"), join(out, "fonts"), { recursive: true });
  writeFileSync(join(out, ".nojekyll"), "");
  writeFileSync(
    join(out, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${SITE_ORIGIN}${BASE_PATH}/sitemap.txt\n`,
  );

  const pages = [];
  const page = (path, { title, description, body, section }) => {
    const html = render(shell, {
      title,
      description,
      css: `/${cssFile}`,
      section,
      year: String(new Date().getUTCFullYear()),
      repository: REPOSITORY_URL,
      body: { html: body },
    }).replace("{{{body.html}}}", body);
    const directory = path === "/" ? out : join(out, path);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "index.html"), withBasePath(html));
    pages.push(path === "/" ? "/" : `${path}/`);
  };

  const context = {
    n: numbers,
    positioning,
    consent: {
      text: consent,
      html: `<pre class="statement" tabindex="0">${escapeHtml(consent)}</pre>`,
    },
    captures,
    install: { command: INSTALL_COMMAND, version: cliVersion },
    repository: REPOSITORY_URL,
  };

  // The landing and the install page: hand-set, filled from the sources.
  for (const [path, file, section] of [
    ["/", "index.html", "home"],
    ["/install", "install.html", "install"],
  ]) {
    const template = readFileSync(
      join(SITE_ROOT, "src", "pages", file),
      "utf8",
    );
    const titleMatch = /^<!--\s*title:\s*(.+?)\s*-->/m.exec(template);
    const descriptionMatch = /^<!--\s*description:\s*(.+?)\s*-->/m.exec(
      template,
    );
    if (titleMatch === null || descriptionMatch === null) {
      fail(`${file} needs a title and a description comment`);
    }
    page(path, {
      title: titleMatch[1],
      description: descriptionMatch[1],
      section,
      body: render(template, context),
    });
  }

  // The docs: this repository's own files, rendered as they are.
  const docs = [];
  for (const slug of DOCS_ORDER) {
    const fromRepository = DOCS_FROM_REPOSITORY[slug];
    const source =
      fromRepository === undefined
        ? join(SITE_ROOT, "content", "docs", `${slug}.md`)
        : join(REPO_ROOT, fromRepository);
    if (!existsSync(source)) {
      fail(`no source for the docs page ${slug}`);
    }
    const markdown = render(readFileSync(source, "utf8"), context);
    const title = titleOf(markdown, slug);
    docs.push({ slug, title, description: descriptionOf(markdown) });
    const body = `<article class="doc">${await marked.parse(markdown)}</article>`;
    page(`/docs/${slug}`, {
      title: `${title} · REFLEX docs`,
      description: descriptionOf(markdown),
      section: "docs",
      body,
    });
  }
  const index = [
    '<article class="doc">',
    "<h1>Documentation</h1>",
    "<p>What you need to install, trust and operate REFLEX. Every command and every policy example on these pages is run by a test in the repository that builds them; a number that is not measured is not here.</p>",
    '<ol class="toc">',
    ...docs.map(
      (doc) =>
        `<li><a href="/docs/${doc.slug}/">${escapeHtml(doc.title)}</a><span>${escapeHtml(doc.description)}</span></li>`,
    ),
    "</ol>",
    "</article>",
  ].join("\n");
  page("/docs", {
    title: "Documentation · REFLEX",
    description:
      "Install, trust and operate REFLEX: quick start, decisions, modes, the policy language, team policy, hosts, the threat model, storage, troubleshooting.",
    section: "docs",
    body: index,
  });

  writeFileSync(
    join(out, "sitemap.txt"),
    pages.map((path) => `${SITE_ORIGIN}${BASE_PATH}${path}`).join("\n") + "\n",
  );
  return {
    out,
    basePath: BASE_PATH,
    pages,
    numbers,
    captures: Object.keys(captures),
    docs: docs.map((doc) => doc.slug),
  };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await build(process.argv[2]);
  process.stdout.write(
    `built ${String(result.pages.length)} pages into ${result.out}\n`,
  );
}
