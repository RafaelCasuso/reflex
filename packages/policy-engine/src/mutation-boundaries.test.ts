import { describe, expect, it } from "vitest";

import {
  CONTEXT,
  compiled,
  fileTool,
  local,
  shell,
} from "./engine.test-support.js";
import { evaluatePolicy } from "./evaluator.js";
import { PATTERN_LIMITS } from "./pattern.js";
import { resolve } from "./precedence.js";

/**
 * RFX-111 — what the mutation check found untested: the doubt rule on a
 * pattern that is missing, on a path that cannot be resolved, on a text too
 * long for an allow; the order and the shape of the matches; the context
 * an evaluation derives from the action itself.
 */
const RESTRICT_MATCHES = `version: 1
rules:
  - id: deny-secretish
    name: Deny a secret-looking argument
    effect: deny
    conditions:
      - { field: command.text, operator: matches, value: "secret-[0-9a-f]{12}" }
`;

const PERMIT_MATCHES = `version: 1
rules:
  - id: allow-echo
    name: Allow echoes that match
    effect: allow
    conditions:
      - { field: command.text, operator: matches, value: "^echo " }
`;

const WITHIN_PROJECT = (effect: "allow" | "deny") => `version: 1
rules:
  - id: rule
    name: Paths inside the project
    effect: ${effect}
    conditions:
      - { field: path, operator: path_within, value: "\${project}" }
`;

describe("the doubt rule where the mutation check found it unheld", () => {
  it("treats a compiled pattern that is missing as a match for a restrict and as no match for a permit", () => {
    // The set's own patterns are there; a set handed to the evaluator
    // without them is the situation the code guards.
    const denies = {
      ...compiled(local(RESTRICT_MATCHES)),
      patterns: new Map(),
    };
    const allows = { ...compiled(local(PERMIT_MATCHES)), patterns: new Map() };
    expect(
      evaluatePolicy(denies, shell("echo hello"), CONTEXT).evaluation.effect,
    ).toBe("deny");
    expect(
      evaluatePolicy(allows, shell("echo hello"), CONTEXT).evaluation.resolved,
    ).toBe(false);
  });

  it("skips a pattern for a permit on a text past the budget, and not for a restrict", () => {
    const long = `echo ${"x".repeat(5_000)}`;
    const allows = compiled(local(PERMIT_MATCHES));
    expect(
      evaluatePolicy(allows, shell(long), CONTEXT).evaluation.resolved,
    ).toBe(false);
    const denies = compiled(
      local(`version: 1
rules:
  - id: deny-long-echo
    name: Deny echoes
    effect: deny
    conditions:
      - { field: command.text, operator: matches, value: "^echo " }
`),
    );
    expect(evaluatePolicy(denies, shell(long), CONTEXT).evaluation.effect).toBe(
      "deny",
    );
    // One under the budget, the permit still matches.
    const justUnder = `echo ${"x".repeat(4_000)}`;
    expect(
      evaluatePolicy(allows, shell(justUnder), CONTEXT).evaluation.effect,
    ).toBe("allow");
  });

  it("reads path_within with no root as a match for a restrict and as no match for a permit", () => {
    const denies = compiled(local(WITHIN_PROJECT("deny")));
    const allows = compiled(local(WITHIN_PROJECT("allow")));
    // Without a working directory or a repository, `${project}` resolves to
    // nothing. REFLEX's own rules restrict by path too, so they match as
    // well: with no root, a file write asks. That is the doubt rule.
    const rootless = rootlessCopy(fileTool("Write", "/work/project/src/x.ts"));
    const denied = evaluatePolicy(denies, rootless, { home: "/home/dev" });
    expect(denied.evaluation.effect).toBe("deny");
    expect(
      denied.evaluation.matches.some((match) => match.ruleId === "rule"),
    ).toBe(true);
    const allowed = evaluatePolicy(allows, rootless, { home: "/home/dev" });
    expect(
      allowed.evaluation.matches.some((match) => match.ruleId === "rule"),
    ).toBe(false);
    expect(allowed.evaluation.effect).not.toBe("allow");
  });

  it("reads a relative path the same way: a restrict matches, a permit does not", () => {
    const denies = compiled(local(WITHIN_PROJECT("deny")));
    const allows = compiled(local(WITHIN_PROJECT("allow")));
    const rootless = rootlessCopy(fileTool("Write", "src/x.ts"));
    expect(
      evaluatePolicy(denies, rootless, { home: "/home/dev" }).evaluation.effect,
    ).toBe("deny");
    const allowed = evaluatePolicy(allows, rootless, { home: "/home/dev" });
    expect(
      allowed.evaluation.matches.some((match) => match.ruleId === "rule"),
    ).toBe(false);
  });

  it("derives the working directory and the project root from the action when the context has none", () => {
    const allows = compiled(local(WITHIN_PROJECT("allow")));
    const inside = fileTool("Write", "/work/project/src/x.ts");
    expect(
      evaluatePolicy(allows, inside, { home: "/home/dev" }).evaluation.effect,
    ).toBe("allow");
    const elsewhere = { ...inside, repository: { root: "/other/project" } };
    expect(
      evaluatePolicy(allows, elsewhere, { home: "/home/dev" }).evaluation
        .resolved,
    ).toBe(false);
    // With only a cwd, the cwd is the project.
    const cwdOnly: Record<string, unknown> = { ...inside };
    delete cwdOnly.repository;
    expect(
      evaluatePolicy(allows, cwdOnly as unknown as typeof inside, {
        home: "/home/dev",
      }).evaluation.effect,
    ).toBe("allow");
    // A context root wins over the action's.
    expect(
      evaluatePolicy(allows, inside, {
        home: "/home/dev",
        projectRoot: "/other",
      }).evaluation.resolved,
    ).toBe(false);
  });
});

describe("the shape and order of the matches", () => {
  it("puts the deciding match first even when precedence sorts it later", () => {
    // Two matches of equal precedence: the deciding one is not the first by
    // rule id, and must still come first.
    const set = compiled(
      local(`version: 1
rules:
  - id: a-allows
    name: A
    effect: allow
    conditions:
      - { field: tool.name, operator: equals, value: Bash }
  - id: z-denies
    name: Z
    effect: deny
    conditions:
      - { field: tool.name, operator: equals, value: Bash }
`),
    );
    const { evaluation } = evaluatePolicy(set, shell("ls"), CONTEXT);
    expect(evaluation.effect).toBe("deny");
    expect(evaluation.matches[0]?.ruleId).toBe("z-denies");
    expect(evaluation.matches.map((match) => match.ruleId)).toEqual([
      "z-denies",
      "a-allows",
    ]);
  });

  it("carries the policy id of a source that has one", () => {
    const set = compiled({
      source: "local",
      trusted: true,
      policyId: "pol_00000000000000000000000000000001",
      document: local(`version: 1
rules:
  - id: deny-all-bash
    name: Deny Bash
    effect: deny
    conditions:
      - { field: tool.name, operator: equals, value: Bash }
`).document,
    });
    const { evaluation } = evaluatePolicy(set, shell("ls"), CONTEXT);
    expect(evaluation.matches[0]?.policyId).toBe(
      "pol_00000000000000000000000000000001",
    );
    const anonymous = compiled(
      local(`version: 1
rules:
  - id: deny-all-bash
    name: Deny Bash
    effect: deny
    conditions:
      - { field: tool.name, operator: equals, value: Bash }
`),
    );
    expect(
      "policyId" in
        (evaluatePolicy(anonymous, shell("ls"), CONTEXT).evaluation
          .matches[0] ?? {}),
    ).toBe(false);
  });

  it("reports a floor only while unresolved", () => {
    const set = compiled(
      local(`version: 1
defaults:
  unresolved: semantic
rules: []
`),
      {
        source: "project",
        trusted: false,
        document: local(`version: 1
rules:
  - id: repo-asks
    name: The repository asks
    effect: ask
    conditions:
      - { field: tool.name, operator: equals, value: Bash }
`).document,
      },
    );
    const unresolved = evaluatePolicy(set, shell("ls"), CONTEXT);
    expect(unresolved.evaluation.resolved).toBe(false);
    expect(unresolved.floor).toBe("ask");
    const resolved = evaluatePolicy(
      set,
      fileTool("Write", "/work/project/.reflex/policy.yaml"),
      CONTEXT,
    );
    expect(resolved.evaluation.resolved).toBe(true);
    expect(resolved.floor).toBeUndefined();
  });

  it("does not count a mandatory rule among the defaults of its source", () => {
    // A mandatory org ask and a local default allow of the same subject: the
    // ask holds as a floor whatever the local default says. Were the
    // mandatory rule also a default, the most specific source would be
    // computed with it and the outcome would still be ask; what changes is
    // the resolution's own bookkeeping, which `resolve` exposes.
    const org = {
      source: "organization" as const,
      trusted: true,
      document: local(`version: 1
rules:
  - id: org-asks
    name: Org asks
    effect: ask
    mandatory: true
    conditions:
      - { field: tool.name, operator: equals, value: Bash }
`).document,
    };
    const set = compiled(
      org,
      local(`version: 1
rules:
  - id: local-allows
    name: Local allows
    effect: allow
    conditions:
      - { field: tool.name, operator: equals, value: Bash }
`),
    );
    const resolution = resolve(
      set.rules.filter((rule) => rule.source !== "built-in"),
    );
    expect(resolution.effect).toBe("ask");
    expect(resolution.matches.map((match) => match.ruleId)).toEqual([
      "org-asks",
      "local-allows",
    ]);
  });
});

describe("REFLEX's own rules", () => {
  it("are trusted and mandatory: they resolve, they do not merely floor", () => {
    const set = compiled(
      local(`version: 1
defaults:
  unresolved: semantic
rules: []
`),
    );
    const own = set.rules.find((rule) => rule.source === "built-in");
    expect(own?.trusted).toBe(true);
    const result = evaluatePolicy(
      set,
      fileTool("Write", "/work/project/.reflex/policy.yaml"),
      CONTEXT,
    );
    expect(result.evaluation.resolved).toBe(true);
    expect(result.evaluation.effect).toBe("ask");
    expect(result.evaluation.matches[0]?.mandatory).toBe(true);
    expect(result.floor).toBeUndefined();
  });
});

/** The action without a working directory or a repository: no root anywhere. */
function rootlessCopy(
  action: ReturnType<typeof fileTool>,
): ReturnType<typeof fileTool> {
  const copy: Record<string, unknown> = { ...action };
  delete copy.cwd;
  delete copy.repository;
  return copy as unknown as ReturnType<typeof fileTool>;
}

describe("operators on a value that is not text", () => {
  // `arguments.<key>` can be any JSON value; `matches` is a question about
  // text, and the answer for anything else is no. (`path_within` only takes
  // the `path` field, which is always text: the parser refuses the rest.)
  const NUMERIC = `version: 1
rules:
  - id: allow-by-count
    name: Allow by a numeric argument
    effect: allow
    conditions:
      - { field: arguments.count, operator: matches, value: "^[0-9]+$" }
`;

  it("never lets a number satisfy a text operator, even one whose text would", () => {
    const set = compiled(local(NUMERIC));
    const numeric = {
      ...shell("ls"),
      arguments: { command: "ls", count: 123 },
    };
    expect(evaluatePolicy(set, numeric, CONTEXT).evaluation.resolved).toBe(
      false,
    );
    const asText = {
      ...shell("ls"),
      arguments: { command: "ls", count: "123" },
    };
    expect(evaluatePolicy(set, asText, CONTEXT).evaluation.effect).toBe(
      "allow",
    );
  });
});

describe("what the second run found", () => {
  it("lets a permit match a text exactly at the budget, and not one past it", () => {
    const allows = compiled(local(PERMIT_MATCHES));
    const at = `echo ${"x".repeat(PATTERN_LIMITS.budgetedTextLength - "echo ".length)}`;
    expect(at.length).toBe(PATTERN_LIMITS.budgetedTextLength);
    expect(evaluatePolicy(allows, shell(at), CONTEXT).evaluation.effect).toBe(
      "allow",
    );
    expect(
      evaluatePolicy(allows, shell(`${at}x`), CONTEXT).evaluation.resolved,
    ).toBe(false);
  });

  it("resolves a relative project root against the working directory: the context's, else the action's", () => {
    // A context may name the project relative to the working directory. The
    // action's own directory stands in when the context names none.
    const allows = compiled(local(WITHIN_PROJECT("allow")));
    const inside = {
      ...fileTool("Write", "/work/project/src/x.ts"),
      cwd: "/work",
    };
    expect(
      evaluatePolicy(allows, inside, {
        home: "/home/dev",
        projectRoot: "project",
      }).evaluation.effect,
    ).toBe("allow");
    expect(
      evaluatePolicy(allows, inside, {
        home: "/home/dev",
        projectRoot: "project",
        cwd: "/other",
      }).evaluation.resolved,
    ).toBe(false);
    // With no working directory anywhere, the root is unknown: the permit
    // does not match (REFLEX's own path rules do, by the doubt rule).
    const rootless = evaluatePolicy(allows, rootlessCopy(inside), {
      home: "/home/dev",
      projectRoot: "project",
    });
    expect(
      rootless.evaluation.matches.some((match) => match.ruleId === "rule"),
    ).toBe(false);
    expect(rootless.evaluation.effect).not.toBe("allow");
  });

  it("keeps a mandatory rule out of the cascade: the most specific default decides under its floor", () => {
    // A mandatory local ask and an organization default deny of the same
    // subject: the ask is a floor, and the deny, the only default, holds.
    // Counted as a default, the local ask would be the most specific one and
    // the deny would be lost.
    const set = compiled(
      {
        source: "organization",
        trusted: true,
        document: local(`version: 1
rules:
  - id: org-denies
    name: Org denies
    effect: deny
    conditions:
      - { field: tool.name, operator: equals, value: Bash }
`).document,
      },
      local(`version: 1
rules:
  - id: local-asks
    name: Local asks
    effect: ask
    mandatory: true
    conditions:
      - { field: tool.name, operator: equals, value: Bash }
`),
    );
    expect(evaluatePolicy(set, shell("ls"), CONTEXT).evaluation.effect).toBe(
      "deny",
    );
  });

  it("reports no floor once the effect is resolved, whatever an untrusted rule asked", () => {
    const set = compiled(
      local(`version: 1
rules:
  - id: local-denies
    name: Local denies
    effect: deny
    conditions:
      - { field: tool.name, operator: equals, value: Bash }
`),
      {
        source: "project",
        trusted: false,
        document: local(`version: 1
rules:
  - id: repo-asks
    name: The repository asks
    effect: ask
    conditions:
      - { field: tool.name, operator: equals, value: Bash }
`).document,
      },
    );
    const result = evaluatePolicy(set, shell("ls"), CONTEXT);
    expect(result.evaluation.effect).toBe("deny");
    expect(result.floor).toBeUndefined();
    const resolution = resolve(
      set.rules.filter((rule) => rule.source !== "built-in"),
    );
    expect(resolution.effect).toBe("deny");
    expect("floor" in resolution).toBe(false);
  });

  it("answers `exists` with no for a field the action does not have, whatever the rule", () => {
    const denies = compiled(
      local(`version: 1
rules:
  - id: deny-network
    name: Deny anything that names a host
    effect: deny
    conditions:
      - { field: network.host, operator: exists }
`),
    );
    const offline = evaluatePolicy(denies, shell("git status"), CONTEXT);
    expect(
      offline.evaluation.matches.some(
        (match) => match.ruleId === "deny-network",
      ),
    ).toBe(false);
    expect(offline.evaluation.effect).not.toBe("deny");
    const online = evaluatePolicy(
      denies,
      shell("curl https://example.test/x"),
      CONTEXT,
    );
    expect(online.evaluation.effect).toBe("deny");
    // Under `not`, the plain question is still answered no, so the negated
    // condition holds: a rule about actions with no host matches this one.
    const denies_offline = compiled(
      local(`version: 1
rules:
  - id: deny-offline
    name: Deny anything that names no host
    effect: deny
    conditions:
      - { not: { field: network.host, operator: exists } }
`),
    );
    expect(
      evaluatePolicy(denies_offline, shell("git status"), CONTEXT).evaluation
        .effect,
    ).toBe("deny");
  });

  it("denies a command whose paths it cannot read, under a rule that denies paths outside the project", () => {
    const denies = compiled(
      local(`version: 1
rules:
  - id: deny-outside
    name: Deny anything outside the project
    effect: deny
    conditions:
      - { not: { field: path, operator: path_within, value: "\${project}" } }
`),
    );
    // `$DIR` is not read: the paths are an open list, and "every path is
    // inside the project" cannot be said of it.
    const open = evaluatePolicy(denies, shell("rm -rf $DIR"), CONTEXT);
    expect(open.evaluation.effect).toBe("deny");
    expect(
      open.evaluation.matches.some((match) => match.ruleId === "deny-outside"),
    ).toBe(true);
    // Of a command that names no path at all, and is understood, the rule
    // says nothing.
    const none = evaluatePolicy(denies, shell("git status"), CONTEXT);
    expect(
      none.evaluation.matches.some((match) => match.ruleId === "deny-outside"),
    ).toBe(false);
  });
});
