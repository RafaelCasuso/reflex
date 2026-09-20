import { describe, expect, it } from "vitest";

import {
  POLICY_LIMITS,
  parsePolicy,
  type PolicyIssue,
  type PolicyIssueCode,
} from "./parser.js";

/** RFX-012 — the v1 policy document parser. */
const VALID = `# A starter policy
version: 1
defaults:
  unresolved: ask
rules:
  - id: allow-git-reads
    name: Git commands that only read
    effect: allow
    conditions:
      - field: command.name
        operator: equals
        value: git
      - field: command.args
        operator: in
        value: [status, diff, log]

  - id: never-touch-production
    name: Production needs a human
    effect: ask
    mandatory: true
    conditions:
      - field: environment
        operator: equals
        value: production

  - id: deny-secret-in-command
    name: No tokens on the command line
    effect: deny
    conditions:
      - field: command.text
        operator: matches
        value: "sk-live-[0-9a-f]{12}"
      - field: tool.namespace
        operator: exists
`;

function issuesOf(source: string): readonly PolicyIssue[] {
  const result = parsePolicy(source);
  return result.ok ? [] : result.issues;
}

/** Replaces one line of the valid policy, so every other line stays in place. */
function withLine(lineNumber: number, replacement: string): string {
  const lines = VALID.split("\n");
  lines[lineNumber - 1] = replacement;
  return lines.join("\n");
}

describe("RFX-012 policy parser", () => {
  it("parses a valid policy into the contract's document", () => {
    const result = parsePolicy(VALID);
    expect(result).toEqual({
      ok: true,
      document: {
        version: 1,
        defaults: { unresolved: "ask" },
        rules: [
          {
            id: "allow-git-reads",
            name: "Git commands that only read",
            effect: "allow",
            conditions: [
              { field: "command.name", operator: "equals", value: "git" },
              {
                field: "command.args",
                operator: "in",
                value: ["status", "diff", "log"],
              },
            ],
          },
          {
            id: "never-touch-production",
            name: "Production needs a human",
            effect: "ask",
            mandatory: true,
            conditions: [
              { field: "environment", operator: "equals", value: "production" },
            ],
          },
          {
            id: "deny-secret-in-command",
            name: "No tokens on the command line",
            effect: "deny",
            conditions: [
              {
                field: "command.text",
                operator: "matches",
                value: "sk-live-[0-9a-f]{12}",
              },
              { field: "tool.namespace", operator: "exists" },
            ],
          },
        ],
      },
    });
  });

  it("accepts the smallest policy there is, and declares no default for it", () => {
    // ADR-004 §6: a source that declares nothing is not a source that says ask.
    expect(parsePolicy("version: 1\nrules: []\n")).toEqual({
      ok: true,
      document: { version: 1, rules: [] },
    });
  });

  it("reads a host's own arguments, which may hold numbers and booleans", () => {
    const result = parsePolicy(`version: 1
rules:
  - id: no-force
    name: No forced pushes through the MCP server
    effect: deny
    conditions:
      - field: arguments.options.force
        operator: equals
        value: true
      - field: arguments.retries
        operator: in
        value: [1, 2, 3]
`);
    expect(result.ok).toBe(true);
  });

  // The acceptance: invalid input produces actionable line and path errors.
  describe("says where and what", () => {
    it.each<[string, number, string, PolicyIssueCode, string, RegExp]>([
      [
        "a misspelt operator",
        11,
        "        operator: equls",
        "unknown_operator",
        "rules[0].conditions[0].operator",
        /unknown operator equls; the operators are: equals, not_equals/,
      ],
      [
        "a misspelt field",
        10,
        "      - field: comand.name",
        "unknown_field",
        "rules[0].conditions[0].field",
        /unknown field comand\.name; a rule can be written about: tool\.name/,
      ],
      [
        "a misspelt effect",
        8,
        "    effect: alow",
        "invalid_value",
        "rules[0].effect",
        /effect must be one of: allow, ask, deny; got alow/,
      ],
      [
        "a misspelt key",
        7,
        "    nmae: Git commands that only read",
        "unknown_key",
        "rules[0].nmae",
        /unknown key nmae; a rule has: id, name, effect, mandatory, conditions/,
      ],
      [
        "a value outside a closed set",
        24,
        "        value: prod",
        "invalid_value",
        "rules[1].conditions[0].value",
        /environment is one of: .*production.*; got prod/,
      ],
      [
        "an unknown default",
        4,
        "  unresolved: allow",
        "invalid_value",
        "defaults.unresolved",
        /unresolved must be one of: semantic, ask, deny; got allow/,
      ],
      [
        "a version that is not the number 1",
        2,
        'version: "1"',
        "invalid_value",
        "version",
        /version must be the number 1/,
      ],
      [
        "a rule id that is not a slug",
        6,
        "  - id: Allow Git Reads",
        "invalid_value",
        "rules[0].id",
        /id must be lower-case letters/,
      ],
      [
        "a text operator on a closed set",
        23,
        "        operator: starts_with",
        "invalid_value",
        "rules[1].conditions[0].operator",
        /starts_with works on text; environment is one of a fixed set/,
      ],
      [
        "an unquoted number where text is expected",
        12,
        "        value: 42",
        "invalid_type",
        "rules[0].conditions[0].value",
        /command\.name is text: quote the value/,
      ],
    ])("%s", (_label, line, replacement, code, path, message) => {
      const issues = issuesOf(withLine(line, replacement));
      // A misspelt key also leaves its rule without the real one.
      const issue = issues.find((candidate) => candidate.code === code);
      expect(issue).toMatchObject({ code, path, line });
      expect(issue?.message).toMatch(message);
      expect(issue?.column).toBeGreaterThan(0);
    });

    it("reports every problem at once, not the first one", () => {
      const issues = issuesOf(
        withLine(8, "    effect: alow").replace(
          "operator: in",
          "operator: inn",
        ),
      );
      expect(issues.map((issue) => issue.code).sort()).toEqual([
        "invalid_value",
        "unknown_operator",
      ]);
    });

    it("points at the line of a YAML syntax error", () => {
      const issues = issuesOf("version: 1\nrules:\n  - id: [unclosed\n");
      expect(issues[0]).toMatchObject({ code: "invalid_yaml" });
      expect(issues[0]?.line).toBeGreaterThanOrEqual(3);
    });

    it("says where a duplicate id was first used", () => {
      const issues = issuesOf(withLine(17, "  - id: allow-git-reads"));
      expect(issues).toMatchObject([
        { code: "duplicate_id", path: "rules[1].id", line: 17 },
      ]);
      expect(issues[0]?.message).toContain("already used on line 6");
    });

    it.each([
      ["version", "rules: []\n", "a policy needs version: 1"],
      ["rules", "version: 1\n", "a policy needs rules"],
    ])("names a missing %s", (_key, source, message) => {
      expect(issuesOf(source)).toMatchObject([{ code: "missing_key" }]);
      expect(issuesOf(source)[0]?.message).toContain(message);
    });

    it("names every key a rule is missing", () => {
      const issues = issuesOf("version: 1\nrules:\n  - mandatory: true\n");
      expect(issues.map((issue) => issue.message)).toEqual([
        "a rule needs id",
        "a rule needs name",
        "a rule needs effect",
        "a rule needs conditions",
      ]);
      expect(issues.every((issue) => issue.line === 3)).toBe(true);
    });
  });

  describe("operators and their values", () => {
    const rule = (condition: string): string => `version: 1
rules:
  - id: r
    name: R
    effect: deny
    conditions:
      - ${condition}
`;
    it.each([
      [
        "exists with a value",
        "{ field: path, operator: exists, value: x }",
        /exists takes no value/,
      ],
      [
        "equals without a value",
        "{ field: path, operator: equals }",
        /equals needs a value/,
      ],
      [
        "in without a list",
        "{ field: path, operator: in, value: x }",
        /non-empty list/,
      ],
      [
        "in with an empty list",
        "{ field: path, operator: in, value: [] }",
        /non-empty list/,
      ],
      [
        "in with a nested list",
        "{ field: path, operator: in, value: [[a]] }",
        /single value/,
      ],
      [
        "an empty prefix, which would match everything",
        '{ field: path, operator: starts_with, value: "" }',
        /must not be empty/,
      ],
      [
        "a list where one value is expected",
        "{ field: path, operator: equals, value: [a] }",
        /single value/,
      ],
      [
        "a mapping where a value is expected",
        "{ field: path, operator: equals, value: { a: b } }",
        /single value/,
      ],
      [
        "a null value",
        "{ field: path, operator: equals, value: null }",
        /text: quote the value/,
      ],
      ["no field", "{ operator: exists }", /a condition needs a field/],
      ["no operator", "{ field: path }", /a condition needs an operator/],
      [
        "a raw argument path that is not one",
        "{ field: arguments., operator: exists }",
        /unknown field/,
      ],
      [
        "a raw argument path with a segment that is not a key",
        '{ field: "arguments.a b.c", operator: exists }',
        /unknown field/,
      ],
    ])("rejects %s", (_label, condition, message) => {
      const issues = issuesOf(rule(condition));
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.map((issue) => issue.message).join("\n")).toMatch(message);
    });
  });

  // Adversarial: every way a policy file could quietly mean something else,
  // or cost more than a policy should.
  describe("adversarial", () => {
    // ADR-004 §2: a floor of allow is no floor. Its only use would be to
    // force something through.
    it("rejects a mandatory allow", () => {
      const issues = issuesOf(
        withLine(8, "    effect: allow\n    mandatory: true"),
      );
      expect(issues).toMatchObject([
        { code: "invalid_value", path: "rules[0].mandatory" },
      ]);
      expect(issues[0]?.message).toContain("an allow rule cannot be mandatory");
    });

    // RFX-098: a pattern is rejected when the policy is compiled, with the
    // line it is on, and never discovered to be slow at match time.
    it.each([
      ["a backreference", "(a)\\1", /backreferences are not supported/],
      ["a lookahead", "a(?=b)", /lookaheads and lookbehinds/],
      ["a pattern too complex to bound", "[a-z0-9]{1,500}", /too complex/],
      ["a pattern that is not one", "(unclosed", /not a valid regular/],
    ])("rejects %s at its line", (_label, pattern, message) => {
      const issues = issuesOf(withLine(32, `        value: '${pattern}'`));
      expect(issues).toMatchObject([
        {
          code: "invalid_value",
          path: "rules[2].conditions[0].value",
          line: 32,
        },
      ]);
      expect(issues[0]?.message).toMatch(message);
    });

    it("rejects a rule with no condition, which would match everything", () => {
      const issues = issuesOf(
        "version: 1\nrules:\n  - { id: all, name: All, effect: allow, conditions: [] }\n",
      );
      expect(issues).toMatchObject([{ path: "rules[0].conditions" }]);
      expect(issues[0]?.message).toContain("defaults.unresolved");
    });

    it("rejects a truthy string for mandatory", () => {
      expect(issuesOf(withLine(20, '    mandatory: "true"'))).toMatchObject([
        { code: "invalid_type", path: "rules[1].mandatory" },
      ]);
    });

    // YAML 1.1 reads `no`, `off` and `yes` as booleans. A policy that says
    // `mandatory: yes` must not be read by one YAML and ignored by another.
    it("reads YAML 1.2 only: yes, no, on and off are words", () => {
      expect(issuesOf(withLine(20, "    mandatory: yes"))).toMatchObject([
        { code: "invalid_type" },
      ]);
    });

    it("rejects a duplicated key instead of letting the last one win", () => {
      const issues = issuesOf(
        withLine(8, "    effect: deny\n    effect: allow"),
      );
      expect(issues).toMatchObject([{ code: "invalid_yaml" }]);
      expect(issues[0]?.message).toMatch(/unique/i);
    });

    it.each([
      ["an alias", "version: 1\nrules: &r []\nextra: *r\n"],
      ["an anchor", "version: &v 1\nrules: []\n"],
      ["a merge key", "version: 1\nrules: []\n<<: { version: 2 }\n"],
      ["a custom tag", "version: 1\nrules: !!js/function []\n"],
      ["a binary tag", "version: 1\nrules: !!binary aGVsbG8=\n"],
    ])("refuses %s", (_label, source) => {
      expect(parsePolicy(source).ok).toBe(false);
    });

    it("refuses an alias bomb without expanding it", () => {
      const bomb = [
        "a: &a [x, x, x, x, x, x, x, x, x]",
        ...Array.from({ length: 12 }, (_, index) => {
          const current = String.fromCodePoint(98 + index);
          const previous = String.fromCodePoint(97 + index);
          return `${current}: &${current} [${Array.from({ length: 9 }, () => `*${previous}`).join(", ")}]`;
        }),
        "version: 1",
        "rules: []",
      ].join("\n");
      const started = performance.now();
      const result = parsePolicy(bomb);
      expect(result.ok).toBe(false);
      expect(performance.now() - started).toBeLessThan(500);
    });

    it("refuses a second document in the same file", () => {
      expect(
        parsePolicy("version: 1\nrules: []\n---\nversion: 1\nrules: []\n").ok,
      ).toBe(false);
    });

    it.each([
      ["an empty file", ""],
      ["only a comment", "# nothing here\n"],
      ["a list at the top", "- version: 1\n"],
      ["a bare string", "allow everything\n"],
      ["null", "null\n"],
    ])("refuses %s", (_label, source) => {
      const issues = issuesOf(source);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]?.message).toContain("a policy must be a mapping");
    });

    it("refuses a file that is too large before parsing it", () => {
      const huge = `version: 1\nrules: []\n# ${"x".repeat(POLICY_LIMITS.sourceBytes)}\n`;
      expect(issuesOf(huge)).toMatchObject([{ code: "too_large" }]);
    });

    it("bounds conditions, list values and the number of issues", () => {
      const condition = "{ field: path, operator: exists }";
      const head =
        "version: 1\nrules:\n  - id: r\n    name: R\n    effect: deny\n";
      const tooManyConditions = `${head}    conditions: [${Array.from(
        { length: POLICY_LIMITS.conditionsPerRule + 1 },
        () => condition,
      ).join(", ")}]\n`;
      expect(issuesOf(tooManyConditions)).toMatchObject([{ code: "too_many" }]);

      const tooManyValues = `${head}    conditions:\n      - { field: path, operator: in, value: [${Array.from(
        { length: POLICY_LIMITS.listValues + 1 },
        (_, index) => `"v${String(index)}"`,
      ).join(", ")}] }\n`;
      expect(issuesOf(tooManyValues)).toMatchObject([{ code: "too_many" }]);

      const manyBadRules = `version: 1\nrules:\n${Array.from(
        { length: 200 },
        () => "  - nope: 1\n",
      ).join("")}`;
      expect(issuesOf(manyBadRules)).toHaveLength(POLICY_LIMITS.issues);
    });

    it("never throws, whatever it is given", () => {
      const byteOrderMark = String.fromCodePoint(0xfeff);
      for (const source of [
        String.fromCodePoint(0, 1, 2),
        "\t\tversion: 1",
        `${byteOrderMark}version: 1\nrules: []\n`,
        `version: 1\nrules: [${"[".repeat(5_000)}`,
        "{".repeat(10_000),
        "? [complex, key]\n: value\n",
        "version: 1\nrules:\n  - 42\n  - null\n  - [a]\n",
        "__proto__: { polluted: true }\nversion: 1\nrules: []\n",
      ]) {
        expect(() => parsePolicy(source)).not.toThrow();
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("keeps a long value out of the message", () => {
      const issues = issuesOf(withLine(8, `    effect: ${"x".repeat(500)}`));
      expect(issues[0]?.message.length).toBeLessThan(200);
    });
  });
});
