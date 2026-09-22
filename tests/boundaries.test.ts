import { readdirSync } from "node:fs";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import {
  REPO_ROOT,
  readJson,
  readManifest,
  readText,
  repoPath,
} from "./support/repo.js";

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
  {
    label: "nothing imports from rdm/ (ADR-016 §5)",
    packageDir: "packages/core",
    code: 'import "../../../rdm/inference/client.js";',
  },
  {
    label: "nothing re-exports from rdm/ either",
    packageDir: "packages/telemetry",
    code: 'export * from "../../../rdm/schema/index.js";',
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

/**
 * ADR-015 — the open-core boundary, enforced in place until the repositories
 * are split. `docs/open-core.md` is the list; this reads it.
 */
interface OpenCoreEntry {
  readonly name: string;
  readonly path: string;
  readonly side: "open" | "private";
}

function openCoreList(): readonly OpenCoreEntry[] {
  const text = readText("docs", "open-core.md");
  const entries: OpenCoreEntry[] = [];
  let side: OpenCoreEntry["side"] | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("## Open")) {
      side = "open";
    } else if (line.startsWith("## Private")) {
      side = "private";
    } else if (line.startsWith("## ")) {
      side = undefined;
    }
    const row =
      /^\| `(@reflex\/[a-z-]+)`\s+\| `((?:apps|packages)\/[a-z-]+)`/.exec(line);
    if (side !== undefined && row?.[1] !== undefined && row[2] !== undefined) {
      entries.push({ name: row[1], path: row[2], side });
    }
  }
  return entries;
}

function workspacePackageDirs(): readonly string[] {
  return ["apps", "packages"].flatMap((parent) =>
    readdirSync(repoPath(parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`),
  );
}

describe("open-core boundary (ADR-015)", () => {
  const listed = openCoreList();
  const byPath = new Map(listed.map((entry) => [entry.path, entry]));
  const privateNames = new Set(
    listed
      .filter((entry) => entry.side === "private")
      .map((entry) => entry.name),
  );

  it("lists every workspace package on one side, with the name its manifest has", () => {
    expect(listed.length).toBeGreaterThan(10);
    for (const dir of workspacePackageDirs()) {
      const entry = byPath.get(dir);
      expect(
        entry,
        `${dir} is on neither side of docs/open-core.md`,
      ).toBeDefined();
      expect(readManifest(dir).name, dir).toBe(entry?.name);
    }
  });

  it("declares in every manifest the licence the list gives it", () => {
    for (const entry of listed) {
      const raw = readJson(entry.path, "package.json") as { license?: unknown };
      expect(raw.license, entry.path).toBe(
        entry.side === "open" ? "Apache-2.0" : "UNLICENSED",
      );
    }
    expect(readText("LICENSE")).toContain("Apache License");
    expect(readText("LICENSE")).toContain("Version 2.0, January 2004");
  });

  it("never lets an open package depend on a private one", () => {
    for (const entry of listed) {
      if (entry.side !== "open") {
        continue;
      }
      const dependencies = Object.keys(
        readManifest(entry.path).allDependencies,
      );
      for (const dependency of dependencies) {
        expect(
          privateNames.has(dependency),
          `${entry.name} (open) depends on ${dependency} (private)`,
        ).toBe(false);
      }
    }
  });

  it("keeps rdm/ out of the workspace, so no workspace-wide publish reaches it", () => {
    expect(readText("pnpm-workspace.yaml")).not.toContain("rdm");
    expect(listed.some((entry) => entry.path.startsWith("rdm"))).toBe(false);
  });
});
