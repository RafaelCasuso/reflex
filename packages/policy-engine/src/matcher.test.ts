import { describe, expect, it } from "vitest";

import {
  compiled,
  effectOf,
  fileTool,
  local,
  mcp,
  shell,
} from "./engine.test-support.js";

/** RFX-013 and RFX-097 — conditions, read by the rule's effect. */
const rule = (effect: string, conditions: string): string => `version: 1
rules:
  - id: r
    name: R
    effect: ${effect}
    conditions:
${conditions}
`;
const one = (effect: string, conditions: string) =>
  compiled(local(rule(effect, conditions)));

describe("RFX-013 operators", () => {
  it.each([
    [
      "equals",
      "      - { field: command.name, operator: equals, value: git }",
      "git status",
      true,
    ],
    [
      "equals, no match",
      "      - { field: command.name, operator: equals, value: git }",
      "ls",
      false,
    ],
    [
      "not_equals",
      "      - { field: command.name, operator: not_equals, value: git }",
      "ls",
      true,
    ],
    [
      "in",
      "      - { field: command.name, operator: in, value: [git, ls] }",
      "ls -la",
      true,
    ],
    [
      "in, no match",
      "      - { field: command.name, operator: in, value: [git, ls] }",
      "cat x",
      false,
    ],
    [
      "starts_with",
      "      - { field: command.text, operator: starts_with, value: git status }",
      "git status --short",
      true,
    ],
    [
      "matches",
      '      - { field: command.text, operator: matches, value: "^git (status|diff)( |$)" }',
      "git diff",
      true,
    ],
    [
      "matches, no match",
      '      - { field: command.text, operator: matches, value: "^git (status|diff)( |$)" }',
      "git push",
      false,
    ],
    ["exists", "      - { field: command.name, operator: exists }", "ls", true],
  ])("%s", (_label, conditions, command, matches) => {
    expect(effectOf(one("ask", conditions), shell(command))).toBe(
      matches ? "ask" : "unresolved",
    );
  });

  it("reads a host's own arguments for a tool that has no operands", () => {
    const set = one(
      "deny",
      '      - { field: arguments.query, operator: matches, value: "(?i)drop\\\\s+table" }',
    );
    expect(
      effectOf(
        set,
        mcp("postgres", "execute_sql", { query: "DROP TABLE customers" }),
      ),
    ).toBe("deny");
    expect(
      effectOf(set, mcp("postgres", "execute_sql", { query: "SELECT 1" })),
    ).toBe("unresolved");
    // A value that is not a scalar is not a value.
    expect(
      effectOf(
        set,
        mcp("postgres", "execute_sql", { query: { nested: "DROP TABLE x" } }),
      ),
    ).toBe("unresolved");
  });

  it("all the conditions of a rule have to hold", () => {
    const set = one(
      "allow",
      `      - { field: command.name, operator: equals, value: git }
      - { field: command.args, operator: in, value: [status, --short] }`,
    );
    expect(effectOf(set, shell("git status --short"))).toBe("allow");
    expect(effectOf(set, shell("git push"))).toBe("unresolved");
  });
});

// ADR-011: when in doubt, a rule that restricts matches and a rule that
// permits does not.
describe("RFX-013 asymmetric matching", () => {
  const allowGit = one(
    "allow",
    "      - { field: command.name, operator: equals, value: git }",
  );
  const denyRm = one(
    "deny",
    "      - { field: command.name, operator: equals, value: rm }",
  );

  it("an allow rule needs every segment allowed", () => {
    expect(effectOf(allowGit, shell("git status"))).toBe("allow");
    expect(effectOf(allowGit, shell("git status && git diff"))).toBe("allow");
    expect(effectOf(allowGit, shell("git status; rm -rf ~"))).toBe(
      "unresolved",
    );
  });

  it("a deny rule matches if any segment matches", () => {
    expect(effectOf(denyRm, shell("git status; rm -rf ~"))).toBe("deny");
    expect(effectOf(denyRm, shell("echo $(rm -rf ~)"))).toBe("deny");
    expect(effectOf(denyRm, shell('bash -c "rm -rf ~"'))).toBe("deny");
    expect(effectOf(denyRm, shell("git ls-files | xargs rm -f"))).toBe("deny");
  });

  it("an allow rule never matches a command that is not fully understood", () => {
    for (const command of [
      "git $(echo status)",
      "git status $EXTRA",
      "git add *",
      "git status; $CMD",
      "git log | sh",
    ]) {
      expect(effectOf(allowGit, shell(command)), command).toBe("unresolved");
    }
  });

  it("reads a field with several values by the rule's effect", () => {
    const allowSafeArgs = one(
      "allow",
      "      - { field: command.args, operator: in, value: [status, --short] }",
    );
    const denyForce = one(
      "deny",
      "      - { field: command.args, operator: in, value: [--force, -f] }",
    );
    // Every argument has to be one of the allowed ones.
    expect(effectOf(allowSafeArgs, shell("git status --short"))).toBe("allow");
    expect(effectOf(allowSafeArgs, shell("git status --force"))).toBe(
      "unresolved",
    );
    // One forbidden argument is enough.
    expect(effectOf(denyForce, shell("git push origin main --force"))).toBe(
      "deny",
    );
  });

  describe("a field that is absent", () => {
    it("never satisfies an allow rule, under not either", () => {
      const notRm = one(
        "allow",
        "      - not: { field: command.name, operator: equals, value: rm }",
      );
      // A tool call has no command.name at all. "Not rm" must not allow it.
      expect(effectOf(notRm, fileTool("Write", "/work/project/a.ts"))).toBe(
        "unresolved",
      );
      expect(effectOf(notRm, shell("ls"))).toBe("allow");
      expect(effectOf(notRm, shell("rm x"))).toBe("unresolved");

      const notEquals = one(
        "allow",
        "      - { field: command.name, operator: not_equals, value: rm }",
      );
      expect(effectOf(notEquals, fileTool("Write", "/work/project/a.ts"))).toBe(
        "unresolved",
      );
    });

    it("is simply absent for a rule that restricts", () => {
      const denyRmByName = one(
        "deny",
        "      - { field: command.name, operator: equals, value: rm }",
      );
      expect(
        effectOf(denyRmByName, fileTool("Write", "/work/project/a.ts")),
      ).toBe("unresolved");

      const denyUnlessGithub = one(
        "deny",
        "      - not: { field: tool.namespace, operator: equals, value: github }",
      );
      expect(effectOf(denyUnlessGithub, mcp("github", "x", {}))).toBe(
        "unresolved",
      );
      expect(effectOf(denyUnlessGithub, mcp("other", "x", {}))).toBe("deny");
      expect(effectOf(denyUnlessGithub, shell("ls"))).toBe("deny");
    });
  });

  // A server names its own tools.
  it("an allow rule does not reach an MCP tool unless it names the namespace", () => {
    const allowBash = one(
      "allow",
      "      - { field: tool.name, operator: equals, value: Bash }",
    );
    expect(effectOf(allowBash, shell("git status"))).toBe("allow");
    expect(
      effectOf(allowBash, mcp("helper", "Bash", { command: "git status" })),
    ).toBe("unresolved");

    const allowGithubRead = one(
      "allow",
      `      - { field: tool.namespace, operator: equals, value: github }
      - { field: tool.name, operator: equals, value: get_issue }`,
    );
    expect(effectOf(allowGithubRead, mcp("github", "get_issue", {}))).toBe(
      "allow",
    );
    expect(effectOf(allowGithubRead, mcp("evil", "get_issue", {}))).toBe(
      "unresolved",
    );

    // A rule that restricts reaches every tool with that name.
    const denyBash = one(
      "deny",
      "      - { field: tool.name, operator: equals, value: Bash }",
    );
    expect(effectOf(denyBash, mcp("helper", "Bash", {}))).toBe("deny");
  });
});

describe("RFX-097 path containment and composition", () => {
  const allowInProject = one(
    "allow",
    `      - { field: tool.name, operator: in, value: [Write, Edit] }
      - { field: path, operator: path_within, value: "\${project}" }`,
  );

  it("allows a write inside the project", () => {
    expect(
      effectOf(allowInProject, fileTool("Write", "/work/project/src/date.ts")),
    ).toBe("allow");
    expect(effectOf(allowInProject, fileTool("Edit", "src/date.ts"))).toBe(
      "allow",
    );
  });

  // The acceptance: traversal, case and trailing-separator tricks cannot make
  // a path outside the root match.
  it.each([
    ["/etc/hosts"],
    ["/work/project/../../etc/hosts"],
    ["/work/project/../../home/dev/.ssh/authorized_keys"],
    ["../outside.txt"],
    ["/work/project-evil/x"],
    ["/WORK/PROJECT/src/date.ts"],
    ["/work/project/../project-evil//x/"],
    ["~/.zshrc"],
  ])("does not allow %s", (path) => {
    expect(effectOf(allowInProject, fileTool("Write", path))).toBe(
      "unresolved",
    );
  });

  it("every path of an allow rule has to be inside; one outside is enough for a deny", () => {
    const allowCopy = one(
      "allow",
      `      - { field: command.name, operator: equals, value: cp }
      - { field: path, operator: path_within, value: "\${project}" }`,
    );
    expect(effectOf(allowCopy, shell("cp src/a.ts src/b.ts"))).toBe("allow");
    expect(effectOf(allowCopy, shell("cp src/a.ts /etc/cron.d/x"))).toBe(
      "unresolved",
    );

    const denyOutside = one(
      "deny",
      '      - not: { field: path, operator: path_within, value: "${project}" }',
    );
    expect(effectOf(denyOutside, shell("cp src/a.ts src/b.ts"))).toBe(
      "unresolved",
    );
    expect(effectOf(denyOutside, shell("cp src/a.ts /etc/cron.d/x"))).toBe(
      "deny",
    );
    // No path at all: a rule about paths does not apply.
    expect(effectOf(denyOutside, shell("git status"))).toBe("unresolved");
  });

  it("a rule that restricts ignores case, so that ~/.SSH is still ~/.ssh", () => {
    const denySsh = one(
      "deny",
      '      - { field: path, operator: path_within, value: "~/.ssh" }',
    );
    expect(effectOf(denySsh, shell("cat ~/.ssh/id_ed25519"))).toBe("deny");
    expect(effectOf(denySsh, shell("cat ~/.SSH/id_ed25519"))).toBe("deny");
    expect(effectOf(denySsh, shell("cat /home/dev/.ssh/../.ssh/config"))).toBe(
      "deny",
    );
    expect(effectOf(denySsh, shell("cat ~/.sshx/notes"))).toBe("unresolved");
  });

  // The documented truth table.
  it("any_of and not compose", () => {
    const set = one(
      "ask",
      `      - any_of:
          - { field: command.name, operator: equals, value: curl }
          - { field: command.name, operator: equals, value: wget }
      - not: { field: network.host, operator: equals, value: example.test }`,
    );
    expect(effectOf(set, shell("curl https://other.test/x"))).toBe("ask");
    expect(effectOf(set, shell("wget https://other.test/x"))).toBe("ask");
    expect(effectOf(set, shell("curl https://example.test/x"))).toBe(
      "unresolved",
    );
    expect(effectOf(set, shell("ls"))).toBe("unresolved");
  });

  it("a double negation reads like the condition itself", () => {
    const direct = one(
      "deny",
      "      - { field: command.name, operator: equals, value: rm }",
    );
    const twice = one(
      "deny",
      "      - not: { not: { field: command.name, operator: equals, value: rm } }",
    );
    for (const command of ["rm x", "ls", "git status; rm -rf ~"]) {
      expect(effectOf(twice, shell(command))).toBe(
        effectOf(direct, shell(command)),
      );
    }
  });
});
