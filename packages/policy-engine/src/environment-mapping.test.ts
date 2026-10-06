import { describe, expect, it } from "vitest";

import { resolveMappedEnvironment } from "./environment.js";
import { parsePolicy } from "./parser.js";

/**
 * RFX-084 — a project's `environments` mapping, and how an action's
 * environment is resolved from it (ADR-018).
 */
const MAPPED = `
version: 1
rules: []
environments:
  production:
    branches: ["main", "release/.*"]
    remotes: ["github.com/acme/.*"]
  staging:
    branches: [staging]
  development:
    branches: ["feature/.*"]
`;

function mappingOf(yaml: string) {
  const parsed = parsePolicy(yaml);
  if (!parsed.ok) {
    throw new Error(parsed.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.environments;
}

describe("RFX-084 the environments mapping", () => {
  it("parses into patterns per environment, and is not part of the document", () => {
    const parsed = parsePolicy(MAPPED);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.environments).toEqual({
      production: {
        branches: ["main", "release/.*"],
        remotes: ["github.com/acme/.*"],
      },
      staging: { branches: ["staging"] },
      development: { branches: ["feature/.*"] },
    });
    expect(parsed.document).toEqual({ version: 1, rules: [] });
    expect(mappingOf("version: 1\nrules: []\n")).toBeUndefined();
  });

  it.each([
    [
      "unknown cannot be mapped to",
      "environments:\n  unknown:\n    branches: [x]\n",
    ],
    ["an environment needs matchers", "environments:\n  production: {}\n"],
    [
      "only branches and remotes",
      "environments:\n  production:\n    hosts: [x]\n",
    ],
    [
      "a list, not a string",
      "environments:\n  production:\n    branches: main\n",
    ],
    ["a non-empty list", "environments:\n  production:\n    branches: []\n"],
    [
      "a pattern that compiles",
      "environments:\n  production:\n    branches: ['[']\n",
    ],
    ["a mapping, not a list", "environments:\n  - production\n"],
  ])("refuses %s", (_label, fragment) => {
    const parsed = parsePolicy(`version: 1\nrules: []\n${fragment}`);
    expect(parsed.ok).toBe(false);
  });

  describe("resolution", () => {
    const mapping = mappingOf(MAPPED);

    it("believes a host that says the environment, mapping or not", () => {
      expect(
        resolveMappedEnvironment({
          fromHost: "test",
          mapping,
          mappingTrusted: true,
          facts: { branch: "main" },
        }),
      ).toEqual({ environment: "test", by: "host" });
    });

    it("maps a branch or a remote, riskiest environment first", () => {
      const resolve = (facts: { branch?: string; remote?: string }) =>
        resolveMappedEnvironment({
          fromHost: "unknown",
          mapping,
          mappingTrusted: true,
          facts,
        });
      expect(resolve({ branch: "main" }).environment).toBe("production");
      expect(resolve({ branch: "release/2026.10" }).environment).toBe(
        "production",
      );
      expect(resolve({ branch: "staging" }).environment).toBe("staging");
      expect(resolve({ branch: "feature/x" }).environment).toBe("development");
      expect(
        resolve({ branch: "feature/x", remote: "github.com/acme/api" })
          .environment,
      ).toBe("production");
      expect(resolve({ branch: "topic" })).toEqual({
        environment: "unknown",
        by: "none",
      });
      // Anchored: a branch named like a riskier one is not it.
      expect(resolve({ branch: "maintenance" }).environment).toBe("unknown");
      expect(resolve({ branch: "not-main" }).environment).toBe("unknown");
      expect(resolve({})).toEqual({ environment: "unknown", by: "none" });
    });

    it("is unknown with no mapping or no facts", () => {
      expect(
        resolveMappedEnvironment({
          fromHost: "unknown",
          mapping: undefined,
          mappingTrusted: true,
          facts: { branch: "main" },
        }).environment,
      ).toBe("unknown");
      expect(
        resolveMappedEnvironment({
          fromHost: "unknown",
          mapping,
          mappingTrusted: true,
          facts: undefined,
        }).environment,
      ).toBe("unknown");
    });

    // Adversarial: a hostile repository maps the branch it ships to
    // `development` to dodge the production rules. Untrusted, it may only
    // raise the environment; the claim to development is ignored.
    it("lets an untrusted mapping raise the environment and never lower it", () => {
      const hostile = mappingOf(`
version: 1
rules: []
environments:
  development:
    branches: [".*"]
  production:
    branches: [main]
`);
      expect(
        resolveMappedEnvironment({
          fromHost: "unknown",
          mapping: hostile,
          mappingTrusted: false,
          facts: { branch: "topic" },
        }),
      ).toEqual({ environment: "unknown", by: "none" });
      expect(
        resolveMappedEnvironment({
          fromHost: "unknown",
          mapping: hostile,
          mappingTrusted: false,
          facts: { branch: "main" },
        }).environment,
      ).toBe("production");
      expect(
        resolveMappedEnvironment({
          fromHost: "unknown",
          mapping: hostile,
          mappingTrusted: true,
          facts: { branch: "topic" },
        }).environment,
      ).toBe("development");
    });
  });
});
