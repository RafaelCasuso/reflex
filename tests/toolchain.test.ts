import { describe, expect, it } from "vitest";

import { readJson, readManifest, readText } from "./support/repo.js";

/** RFX-001 — root workspace, strict TS, lint, formatting and test commands. */
describe("RFX-001 toolchain", () => {
  const root = readManifest(".");

  it("exposes every quality gate as a root script", () => {
    for (const gate of ["lint", "typecheck", "test", "build", "format:check"]) {
      expect(root.scripts, `missing root script "${gate}"`).toHaveProperty([
        gate,
      ]);
    }
  });

  it("pins the package manager to an exact version for local/CI parity", () => {
    expect(root.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it("targets the current Node.js LTS line in engines and .nvmrc", () => {
    expect(root.engines.node).toBe(">=24");
    expect(readText(".nvmrc").trim()).toBe("24");
  });

  it("is never publishable from the workspace root", () => {
    expect(root.isPrivate).toBe(true);
  });

  // Adversarial: strictness is a safety property of this codebase. Dropping
  // a flag from the shared base must fail a test, not pass silently.
  it("does not let TypeScript strictness weaken silently", () => {
    expect(readJson("tsconfig.base.json")).toMatchObject({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noImplicitOverride: true,
        noImplicitReturns: true,
        noFallthroughCasesInSwitch: true,
        verbatimModuleSyntax: true,
        erasableSyntaxOnly: true,
      },
    });
  });
});
