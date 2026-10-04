import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { findForbiddenEdges } from "./support/boundaries.js";
import {
  parseManifest,
  readJson,
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
/**
 * RFX-149: the private packages exist only in the private monorepo. The
 * public repository (`docs/open-core.md`) has none of them, and this suite
 * runs there too: every directory present must be documented, every open
 * package must be present, and a private one is checked when it is there.
 */
const PRIVATE_WORKSPACES: Readonly<Record<string, readonly string[]>> = {
  apps: ["api", "dashboard"],
  packages: ["auth"],
};

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
    "provider-local",
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

const isPresent = ({ parent, name }: { parent: string; name: string }) =>
  directoriesIn(parent).includes(name);

const workspaces = Object.entries(EXPECTED_WORKSPACES)
  .flatMap(([parent, names]) => names.map((name) => ({ parent, name })))
  .filter(isPresent);

const isPrivateWorkspace = (parent: string, name: string): boolean =>
  (PRIVATE_WORKSPACES[parent] ?? []).includes(name);

const manifests: readonly PackageManifest[] = workspaces.map(
  ({ parent, name }) => readManifest(parent, name),
);

describe("RFX-002 workspace shape", () => {
  it.each(Object.keys(EXPECTED_WORKSPACES))(
    "%s/ contains documented directories only, every open one among them",
    (parent) => {
      const present = directoriesIn(parent);
      const documented = EXPECTED_WORKSPACES[parent] ?? [];
      for (const name of present) {
        expect(documented, `${parent}/${name} is not documented`).toContain(
          name,
        );
      }
      for (const name of documented) {
        if (!isPrivateWorkspace(parent, name)) {
          expect(present, `${parent}/${name} is missing`).toContain(name);
        }
      }
    },
  );

  describe.each(workspaces)("$parent/$name", ({ parent, name }) => {
    const manifest = readManifest(parent, name);

    it("is named after its directory under the @reflex scope", () => {
      expect(manifest.name).toBe(`@reflex/${name}`);
    });

    // RFX-127: an open package publishes from CI with provenance and ships
    // its dist only; a private one can never be published.
    it(
      isPrivateWorkspace(parent, name)
        ? "cannot be published"
        : "is publishable, public, with provenance, dist only",
      () => {
        const raw = readJson(parent, name, "package.json") as {
          private?: boolean;
          publishConfig?: { access?: string; provenance?: boolean };
          files?: string[];
          license?: string;
        };
        if (isPrivateWorkspace(parent, name)) {
          expect(raw.private).toBe(true);
          return;
        }
        expect(raw.private).toBeUndefined();
        expect(raw.publishConfig).toEqual({
          access: "public",
          provenance: true,
        });
        // dist always; a package may ship data next to it (evals: corpus),
        // never its sources.
        expect(raw.files).toContain("dist");
        expect(raw.files).not.toContain("src");
        expect(raw.license).toBe("Apache-2.0");
      },
    );

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
      fabricate("@reflex/core", "@reflex/provider-local"),
      fabricate("@reflex/adapter-codex", "@reflex/provider-local"),
      fabricate("@reflex/provider-local", "@reflex/core"),
      // Allowed edges must stay allowed: no false positives.
      fabricate("@reflex/core", "@reflex/policy-engine"),
      fabricate("@reflex/provider-jev", "@reflex/semantic-provider"),
      fabricate("@reflex/provider-local", "@reflex/semantic-provider"),
      fabricate("@reflex/decision-gateway", "@reflex/provider-jev"),
      fabricate("@reflex/decision-gateway", "@reflex/provider-local"),
    ]);

    expect(violations.map(({ from, to }) => `${from} -> ${to}`)).toEqual([
      "core -> adapter-codex",
      "core -> provider-jev",
      "policy-engine -> provider-jev",
      "contracts -> core",
      "adapter-mcp -> provider-jev",
      "provider-jev -> core",
      "core -> provider-local",
      "adapter-codex -> provider-local",
      "provider-local -> core",
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
