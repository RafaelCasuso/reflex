import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { REPO_ROOT, repoPath } from "./support/repo.js";

/**
 * Adversarial tests for the lint layer of the architectural boundaries.
 *
 * Each case lints an in-memory buffer *as if* it were a real source file of
 * the named package, using the repository's effective ESLint config. The
 * goal is to get a forbidden import past `no-restricted-imports`.
 */
const eslint = new ESLint({ cwd: REPO_ROOT });

async function restrictedImportsIn(
  packageDir: string,
  code: string,
): Promise<readonly string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: repoPath(packageDir, "src", "index.ts"),
  });
  if (result === undefined) {
    throw new Error(`ESLint ignored ${packageDir}: nothing was linted`);
  }

  // A parser/config crash runs no rules at all, which would make every
  // "permits" case pass vacuously. Fail loudly instead.
  const fatal = result.messages.find((message) => message.fatal === true);
  if (fatal !== undefined) {
    throw new Error(`ESLint could not lint ${packageDir}: ${fatal.message}`);
  }

  return result.messages
    .filter((message) => message.ruleId === "no-restricted-imports")
    .map((message) => message.message);
}

interface BoundaryCase {
  readonly label: string;
  readonly packageDir: string;
  readonly code: string;
}

const FORBIDDEN: readonly BoundaryCase[] = [
  {
    label: "contracts -> anything",
    packageDir: "packages/contracts",
    code: 'import type {} from "@reflex/core";',
  },
  {
    label: "core -> adapter-*",
    packageDir: "packages/core",
    code: 'import "@reflex/adapter-claude-code";',
  },
  {
    label: "core -> provider-jev",
    packageDir: "packages/core",
    code: 'import "@reflex/provider-jev";',
  },
  {
    label: "policy-engine -> provider-*",
    packageDir: "packages/policy-engine",
    code: 'import "@reflex/provider-jev";',
  },
  {
    label: "adapter -> provider-jev",
    packageDir: "packages/adapter-codex",
    code: 'import "@reflex/provider-jev";',
  },
  {
    label: "provider-jev -> core",
    packageDir: "packages/provider-jev",
    code: 'import "@reflex/core";',
  },
  {
    label: "type-only imports are still dependencies",
    packageDir: "packages/core",
    code: 'import type {} from "@reflex/adapter-mcp";',
  },
  {
    label: "re-exports are still dependencies",
    packageDir: "packages/core",
    code: 'export * from "@reflex/adapter-codex";',
  },
  {
    label: "deep subpath imports do not dodge the package pattern",
    packageDir: "packages/policy-engine",
    code: 'import "@reflex/provider-jev/dist/client.js";',
  },
  {
    label: "relative path into another package's src/",
    packageDir: "packages/core",
    code: 'import "../../adapter-codex/src/index.js";',
  },
  {
    label: "relative path into another package's dist/",
    packageDir: "packages/provider-jev",
    code: 'import "../../core/dist/index.js";',
  },
  {
    label: "relative escape from a package with no named restrictions",
    packageDir: "packages/telemetry",
    code: 'import "../../auth/src/index.js";',
  },
];

const ALLOWED: readonly BoundaryCase[] = [
  {
    label: "core -> contracts",
    packageDir: "packages/core",
    code: 'import type {} from "@reflex/contracts";',
  },
  {
    label: "core -> policy-engine",
    packageDir: "packages/core",
    code: 'import "@reflex/policy-engine";',
  },
  {
    label: "core -> semantic-provider",
    packageDir: "packages/core",
    code: 'import "@reflex/semantic-provider";',
  },
  {
    label: "provider-jev -> semantic-provider",
    packageDir: "packages/provider-jev",
    code: 'import "@reflex/semantic-provider";',
  },
  {
    label: "adapter -> sdk",
    packageDir: "packages/adapter-codex",
    code: 'import "@reflex/sdk-typescript";',
  },
  {
    label: "relative imports inside the same package",
    packageDir: "packages/core",
    code: 'import "./fallback.js"; import "../src/fallback.js";',
  },
];

describe("lint-enforced dependency direction", () => {
  it.each(FORBIDDEN)("blocks: $label", async ({ packageDir, code }) => {
    await expect(restrictedImportsIn(packageDir, code)).resolves.toHaveLength(
      1,
    );
  });

  it.each(ALLOWED)("permits: $label", async ({ packageDir, code }) => {
    await expect(restrictedImportsIn(packageDir, code)).resolves.toEqual([]);
  });

  it("explains a violation by pointing at CLAUDE.md", async () => {
    const [message] = await restrictedImportsIn(
      "packages/core",
      'import "@reflex/adapter-codex";',
    );

    expect(message).toContain("core -> adapter-* is forbidden");
    expect(message).toContain("CLAUDE.md");
  });
});
