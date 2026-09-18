import { describe, expect, it } from "vitest";

import { auditWorkflow } from "./support/ci.js";
import { readText } from "./support/repo.js";

/** RFX-003 — PR fails on any quality gate; CI uses lockfile-frozen install. */
describe("RFX-003 CI quality gates", () => {
  const workflow = readText(".github", "workflows", "ci.yml");

  it("passes the audit as committed", () => {
    expect(auditWorkflow(workflow)).toEqual([]);
  });

  // Adversarial: each tampering is a way a quality gate could quietly stop
  // failing pull requests. The audit must catch every one of them.
  const replace = (from: string, to: string) => (text: string) => {
    expect(text, `fixture drift: "${from}" not found`).toContain(from);
    return text.replace(from, to);
  };

  it.each([
    {
      label: "a gate is deleted",
      tamper: replace("run: pnpm typecheck", "run: echo skipped"),
      expected: 'missing quality gate "pnpm typecheck"',
    },
    {
      label: "a gate's exit code is swallowed",
      tamper: replace("run: pnpm test", "run: pnpm test || true"),
      expected: 'gate result can be swallowed: "pnpm test || true"',
    },
    {
      label: "a gate is chained into a forced success",
      tamper: replace("run: pnpm lint", "run: pnpm lint; exit 0"),
      expected: 'gate result can be swallowed: "pnpm lint; exit 0"',
    },
    {
      label: "a gate is allowed to fail",
      tamper: replace(
        "        run: pnpm build",
        "        continue-on-error: true\n        run: pnpm build",
      ),
      expected: "continue-on-error lets a failed gate pass",
    },
    {
      label: "the lockfile is no longer frozen",
      tamper: replace(
        "pnpm install --frozen-lockfile",
        "pnpm install --no-frozen-lockfile",
      ),
      expected: 'missing "pnpm install --frozen-lockfile"',
    },
    {
      label: "an extra unfrozen install sneaks in",
      tamper: replace(
        "        run: pnpm build",
        "        run: pnpm build\n      - run: pnpm add left-pad",
      ),
      expected: 'install is not lockfile-frozen: "pnpm add left-pad"',
    },
    {
      label: "a gate hides in an unauditable multi-line block",
      tamper: replace("run: pnpm test", "run: |\n          pnpm test"),
      expected: "multi-line run blocks cannot be audited; use one line",
    },
    {
      label: "an action floats on a mutable tag",
      tamper: replace(
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "actions/checkout@v7",
      ),
      expected: 'action is not pinned to a commit SHA: "actions/checkout@v7"',
    },
    {
      label: "pull requests stop triggering CI",
      tamper: replace("  pull_request:\n", ""),
      expected: "workflow does not run on pull_request",
    },
    {
      label: "a gate is only commented out",
      tamper: replace("run: pnpm lint", "# run: pnpm lint"),
      expected: 'missing quality gate "pnpm lint"',
    },
  ])("rejects the workflow when $label", ({ tamper, expected }) => {
    expect(auditWorkflow(tamper(workflow))).toContain(expected);
  });
});
