import { describe, expect, it } from "vitest";

import { auditWorkflow, SECURITY_REQUIREMENTS } from "./support/ci.js";
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

/** RFX-090 — a vulnerable dependency or a committed secret fails a check. */
describe("RFX-090 supply-chain security gates", () => {
  const workflow = readText(".github", "workflows", "security.yml");
  const audit = (text: string) => auditWorkflow(text, SECURITY_REQUIREMENTS);
  const replace = (from: string, to: string) => (text: string) => {
    expect(text, `fixture drift: "${from}" not found`).toContain(from);
    return text.replace(from, to);
  };

  it("passes the audit as committed", () => {
    expect(audit(workflow)).toEqual([]);
  });

  it("also runs on a schedule, because a dependency can go bad without a commit", () => {
    expect(workflow).toMatch(/^ {2}schedule:\n {4}(?:#.*\n {4})?- cron: /m);
  });

  // Adversarial: ways the security gate could be made to pass without
  // protecting anything.
  it.each([
    {
      label: "the secret scan is told to succeed whatever it finds",
      tamper: replace("--exit-code 1", "--exit-code 0"),
      expected:
        'missing quality gate "gitleaks git . --no-banner --redact --exit-code 1"',
    },
    {
      label: "the audit only fails on critical advisories",
      tamper: replace("--audit-level=high", "--audit-level=critical"),
      expected: 'missing quality gate "pnpm audit --audit-level=high"',
    },
    {
      label: "the audit result is swallowed",
      tamper: replace(
        "run: pnpm audit --audit-level=high",
        "run: pnpm audit --audit-level=high || true",
      ),
      expected:
        'gate result can be swallowed: "pnpm audit --audit-level=high || true"',
    },
    {
      label: "the scanner is installed without its checksum script",
      tamper: replace(
        "run: bash .github/scripts/install-gitleaks.sh",
        "run: curl -sSfL https://example.com/install.sh | sh",
      ),
      expected:
        'missing quality gate "bash .github/scripts/install-gitleaks.sh"',
    },
    {
      label: "an action floats on a mutable tag",
      tamper: replace(
        "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413",
        "pnpm/action-setup@v6",
      ),
      expected: 'action is not pinned to a commit SHA: "pnpm/action-setup@v6"',
    },
    {
      label: "the secret scan may fail without failing the job",
      tamper: replace(
        "        run: gitleaks git",
        "        continue-on-error: true\n        run: gitleaks git",
      ),
      expected: "continue-on-error lets a failed gate pass",
    },
  ])("rejects the workflow when $label", ({ tamper, expected }) => {
    expect(audit(tamper(workflow))).toContain(expected);
  });

  it("installs the scanner at a pinned version and verifies its checksum", () => {
    const script = readText(".github", "scripts", "install-gitleaks.sh");
    expect(script).toContain("set -euo pipefail");
    expect(script).toMatch(/^VERSION="\d+\.\d+\.\d+"$/m);
    expect(script).toMatch(/^SHA256="[0-9a-f]{64}"$/m);
    expect(script).toContain("sha256sum --check --strict");
    // The checksum is verified before anything is unpacked.
    expect(script.indexOf("sha256sum")).toBeLessThan(script.indexOf("tar -x"));
  });

  // Measured while building this: in directory mode gitleaks skips an
  // allowlisted path entirely, so a path rule for test files hid real GitHub,
  // AWS and Stripe tokens. The allowlist must match findings, never files.
  it("allowlists fake test secrets by exact shape, never by path", () => {
    const config = readText(".gitleaks.toml")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    expect(config).toContain("useDefault = true");
    expect(config).toContain('regexTarget = "match"');
    expect(config).not.toMatch(/^\s*paths\s*=/m);
    expect(config).not.toMatch(/^\s*commits\s*=/m);
    expect(config).not.toMatch(/^\s*stopwords\s*=/m);
  });

  it("asks Dependabot to move the pinned actions and the dependencies", () => {
    const dependabot = readText(".github", "dependabot.yml");
    expect(dependabot).toContain("package-ecosystem: github-actions");
    expect(dependabot).toContain("package-ecosystem: npm");
  });

  // Dependabot's first pull request proposed TypeScript 7 and @types/node 26.
  // Both fail this repository for a known reason, so they are not proposed
  // again every week. The reasons, and when to lift them, are in the file.
  it("does not ask for upgrades that are known to break the toolchain", () => {
    const dependabot = readText(".github", "dependabot.yml");
    expect(dependabot).toMatch(
      /dependency-name: typescript\n\s+update-types:\n\s+- version-update:semver-major\n\s+- version-update:semver-minor/,
    );
    expect(dependabot).toMatch(
      /dependency-name: "@types\/node"\n\s+update-types:\n\s+- version-update:semver-major/,
    );
  });
});
