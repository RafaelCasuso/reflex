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
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readText, repoPath } from "./support/repo.js";

/**
 * RFX-150, RFX-137 — the public site says only what the repository
 * measured, in the words the repository already uses, and nothing on it
 * reaches out before consent.
 *
 * The site is built into a temporary directory by the same script the
 * workflow runs, and every claim is checked here against its source, by a
 * second reading of that source: not against what the build script says it
 * read.
 */
const SITE_SOURCES = {
  bench: "apps/decision-gateway/bench/results/apple-m1-max-node24.json",
  hook: "docs/claude-code-hook.md",
  product: "docs/product.md",
  consent: "packages/semantic-provider/dist/consent.js",
  goldenCorpus: "packages/evals/corpus/v1",
  semanticCorpus: "packages/evals/corpus/semantic/v1",
  injection: "packages/evals/corpus/semantic/injection-v1.json",
} as const;

interface Percentiles {
  readonly p50: number;
  readonly p95: number;
}
interface BenchRecord {
  readonly cases: readonly {
    readonly label: string;
    readonly overSocketHitMs: Percentiles;
    readonly overSocketMissMs: Percentiles;
    readonly endToEndNetClientMs: Percentiles;
  }[];
  readonly policy: { readonly rules: number };
}

let out: string;
const page = (path: string): string =>
  readFileSync(join(out, path, "index.html"), "utf8");

function casesIn(directory: string): number {
  return readdirSync(repoPath(directory))
    .filter((file) => file.endsWith(".json"))
    .reduce((total, file) => {
      const parsed = JSON.parse(readText(directory, file)) as {
        cases?: unknown[];
      };
      return total + (parsed.cases?.length ?? 0);
    }, 0);
}

beforeAll(() => {
  // Built packages are needed for the consent statement; turbo builds them
  // before this suite runs (test depends on build).
  expect(existsSync(repoPath(SITE_SOURCES.consent)), "pnpm build first").toBe(
    true,
  );
  out = mkdtempSync(join(tmpdir(), "reflex-site-"));
  execFileSync(process.execPath, [repoPath("site", "src", "build.mjs"), out], {
    stdio: "pipe",
  });
});

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

describe("RFX-150 the public landing and install page", () => {
  it("builds the landing, the install page, the docs index and every docs page", () => {
    for (const path of [
      "",
      "install",
      "docs",
      "docs/quick-start",
      "docs/policy-language",
      "docs/threat-model",
      "docs/troubleshooting",
    ]) {
      expect(existsSync(join(out, path, "index.html")), path).toBe(true);
    }
  });

  it("states the positioning of ADR-017 in the paragraph docs/product.md states it in", () => {
    const product = readText(SITE_SOURCES.product);
    const start = product.indexOf("**More autonomy. Less supervision.**");
    const paragraph = product
      .slice(start)
      .split("\n\n")[1]
      ?.replaceAll("\n", " ")
      .trim();
    expect(paragraph).toBeDefined();
    expect(paragraph).toContain("one policy");
    expect(page("")).toContain(escape(paragraph ?? ""));
    // Beside the host, never in its place (ADR-017 §2), in those words.
    expect(page("")).toContain("never in its place");
    expect(page("")).toContain("REFLEX does not replace them");
  });

  it("quotes the consent statement of RFX-123 exactly as rfx provider shows it", async () => {
    const consent = (await import(
      pathToFileURL(repoPath(SITE_SOURCES.consent)).href
    )) as {
      consentStatement: (provider: string) => string;
    };
    expect(page("")).toContain(escape(consent.consentStatement("jev")));
  });

  it("links the threat model", () => {
    expect(page("")).toContain('href="/docs/threat-model/"');
    expect(page("docs/threat-model")).toContain("REFLEX is not a sandbox");
  });

  it("leads to rfx init: the one install command, the same on the landing, the install page and in CI", () => {
    const command = "npm install -g @reflex-control/cli && rfx init";
    expect(page("")).toContain(escape(command));
    expect(page("install")).toContain(escape(command));
    expect(readText("tools", "site", "install-command-check.sh")).toContain(
      command,
    );
    expect(readText(".github", "workflows", "site.yml")).toContain(
      "bash tools/site/install-command-check.sh",
    );
  });

  it("takes every number on the landing from a file in this repository", () => {
    const landing = page("");
    const bench = JSON.parse(readText(SITE_SOURCES.bench)) as BenchRecord;
    const typical = bench.cases.find((entry) => entry.label === "typical read");
    expect(typical).toBeDefined();
    if (typical === undefined) {
      return;
    }
    const ms = (value: number) => `${value.toFixed(1)} ms`;
    for (const value of [
      ms(typical.overSocketHitMs.p95),
      ms(typical.overSocketMissMs.p95),
      ms(typical.endToEndNetClientMs.p50),
      ms(typical.endToEndNetClientMs.p95),
    ]) {
      expect(landing).toContain(`<td class="n">${value}</td>`);
    }
    // Prettier may wrap the template between the number and the word.
    expect(landing).toMatch(
      new RegExp(`${String(bench.policy.rules)}\\s+rules`),
    );

    const hookRow = readText(SITE_SOURCES.hook)
      .split("\n")
      .find((line) => line.startsWith("| Hook, `PreToolUse`"));
    expect(hookRow).toBeDefined();
    const cells = (hookRow ?? "")
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell !== "");
    expect(landing).toContain(`<td class="n">${cells[2] ?? ""}</td>`);
    expect(landing).toContain(`<td class="n">${cells[3] ?? ""}</td>`);

    expect(landing).toContain(
      `corpus of ${String(casesIn(SITE_SOURCES.goldenCorpus))} shell`,
    );
    expect(landing).toContain(
      `semantic corpus of ${String(casesIn(SITE_SOURCES.semanticCorpus))} cases`,
    );
    const injection = JSON.parse(readText(SITE_SOURCES.injection)) as {
      pairs: unknown[];
    };
    expect(landing).toContain(
      `${String(injection.pairs.length)} prompt-injection pairs`,
    );
  });

  // Adversarial: a number typed into the page by hand, with no source, is
  // what this ticket forbids. Every "ms" on the landing must be one the
  // sources produced.
  it("has no millisecond figure the sources did not produce", () => {
    const landing = page("");
    const bench = JSON.parse(readText(SITE_SOURCES.bench)) as BenchRecord;
    const typical = bench.cases.find((entry) => entry.label === "typical read");
    const hookRow =
      readText(SITE_SOURCES.hook)
        .split("\n")
        .find((line) => line.startsWith("| Hook, `PreToolUse`")) ?? "";
    const allowed = new Set([
      ...(typical === undefined
        ? []
        : [
            typical.overSocketHitMs.p95,
            typical.overSocketMissMs.p95,
            typical.endToEndNetClientMs.p50,
            typical.endToEndNetClientMs.p95,
          ].map((value) => `${value.toFixed(1)} ms`)),
      ...[...hookRow.matchAll(/(\d+\.\d) ms/g)].map(
        (match) => `${match[1] ?? ""} ms`,
      ),
    ]);
    for (const [figure] of landing.matchAll(/\d+(?:\.\d+)? ms/g)) {
      expect(allowed.has(figure), `${figure} has no source`).toBe(true);
    }
  });

  it("shows real terminal captures, each starting with the command that was run, and no image pretending to be one", () => {
    const captures = readdirSync(repoPath("site", "captures")).filter((file) =>
      file.endsWith(".txt"),
    );
    expect(captures.length).toBeGreaterThanOrEqual(8);
    for (const file of captures) {
      const text = readText("site", "captures", file);
      expect(text.startsWith("$ rfx "), file).toBe(true);
      expect(text, file).not.toMatch(
        /\/Users\/|\/home\/[a-z]|\/private\/var|\/var\/folders/,
      );
    }
    expect(page("")).toContain('<pre class="terminal"');
    expect(page("")).not.toMatch(/<img|<picture|<video|<canvas/);
    expect(page("install")).not.toMatch(/<img|<picture|<video|<canvas/);
    expect(readText("tools", "site", "capture.sh")).toContain(
      "rfx explain git push --force",
    );
  });

  it("runs no script and makes no request to a third party, on any page", () => {
    for (const file of walk(out)) {
      const html = readFileSync(file, "utf8");
      expect(html, file).not.toMatch(/<script/i);
      for (const match of html.matchAll(/\s(?:src|href)="(https?:[^"]+)"/g)) {
        const url = match[1] ?? "";
        // Links a reader may follow are fine; resources the browser fetches
        // are not. A stylesheet, font or image from elsewhere would be a
        // request before consent.
        expect(html, url).not.toMatch(
          new RegExp(
            `<link[^>]+href="${url.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
          ),
        );
      }
      expect(html).not.toMatch(/<link[^>]+href="https?:/);
      expect(html).not.toMatch(/url\(["']?https?:/);
    }
    const css = readdirSync(out).find((file) => file.endsWith(".css")) ?? "";
    expect(css).not.toBe("");
    expect(readFileSync(join(out, css), "utf8")).not.toMatch(
      /url\(["']?https?:/,
    );
    expect(
      existsSync(
        join(out, "fonts", "bricolage-grotesque-latin-wght-normal.woff2"),
      ),
    ).toBe(true);
  });

  it("has no broken internal link, by the same check the workflow runs", () => {
    const result = execFileSync(
      process.execPath,
      [repoPath("site", "src", "check-links.mjs"), out],
      { encoding: "utf8" },
    );
    expect(result).toMatch(/, 0 broken link\(s\)/);
  });

  it("is deployed by a workflow that builds, checks links and measures Lighthouse before publishing", () => {
    const site = readText(".github", "workflows", "site.yml");
    expect(site).toContain("node site/src/build.mjs");
    expect(site).toContain("node site/src/check-links.mjs");
    expect(site).toContain("treosh/lighthouse-ci-action@");
    const lighthouse = JSON.parse(readText(".lighthouserc.json")) as {
      ci: {
        collect: { url: string[]; staticDistDir: string };
        assert: { assertions: Record<string, [string, { minScore: number }]> };
      };
    };
    expect(lighthouse.ci.collect.staticDistDir).toBe("./site/dist");
    expect(lighthouse.ci.collect.url).toEqual(["/", "/install/"]);
    for (const category of [
      "performance",
      "accessibility",
      "best-practices",
      "seo",
    ]) {
      expect(lighthouse.ci.assert.assertions[`categories:${category}`]).toEqual(
        ["error", { minScore: 0.9 }],
      );
    }
    const pages = readText(".github", "workflows", "pages.yml");
    expect(pages).toContain("node site/src/build.mjs");
    expect(pages).toContain("node site/src/check-links.mjs");
    expect(pages).toContain("actions/deploy-pages@");
  });
});

describe("RFX-137 the documentation", () => {
  const required = {
    "quick-start": ["rfx init", "rfx explain", "rfx trust", "rfx mode"],
    decisions: [
      "Normalize",
      "Redact",
      "Mandates hold from above",
      "fail-closed",
      "rfx override",
    ],
    modes: ["Observe", "Assist", "Autopilot", "fail-ask", "rfx pause"],
    "policy-language": ["## 4. Operators", "## 13. Environments"],
    "team-policy": [
      "rfx policy keygen",
      "rfx policy snapshot",
      "rfx policy subscribe",
    ],
    hosts: [
      "Verified against the real binary",
      "not yet verified live",
      "PreToolUse",
      "PermissionRequest",
    ],
    "threat-model": ["REFLEX is not a sandbox"],
    stored: ["seven days", "never their values", "--purge"],
    troubleshooting: ["rfx doctor", "--json"],
  } as const;

  it.each(Object.entries(required))("covers %s", (slug, phrases) => {
    const html = page(join("docs", slug));
    for (const phrase of phrases) {
      expect(html, phrase).toContain(escape(phrase).replace("## ", ""));
    }
  });

  it("publishes the policy reference and the threat model from the repository's own files, unchanged", () => {
    const reference = readText("docs", "policy-language.md");
    const threat = readText("docs", "security.md");
    // The first heading of each, and a late paragraph of each: the whole
    // file is rendered, not a summary of it.
    expect(page("docs/policy-language")).toContain("The policy set hash");
    expect(page("docs/policy-language")).toContain(
      escape("Matching is unanchored"),
    );
    expect(reference).toContain("Matching is unanchored");
    expect(page("docs/threat-model")).toContain("Keeping this document true");
    expect(threat).toContain("Keeping this document true");
  });

  // RFX-137: troubleshooting mirrors rfx doctor. Every check the doctor
  // can print, by its name, is explained on the page.
  it("names every check of rfx doctor in the troubleshooting page", () => {
    const doctor = readText("packages", "cli", "src", "commands", "doctor.ts");
    const names = new Set(
      [
        ...doctor.matchAll(
          /check\(\s*"(?:install|hosts|daemon|policy|provider|state)",\s*"([^"]+)"/g,
        ),
      ].map((match) => match[1] ?? ""),
    );
    expect(names.size).toBeGreaterThanOrEqual(12);
    const html = page("docs/troubleshooting");
    for (const name of names) {
      expect(html, name).toContain(`<strong>${escape(name)}</strong>`);
    }
    // The dynamic ones, by host.
    for (const name of ["claude-code hooks", "codex hooks"]) {
      expect(html).toContain(`<strong>${name}</strong>`);
    }
  });

  it("lists every docs page in the index, in order", () => {
    const index = page("docs");
    const toc = index.slice(
      index.indexOf('<ol class="toc">'),
      index.indexOf("</ol>"),
    );
    const slugs = [...toc.matchAll(/href="\/docs\/([a-z-]+)\/"/g)].map(
      (match) => match[1],
    );
    expect(slugs).toEqual([
      "quick-start",
      "decisions",
      "modes",
      "policy-language",
      "team-policy",
      "hosts",
      "threat-model",
      "stored",
      "troubleshooting",
    ]);
  });

  it("has the docs' commands run by the CLI's end-to-end suite", () => {
    const suite = readText(
      "packages",
      "cli",
      "src",
      "site-commands.e2e.test.ts",
    );
    expect(suite).toContain("site/content/docs/");
    expect(suite).toContain('block.language !== "sh"');
  });
});

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(path));
    } else if (entry.name.endsWith(".html")) {
      found.push(path);
    }
  }
  return found;
}
