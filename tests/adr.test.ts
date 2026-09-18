import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { readText, repoPath } from "./support/repo.js";

/**
 * RFX-004 — ADRs are discoverable and the template carries
 * context / decision / consequences.
 */
const ADR_DIR = ["docs", "adr"] as const;
const TEMPLATE = "ADR-000-template.md";
const ADR_FILE = /^ADR-(\d{3})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const REQUIRED_SECTIONS = ["## Context", "## Decision", "## Consequences"];
const STATUS =
  /^(Proposed|Accepted|Rejected|Deprecated|Superseded by ADR-\d{3})$/;

const files = readdirSync(repoPath(...ADR_DIR)).filter(
  (file) => file.startsWith("ADR-") && file.endsWith(".md"),
);
const records = files.filter((file) => file !== TEMPLATE).sort();
const index = readText(...ADR_DIR, "README.md");

function statusOf(markdown: string): string | undefined {
  return /^- \*\*Status:\*\* (.+)$/m.exec(markdown)?.[1]?.trim();
}

function hasHeading(markdown: string, heading: string): boolean {
  return markdown.split("\n").some((line) => line.trim() === heading);
}

describe("RFX-004 ADR framework", () => {
  it("has a template with context, decision and consequences", () => {
    const template = readText(...ADR_DIR, TEMPLATE);
    for (const section of REQUIRED_SECTIONS) {
      expect(hasHeading(template, section), section).toBe(true);
    }
    expect(statusOf(template)).toBe("Proposed");
  });

  it("is reachable from the README and the architecture document", () => {
    expect(readText("README.md")).toContain("docs/adr/");
    expect(readText("docs", "architecture.md")).toContain("adr/README.md");
    expect(index).toContain(`(./${TEMPLATE})`);
  });

  it("uses well-formed, never-reused ADR numbers", () => {
    for (const file of files) {
      expect(file, "ADR-NNN-kebab-title.md").toMatch(ADR_FILE);
    }
    const numbers = files.map((file) => ADR_FILE.exec(file)?.[1]);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("contains at least ADR-001", () => {
    expect(records).toContain("ADR-001-canonical-action-model.md");
  });

  describe.each(records)("%s", (file) => {
    const markdown = readText(...ADR_DIR, file);
    const id = file.slice(0, "ADR-000".length);

    it("has a title carrying its own ID", () => {
      expect(markdown.split("\n")[0]).toMatch(new RegExp(`^# ${id}: \\S`));
    });

    it("has context, decision and consequences", () => {
      for (const section of REQUIRED_SECTIONS) {
        expect(hasHeading(markdown, section), section).toBe(true);
      }
    });

    it("declares a valid status", () => {
      expect(statusOf(markdown)).toMatch(STATUS);
    });

    // An index that lies is worse than no index: a reader trusts
    // "Accepted" without opening the file.
    it("is linked from the index with the same status", () => {
      const row = index
        .split("\n")
        .find((line) => line.includes(`(./${file})`));

      expect(row, `${file} is missing from docs/adr/README.md`).toBeDefined();
      expect(row).toContain(`| ${statusOf(markdown) ?? "<no status>"} `);
    });
  });
});

/** RFX-005 — ADR-001 explains inclusions, exclusions and the escape hatch. */
describe("RFX-005 ADR-001 canonical action model", () => {
  const adr = readText(...ADR_DIR, "ADR-001-canonical-action-model.md");
  const contracts = readText("packages", "contracts", "src", "action.ts");

  it("covers inclusions, exclusions and the adapter metadata escape hatch", () => {
    expect(adr).toMatch(/^### \d+\. Inclusions$/m);
    expect(adr).toMatch(/^### \d+\. Exclusions$/m);
    expect(adr).toMatch(/^### \d+\. The adapter metadata escape hatch$/m);
  });

  // The ADR freezes a boundary, so it must not drift from the contract it
  // describes: every top-level CanonicalAction field is accounted for.
  it("accounts for every field of CanonicalAction", () => {
    const body = /export interface CanonicalAction \{([\s\S]*?)\n\}/.exec(
      contracts,
    )?.[1];
    expect(body, "CanonicalAction not found in contracts").toBeDefined();

    const fields = [...(body ?? "").matchAll(/^ {2}(\w+)\??:/gm)]
      .map((match) => match[1])
      .filter((field): field is string => field !== undefined);
    expect(fields.length).toBeGreaterThan(10);

    for (const field of fields) {
      expect(adr, `ADR-001 does not mention "${field}"`).toContain(
        `\`${field}`,
      );
    }
  });
});
