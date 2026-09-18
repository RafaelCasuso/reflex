import { defineConfig } from "vitest/config";

/**
 * Repo-level integrity tests only (workspace shape, architectural
 * boundaries, CI gates, ADR index). Package tests run inside each package
 * via `turbo run test`.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Typed ESLint runs inside tests/boundaries.test.ts; cold start is slow.
    testTimeout: 60_000,
  },
});
