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
    forbidden: ["@reflex/*"],
    reason: "contracts -> anything is forbidden: contracts is the root.",
  },
  {
    files: ["packages/core/**"],
    forbidden: ["@reflex/adapter-*", "@reflex/provider-jev"],
    reason:
      "core -> adapter-* is forbidden, and core must depend on the SemanticDecisionProvider interface, never on Jev.",
  },
  {
    files: ["packages/policy-engine/**"],
    forbidden: ["@reflex/provider-*"],
    reason:
      "policy-engine -> provider-* is forbidden: deterministic policy never touches a semantic provider.",
  },
  {
    files: ["packages/adapter-*/**"],
    forbidden: ["@reflex/provider-jev"],
    reason: "adapter -> provider-jev is forbidden.",
  },
  {
    files: ["packages/provider-jev/**"],
    forbidden: ["@reflex/core"],
    reason: "provider-jev -> core is forbidden.",
  },
  {
    files: ["packages/command-classifier/**"],
    forbidden: [
      "@reflex/core",
      "@reflex/policy-engine",
      "@reflex/context-compiler",
      "@reflex/semantic-provider",
      "@reflex/provider-*",
      "@reflex/adapter-*",
      "@reflex/telemetry",
      "@reflex/cli",
      "@reflex/auth",
      "@reflex/evals",
      "@reflex/sdk-*",
    ],
    reason:
      "command-classifier -> contracts only (ADR-011): it is shared by adapters and by the engine, so it may depend on neither.",
  },
];

/** Reaching into another package's src/ or dist/ bypasses its manifest. */
const CROSS_PACKAGE_RELATIVE_IMPORT = {
  regex: "^(\\.\\./)+.*/(src|dist)(/|$)",
  message:
    "Import other workspace packages by name (@reflex/*), never by relative path.",
};

/**
 * `no-restricted-imports` options are replaced, not merged, when several
 * config objects match a file — so every entry carries the global pattern.
 */
function restrictedImports(extraPatterns = []) {
  return [
    "error",
    { patterns: [CROSS_PACKAGE_RELATIVE_IMPORT, ...extraPatterns] },
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
