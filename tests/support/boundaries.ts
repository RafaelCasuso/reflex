import type { PackageManifest } from "./repo.js";

/**
 * The "Forbidden" dependency directions from CLAUDE.md, encoded
 * independently of eslint.config.mjs on purpose: weakening the lint config
 * must not also weaken the test that guards it.
 *
 * A trailing `*` matches any suffix. Names are workspace package names
 * without the `@reflex/` scope.
 */
export interface ForbiddenEdge {
  readonly from: string;
  readonly to: string;
  readonly rule: string;
}

export const FORBIDDEN_EDGES: readonly ForbiddenEdge[] = [
  { from: "core", to: "adapter-*", rule: "core -> adapter-*" },
  {
    from: "core",
    to: "provider-jev",
    rule: "Jev is a provider, not the architecture",
  },
  {
    from: "policy-engine",
    to: "provider-*",
    rule: "policy-engine -> provider-*",
  },
  { from: "contracts", to: "*", rule: "contracts -> anything" },
  { from: "adapter-*", to: "provider-jev", rule: "adapter -> provider-jev" },
  { from: "provider-jev", to: "core", rule: "provider-jev -> core" },
];

export interface BoundaryViolation {
  readonly from: string;
  readonly to: string;
  readonly rule: string;
}

const SCOPE = "@reflex/";

function matches(pattern: string, name: string): boolean {
  return pattern.endsWith("*")
    ? name.startsWith(pattern.slice(0, -1))
    : name === pattern;
}

/** Every declared workspace edge that CLAUDE.md forbids. */
export function findForbiddenEdges(
  manifests: readonly PackageManifest[],
): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];

  for (const manifest of manifests) {
    if (!manifest.name.startsWith(SCOPE)) {
      continue;
    }
    const from = manifest.name.slice(SCOPE.length);

    for (const dependency of Object.keys(manifest.allDependencies)) {
      if (!dependency.startsWith(SCOPE)) {
        continue;
      }
      const to = dependency.slice(SCOPE.length);

      for (const edge of FORBIDDEN_EDGES) {
        if (matches(edge.from, from) && matches(edge.to, to)) {
          violations.push({ from, to, rule: edge.rule });
        }
      }
    }
  }

  return violations;
}
