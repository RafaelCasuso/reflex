import { describe, expect, it } from "vitest";

import { compiled, local, policy } from "./engine.test-support.js";

/** RFX-016 — the policy set hash. */
const REFERENCE = `version: 1
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
  - id: deny-outside
    name: Nothing outside the project
    effect: deny
    mandatory: true
    conditions:
      - not: { field: path, operator: path_within, value: "\${project}" }
      - any_of:
          - { field: sideEffectClass, operator: equals, value: destructive }
          - { field: sideEffectClass, operator: equals, value: local-write }
`;

const hashOf = (yaml: string): string => compiled(local(yaml)).hash;

describe("RFX-016 policy set hash", () => {
  it("is sha256 over a canonical form", () => {
    const set = compiled(local(REFERENCE));
    expect(set.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.parse(set.canonical)).toMatchObject({ format: 1 });
    expect(set.canonical).not.toMatch(/\s{2}|\n/);
  });

  // The acceptance: identical policy content yields an identical hash
  // regardless of formatting.
  it.each([
    [
      "comments, blank lines and indentation",
      `# my policy\n\n${REFERENCE.replaceAll("\n  - id:", "\n\n  # a rule\n  - id:")}`,
    ],
    [
      "quoting and flow style",
      `"version": 1
"defaults": { "unresolved": "ask" }
"rules":
  - { "id": "allow-git-reads", "name": "Git commands that only read", "effect": "allow", "conditions": [{ "field": "command.name", "operator": "equals", "value": "git" }, { "field": "command.args", "operator": "in", "value": ["status", "diff", "log"] }] }
  - { id: deny-outside, name: 'Nothing outside the project', effect: deny, mandatory: true, conditions: [{ not: { field: path, operator: path_within, value: "\${project}" } }, { any_of: [{ field: sideEffectClass, operator: equals, value: destructive }, { field: sideEffectClass, operator: equals, value: local-write }] }] }
`,
    ],
    [
      "the order of keys",
      `rules:
  - conditions:
      - { value: git, operator: equals, field: command.name }
      - { value: [status, diff, log], field: command.args, operator: in }
    effect: allow
    name: Git commands that only read
    id: allow-git-reads
  - mandatory: true
    conditions:
      - not: { value: "\${project}", operator: path_within, field: path }
      - any_of:
          - { field: sideEffectClass, operator: equals, value: destructive }
          - { field: sideEffectClass, operator: equals, value: local-write }
    name: Nothing outside the project
    effect: deny
    id: deny-outside
defaults: { unresolved: ask }
version: 1
`,
    ],
    [
      "the order of rules, of conditions, of any_of branches and of in values",
      `version: 1
defaults:
  unresolved: ask
rules:
  - id: deny-outside
    name: Nothing outside the project
    effect: deny
    mandatory: true
    conditions:
      - any_of:
          - { field: sideEffectClass, operator: equals, value: local-write }
          - { field: sideEffectClass, operator: equals, value: destructive }
      - not: { field: path, operator: path_within, value: "\${project}" }
  - id: allow-git-reads
    name: Git commands that only read
    effect: allow
    conditions:
      - { field: command.args, operator: in, value: [log, status, diff] }
      - { field: command.name, operator: equals, value: git }
`,
    ],
    [
      "mandatory: false written out",
      REFERENCE.replace(
        "    effect: allow\n",
        "    effect: allow\n    mandatory: false\n",
      ),
    ],
  ])("does not depend on %s", (_label, yaml) => {
    expect(hashOf(yaml)).toBe(hashOf(REFERENCE));
  });

  // Adversarial: two policies that decide differently must never share a hash.
  it.each([
    ["an effect", REFERENCE.replace("effect: deny", "effect: ask")],
    ["a mandate", REFERENCE.replace("    mandatory: true\n", "")],
    [
      "a value",
      REFERENCE.replace("[status, diff, log]", "[status, diff, log, push]"),
    ],
    [
      "an operator",
      REFERENCE.replace(
        "operator: equals\n        value: git",
        "operator: not_equals\n        value: git",
      ),
    ],
    ["a field", REFERENCE.replace("field: command.name", "field: tool.name")],
    [
      "a negation",
      REFERENCE.replace(
        '- not: { field: path, operator: path_within, value: "${project}" }',
        '- { field: path, operator: path_within, value: "${project}" }',
      ),
    ],
    ["the default", REFERENCE.replace("unresolved: ask", "unresolved: deny")],
    [
      "no default at all",
      REFERENCE.replace("defaults:\n  unresolved: ask\n", ""),
    ],
    ["a rule id", REFERENCE.replace("id: deny-outside", "id: deny-outside-2")],
    [
      "a rule name",
      REFERENCE.replace("Nothing outside the project", "Nothing outside"),
    ],
    [
      "one rule fewer",
      REFERENCE.slice(0, REFERENCE.indexOf("  - id: deny-outside")),
    ],
  ])("changes with %s", (_label, yaml) => {
    expect(hashOf(yaml)).not.toBe(hashOf(REFERENCE));
  });

  it("changes with the source a policy comes from, and with its trust", () => {
    const document = policy(REFERENCE);
    const hashes = new Set([
      compiled({ source: "local", trusted: true, document }).hash,
      compiled({ source: "organization", trusted: true, document }).hash,
      compiled({ source: "project", trusted: true, document }).hash,
      compiled({ source: "project", trusted: false, document }).hash,
      compiled({
        source: "project",
        trusted: true,
        policyId: "pol_01",
        document,
      }).hash,
    ]);
    expect(hashes.size).toBe(5);
    // Trust only exists for a project, so the flag is not part of another source.
    expect(compiled({ source: "local", trusted: false, document }).hash).toBe(
      compiled({ source: "local", trusted: true, document }).hash,
    );
  });

  it("does not depend on the order the sources are given in", () => {
    const a = {
      source: "organization" as const,
      trusted: true,
      document: policy(REFERENCE),
    };
    const b = local("version: 1\nrules: []\n");
    expect(compiled(a, b).hash).toBe(compiled(b, a).hash);
  });

  it("is the same for the empty set, every time", () => {
    expect(compiled().hash).toBe(compiled().hash);
    expect(compiled().hash).not.toBe(
      compiled(local("version: 1\nrules: []\n")).hash,
    );
  });

  // A change to the canonical form changes every recorded hash, and so does a
  // change to REFLEX's built-in rules, which are part of every set (RFX-103).
  // If this fails, one of the two happened: say which in the commit, and bump
  // POLICY_SET_FORMAT if it was the form.
  it("is frozen for a known policy", () => {
    expect(hashOf("version: 1\nrules: []\n")).toBe(
      "sha256:4eaff6bec60fbb9066fdc17d39bb82c9b936d4ccb19f96d61ee85eb3317bc8eb",
    );
  });
});
