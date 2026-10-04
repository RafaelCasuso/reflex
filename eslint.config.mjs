import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

/**
 * Architectural dependency direction — the "Forbidden" list in CLAUDE.md.
 *
 * This is the fast-feedback layer. The authoritative check is
 * tests/workspace.test.ts, which asserts the same edges are absent from every
 * package manifest (pnpm's isolated node_modules makes an undeclared
 * workspace import unresolvable, which also covers dynamic imports).
 *
 * `dashboard -> database` has no package to point at yet; it is added when a
 * database package exists (G10).
 */
const FORBIDDEN_DEPENDENCIES = [
  {
    files: ["packages/contracts/**"],
    forbidden: ["@reflex-control/*"],
    reason: "contracts -> anything is forbidden: contracts is the root.",
  },
  {
    files: ["packages/core/**"],
    forbidden: ["@reflex-control/adapter-*", "@reflex-control/provider-*"],
    reason:
      "core -> adapter-* is forbidden, and core must depend on the SemanticDecisionProvider interface, never on a provider.",
  },
  {
    files: ["packages/policy-engine/**"],
    forbidden: ["@reflex-control/provider-*"],
    reason:
      "policy-engine -> provider-* is forbidden: deterministic policy never touches a semantic provider.",
  },
  {
    files: ["packages/adapter-*/**"],
    forbidden: ["@reflex-control/provider-*"],
    reason: "adapter -> provider-* is forbidden.",
  },
  {
    files: ["packages/provider-*/**"],
    forbidden: ["@reflex-control/core"],
    reason:
      "provider-* -> core is forbidden: a provider assesses, it never decides.",
  },
  {
    files: ["packages/command-classifier/**"],
    forbidden: [
      "@reflex-control/core",
      "@reflex-control/policy-engine",
      "@reflex-control/context-compiler",
      "@reflex-control/semantic-provider",
      "@reflex-control/provider-*",
      "@reflex-control/adapter-*",
      "@reflex-control/telemetry",
      "@reflex-control/cli",
      "@reflex-control/auth",
      "@reflex-control/evals",
      "@reflex-control/sdk-*",
    ],
    reason:
      "command-classifier -> contracts only (ADR-011): it is shared by adapters and by the engine, so it may depend on neither.",
  },
];

/** Reaching into another package's src/ or dist/ bypasses its manifest. */
const CROSS_PACKAGE_RELATIVE_IMPORT = {
  regex: "^(\\.\\./)+.*/(src|dist)(/|$)",
  message:
    "Import other workspace packages by name (@reflex-control/*), never by relative path.",
};

// ADR-015, ADR-016 §5: RDM is a private Python module whose only contract
// with the product is the canonical one, over @reflex-control/provider-local.
const RDM_RELATIVE_IMPORT = {
  regex: "^(\\.\\./)+rdm(/|$)",
  message:
    "Nothing in packages/ or apps/ imports from rdm/. RDM is reached through @reflex-control/provider-local (ADR-016).",
};

/**
 * `no-restricted-imports` options are replaced, not merged, when several
 * config objects match a file — so every entry carries the global pattern.
 */
function restrictedImports(extraPatterns = []) {
  return [
    "error",
    {
      patterns: [
        CROSS_PACKAGE_RELATIVE_IMPORT,
        RDM_RELATIVE_IMPORT,
        ...extraPatterns,
      ],
    },
  ];
}

export default defineConfig(
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/.turbo/**",
    "**/coverage/**",
  ]),

  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // CLAUDE.md: "Never log raw tool arguments before redaction."
      // Output goes through an explicit, reviewed channel — not console.
      "no-console": "error",
      "no-restricted-imports": restrictedImports(),
    },
  },

  {
    files: ["**/*.ts", "**/*.mts", "**/*.cts"],
    rules: {
      // CLAUDE.md: "Use exhaustive `switch` on discriminated unions."
      // A `default` branch does not count: adding a DecisionEffect or
      // SideEffectClass member must break every switch that ignores it.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        {
          considerDefaultExhaustiveForUnions: false,
          requireDefaultForNonUnion: true,
        },
      ],
    },
  },

  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  ...FORBIDDEN_DEPENDENCIES.map(({ files, forbidden, reason }) => ({
    files,
    rules: {
      "no-restricted-imports": restrictedImports([
        { group: forbidden, message: `${reason} See CLAUDE.md.` },
      ]),
    },
  })),
);
