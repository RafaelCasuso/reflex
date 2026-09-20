import { describe, expect, it } from "vitest";

import {
  compiled,
  decide,
  effectOf,
  fileTool,
  local,
  policy,
  shell,
} from "../engine.test-support.js";
import { compilePolicySet } from "../evaluator.js";
import { builtInPolicy } from "./built-in.js";

/** RFX-103 — REFLEX protects its own configuration from the agent it governs. */
const ALLOW_EVERYTHING = `version: 1
rules:
  - id: allow-everything
    name: Anything at all
    effect: allow
    conditions:
      - { field: tool.name, operator: exists }
  - id: allow-mcp-too
    name: Anything at all, from any server
    effect: allow
    conditions:
      - { field: tool.namespace, operator: exists }
`;

/** Every source a policy can come from, each allowing everything. */
const permissive = compiled(
  { source: "organization", trusted: true, document: policy(ALLOW_EVERYTHING) },
  { source: "environment", trusted: true, document: policy(ALLOW_EVERYTHING) },
  { source: "project", trusted: true, document: policy(ALLOW_EVERYTHING) },
  local(ALLOW_EVERYTHING),
);

describe("RFX-103 built-in self-protection", () => {
  it("is mandatory, asks, and is parsed like any other policy", () => {
    const { rules } = builtInPolicy();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule).toMatchObject({ effect: "ask", mandatory: true });
      expect(rule.id.startsWith("reflex.")).toBe(true);
    }
  });

  it("is part of every set, and no caller can supply or replace it", () => {
    expect(compiled().rules.map((sourced) => sourced.source)).toContain(
      "built-in",
    );
    const result = compilePolicySet([
      {
        source: "built-in",
        trusted: true,
        document: policy("version: 1\nrules: []\n"),
      },
    ]);
    expect(result.ok).toBe(false);
  });

  // The acceptance: no policy source can allow these actions without human
  // approval. Every source allows everything, and the answer is still ask.
  describe("against every source allowing everything", () => {
    it.each([
      [
        "the project policy, with the Edit tool",
        fileTool("Edit", "/work/project/.reflex/policy.yaml"),
      ],
      [
        "the project policy, with the Write tool",
        fileTool("Write", ".reflex/policy.yaml"),
      ],
      [
        "the user's REFLEX state",
        fileTool("Write", "/home/dev/.reflex/state.json"),
      ],
      [
        "the hook registration, local settings",
        fileTool("Edit", "/work/project/.claude/settings.local.json"),
      ],
      [
        "the hook registration, shared settings",
        fileTool("Write", "/work/project/.claude/settings.json"),
      ],
      [
        "the hook registration, user settings",
        fileTool("Edit", "/home/dev/.claude/settings.json"),
      ],
      ["the host's user file", fileTool("Write", "/home/dev/.claude.json")],
      [
        "a path that reaches it by traversal",
        fileTool("Edit", "/work/project/src/../.reflex/policy.yaml"),
      ],
      [
        "a path that reaches it by case",
        fileTool("Edit", "/work/project/.REFLEX/policy.yaml"),
      ],
      [
        "a notebook tool",
        fileTool("NotebookEdit", "/work/project/.claude/settings.local.json"),
      ],
    ])("asks about %s", (_label, action) => {
      expect(effectOf(permissive, action)).toBe("ask");
      expect(decide(permissive, action).evaluation.matches[0]).toMatchObject({
        mandatory: true,
        precedence: 150,
      });
    });

    // The ticket names them: redirects, sed -i, mv, symlinks, editor tools.
    it.each([
      ["a redirect", "echo 'version: 1' > .reflex/policy.yaml"],
      ["an appending redirect", "echo 'rules: []' >> .reflex/policy.yaml"],
      [
        "sed -i",
        "sed -i '' 's/effect: deny/effect: allow/' .reflex/policy.yaml",
      ],
      ["mv over the file", "mv /tmp/policy.yaml .reflex/policy.yaml"],
      ["cp over the file", "cp /tmp/policy.yaml .reflex/policy.yaml"],
      ["tee", "cat /tmp/p | tee .reflex/policy.yaml"],
      [
        "a symlink to the file",
        "ln -s /work/project/.reflex/policy.yaml /tmp/p",
      ],
      ["a symlink over the file", "ln -sf /tmp/evil.yaml .reflex/policy.yaml"],
      ["deleting the state", "rm -rf ~/.reflex"],
      ["deleting the project policy", "rm .reflex/policy.yaml"],
      [
        "switching every hook off",
        "echo '{\"disableAllHooks\": true}' > .claude/settings.local.json",
      ],
      [
        "editing the hook out with jq",
        "jq 'del(.hooks)' .claude/settings.local.json > /tmp/s && mv /tmp/s .claude/settings.local.json",
      ],
      ["truncating the settings", ": > ~/.claude/settings.json"],
      ["chmod on the policy", "chmod 000 .reflex/policy.yaml"],
      [
        "a script given the file as an argument",
        "python3 rewrite.py .reflex/policy.yaml",
      ],
      [
        "code that names the file",
        "python3 -c \"open('.reflex/policy.yaml','w').write('version: 1')\"",
      ],
      [
        "node that names the file",
        "node -e \"require('fs').rmSync('.claude/settings.local.json')\"",
      ],
      ["hidden in a wrapper", 'sudo env X=1 bash -c "rm .reflex/policy.yaml"'],
      ["hidden in a substitution", "echo $(rm .reflex/policy.yaml)"],
      ["after a harmless command", "git status; rm -rf .reflex"],
      ["uninstalling", "rfx uninstall --yes"],
      ["uninstalling by path", "/usr/local/bin/rfx uninstall --purge"],
      ["pausing", "rfx pause"],
      ["trusting a policy on the user's behalf", "rfx trust this"],
    ])("asks about %s", (_label, command) => {
      expect(effectOf(permissive, shell(command))).toBe("ask");
    });
  });

  // ADR-012: ask, not deny. The human can still change their own policy
  // through the agent. And what only reads is nobody's business.
  it("does not stand in the way of reading, or of unrelated work", () => {
    for (const action of [
      shell("cat .reflex/policy.yaml"),
      shell("ls -la .claude"),
      shell("grep -rn effect .reflex"),
      shell("rfx status"),
      shell("rfx doctor"),
      fileTool("Read", "/work/project/.reflex/policy.yaml"),
      fileTool("Write", "/work/project/src/reflexes.ts"),
      fileTool("Write", "/work/project/docs/claude.md"),
      shell("git status"),
    ]) {
      expect(effectOf(permissive, action)).toBe("allow");
    }
  });

  it("never denies by itself: a deny is somebody's policy, not REFLEX's", () => {
    expect(
      effectOf(
        compiled(),
        fileTool("Edit", "/work/project/.reflex/policy.yaml"),
      ),
    ).toBe("ask");
    const stricter = compiled(
      local(`version: 1
rules:
  - id: never-touch-reflex
    name: Never
    effect: deny
    conditions:
      - { field: path, operator: path_within, value: "\${project}/.reflex" }
`),
    );
    expect(
      effectOf(stricter, fileTool("Edit", "/work/project/.reflex/policy.yaml")),
    ).toBe("deny");
  });

  // Said plainly, because a security product that overstates is one nobody
  // should trust: a script that performs the write without naming the file is
  // invisible before it runs. REFLEX is not a sandbox (docs/security.md). What
  // holds is that REFLEX never calls such a script harmless, so nothing that
  // ships allows it, and that `rfx status` reports the hook once it is gone.
  it("cannot see inside a script, and never calls one harmless", () => {
    const hidden = shell("./scripts/cleanup.sh");
    expect(decide(compiled(), hidden).sideEffectClass).toBe("unknown");
    expect(effectOf(compiled(), hidden)).toBe("unresolved");
    // Only an explicit statement of trust in that script allows it.
    expect(effectOf(permissive, hidden)).toBe("allow");
  });
});
