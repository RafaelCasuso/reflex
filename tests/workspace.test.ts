import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { findForbiddenEdges } from "./support/boundaries.js";
import {
  parseManifest,
  readManifest,
  repoPath,
  type PackageManifest,
} from "./support/repo.js";

/**
 * RFX-002 — the workspace matches docs/architecture.md §2 exactly.
 *
 * Adding, renaming or removing a package is an architectural change: update
 * the architecture document (and an ADR if boundaries move) together with
 * this list.
 */
const EXPECTED_WORKSPACES: Readonly<Record<string, readonly string[]>> = {
  apps: ["api", "dashboard", "decision-gateway"],
  packages: [
    "adapter-claude-code",
    "adapter-codex",
    "adapter-mcp",
    "auth",
    "cli",
    "command-classifier",
    "context-compiler",
    "contracts",
    "core",
    "evals",
    "policy-engine",
    "provider-jev",
    "sdk-typescript",
    "semantic-provider",
    "telemetry",
  ],
};

const QUALITY_GATE_SCRIPTS = ["build", "typecheck", "lint", "test"] as const;

function directoriesIn(parent: string): readonly string[] {
  return readdirSync(repoPath(parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

const workspaces = Object.entries(EXPECTED_WORKSPACES).flatMap(
  ([parent, names]) => names.map((name) => ({ parent, name })),
);

const manifests: readonly PackageManifest[] = workspaces.map(
  ({ parent, name }) => readManifest(parent, name),
);

describe("RFX-002 workspace shape", () => {
  it.each(Object.keys(EXPECTED_WORKSPACES))(
    "%s/ contains exactly the documented directories",
    (parent) => {
      expect(directoriesIn(parent)).toEqual(EXPECTED_WORKSPACES[parent]);
    },
  );

  describe.each(workspaces)("$parent/$name", ({ parent, name }) => {
    const manifest = readManifest(parent, name);

    it("is named after its directory under the @reflex scope", () => {
      expect(manifest.name).toBe(`@reflex/${name}`);
    });

    it("cannot be published by accident", () => {
      expect(manifest.isPrivate).toBe(true);
    });

    it("takes part in every quality gate", () => {
      for (const script of QUALITY_GATE_SCRIPTS) {
        expect(manifest.scripts, `missing "${script}" script`).toHaveProperty([
          script,
        ]);
      }
    });

    it.skipIf(name === "contracts")(
      "depends on the canonical contracts through the workspace protocol",
      () => {
        expect(manifest.allDependencies["@reflex/contracts"]).toBe(
          "workspace:*",
        );
      },
    );
  });
});

describe("architectural dependency direction (CLAUDE.md)", () => {
  it("has no forbidden edge in any package manifest", () => {
    expect(findForbiddenEdges(manifests)).toEqual([]);
  });

  it("keeps contracts free of workspace dependencies", () => {
    const contracts = readManifest("packages", "contracts");
    const workspaceDependencies = Object.keys(contracts.allDependencies).filter(
      (dependency) => dependency.startsWith("@reflex/"),
    );

    expect(workspaceDependencies).toEqual([]);
  });

  // Adversarial: prove the detector itself cannot be slipped past. Each
  // fabricated manifest hides a forbidden edge somewhere a careless check
  // would not look.
  it("detects forbidden edges wherever they are declared", () => {
    const fabricate = (name: string, dependency: string): PackageManifest => ({
      name,
      isPrivate: true,
      packageManager: undefined,
      scripts: {},
      engines: {},
      allDependencies: { [dependency]: "workspace:*" },
    });

    const violations = findForbiddenEdges([
      fabricate("@reflex/core", "@reflex/adapter-codex"),
      fabricate("@reflex/core", "@reflex/provider-jev"),
      fabricate("@reflex/policy-engine", "@reflex/provider-jev"),
      fabricate("@reflex/contracts", "@reflex/core"),
      fabricate("@reflex/adapter-mcp", "@reflex/provider-jev"),
      fabricate("@reflex/provider-jev", "@reflex/core"),
      // Allowed edges must stay allowed: no false positives.
      fabricate("@reflex/core", "@reflex/policy-engine"),
      fabricate("@reflex/provider-jev", "@reflex/semantic-provider"),
      fabricate("@reflex/decision-gateway", "@reflex/provider-jev"),
    ]);

    expect(violations.map(({ from, to }) => `${from} -> ${to}`)).toEqual([
      "core -> adapter-codex",
      "core -> provider-jev",
      "policy-engine -> provider-jev",
      "contracts -> core",
      "adapter-mcp -> provider-jev",
      "provider-jev -> core",
    ]);
  });

  // Adversarial: a forbidden edge is forbidden wherever it is declared. Hide
  // it in each dependency field in turn, through the same parser that reads
  // the real manifests.
  it.each([
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ])("finds a forbidden edge hidden in %s", (field) => {
    const manifest = parseManifest(
      {
        name: "@reflex/core",
        dependencies: { "@reflex/contracts": "workspace:*" },
        [field]: { "@reflex/adapter-claude-code": "workspace:*" },
      },
      `fabricated(${field})`,
    );

    expect(findForbiddenEdges([manifest])).toEqual([
      { from: "core", to: "adapter-claude-code", rule: "core -> adapter-*" },
    ]);
  });
});
