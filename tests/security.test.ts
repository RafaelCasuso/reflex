import { describe, expect, it } from "vitest";

import { readText } from "./support/repo.js";

/**
 * RFX-101 — the threat model stays tied to the backlog.
 *
 * The ticket's acceptance is that every adversary has at least one mitigation
 * mapped to a ticket, or is listed as an accepted risk, and that the document
 * says plainly that REFLEX is not a sandbox. A mitigation that points at a
 * ticket nobody owns is a promise nobody keeps, so the references are checked
 * against the backlog.
 */
const security = readText("docs", "security.md");
const backlog = readText("docs", "backlog.md");

/** The adversaries RFX-101 names, in its words. */
const ADVERSARIES = [
  "The governed agent",
  "Prompt-injected content",
  "A malicious repository",
  "A malicious MCP server",
  "A network attacker",
  "A compromised dependency",
] as const;

const knownTickets = new Set(
  [...backlog.matchAll(/^### (RFX-\d{3}) /gm)].map((match) => match[1]),
);

/** The text of one adversary's section, up to the next heading of any level. */
function sectionOf(adversary: string): string {
  const heading = new RegExp(`^### \\d+\\. ${adversary}$`, "m").exec(security);
  if (heading === null) {
    return "";
  }
  const rest = security.slice(heading.index + heading[0].length);
  const next = /^#{2,3} /m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

describe("RFX-101 threat model", () => {
  it("says plainly that REFLEX is not a sandbox", () => {
    expect(security).toMatch(/^## REFLEX is not a sandbox$/m);
    expect(security).toContain("It does not contain an action once it runs");
  });

  it("covers assets, trust boundaries and explicit non-goals", () => {
    for (const heading of [
      "## Assets",
      "## Adversaries",
      "## Trust boundaries",
      "## Non-goals",
    ]) {
      expect(security.split("\n"), heading).toContain(heading);
    }
  });

  it("names exactly the adversaries the ticket lists", () => {
    const named = [...security.matchAll(/^### \d+\. (.+)$/gm)].map(
      (match) => match[1],
    );
    expect(named).toEqual([...ADVERSARIES]);
  });

  describe.each(ADVERSARIES)("%s", (adversary) => {
    const section = sectionOf(adversary);
    const mitigationRows = section
      .split("\n")
      .filter(
        (line) => line.startsWith("|") && /RFX-\d{3}|ADR-\d{3}/.test(line),
      );

    it("has at least one mitigation mapped to a ticket", () => {
      const tickets = mitigationRows.flatMap((row) => [
        ...row.matchAll(/RFX-\d{3}/g),
      ]);
      expect(tickets.length).toBeGreaterThan(0);
    });

    it("maps every mitigation to something that exists", () => {
      for (const row of mitigationRows) {
        for (const [ticket] of row.matchAll(/RFX-\d{3}/g)) {
          expect(knownTickets.has(ticket), `${ticket} in: ${row}`).toBe(true);
        }
      }
    });

    it("says what it accepts instead of pretending to cover everything", () => {
      expect(section).toContain("**Accepted risk:**");
    });
  });

  it("cites no ticket that the backlog does not have", () => {
    for (const [ticket] of security.matchAll(/RFX-\d{3}/g)) {
      expect(knownTickets.has(ticket), ticket).toBe(true);
    }
  });
});
