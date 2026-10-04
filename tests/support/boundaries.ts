import type { PackageManifest } from "./repo.js";

/**
 * The "Forbidden" dependency directions from CLAUDE.md, encoded
 * independently of eslint.config.mjs on purpose: weakening the lint config
 * must not also weaken the test that guards it.
 *
 * A trailing `*` matches any suffix. Names are workspace package names
 * without the `@reflex-control/` scope.
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
    to: "provider-*",
    rule: "a provider is not the architecture: core depends on the interface",
  },
  {
    from: "policy-engine",
    to: "provider-*",
    rule: "policy-engine -> provider-*",
  },
  { from: "contracts", to: "*", rule: "contracts -> anything" },
  { from: "adapter-*", to: "provider-*", rule: "adapter -> provider-*" },
  { from: "provider-*", to: "core", rule: "provider-* -> core" },
  // ADR-011: the classifier is shared by adapters and by the engine, so it may
  // depend on neither. It knows commands, not hosts, policies or providers.
  ...[
    "core",
    "policy-engine",
    "context-compiler",
    "semantic-provider",
    "provider-*",
    "adapter-*",
    "telemetry",
    "cli",
    "auth",
    "evals",
    "sdk-*",
  ].map((to) => ({
    from: "command-classifier",
    to,
    rule: "command-classifier -> contracts only",
  })),
];

export interface BoundaryViolation {
  readonly from: string;
  readonly to: string;
  readonly rule: string;
}

const SCOPE = "@reflex-control/";

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
