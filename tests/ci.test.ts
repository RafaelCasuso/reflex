import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  auditWorkflow,
  HOST_SCHEMA_REQUIREMENTS,
  MUTATION_REQUIREMENTS,
  PUBLIC_HISTORY_REQUIREMENTS,
  RELEASE_REQUIREMENTS,
  SECURITY_REQUIREMENTS,
} from "./support/ci.js";
import { readJson, readText, repoPath } from "./support/repo.js";

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

/** RFX-111 — a surviving mutant in a decision path fails a scheduled check. */
describe("RFX-111 mutation check", () => {
  const workflow = readText(".github", "workflows", "mutation.yml");
  const audit = (text: string) => auditWorkflow(text, MUTATION_REQUIREMENTS);

  it("passes the audit as committed", () => {
    expect(audit(workflow)).toEqual([]);
  });

  it("runs on a schedule, on demand, and on a pull request only when the check itself changes", () => {
    expect(workflow).toMatch(/^ {2}schedule:\n {4}(?:#.*\n {4})?- cron: /m);
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toMatch(
      /^ {2}pull_request:\n {4}paths:\n {6}- "tools\/mutate\.mjs"/m,
    );
  });

  it("targets the decision paths, and every target file exists", () => {
    const targets = readJson("tools", "mutation-targets.json") as {
      targets: { package: string; files: string[] }[];
    };
    const paths = targets.targets.flatMap((target) =>
      target.files.map((file) => `${target.package}/${file}`),
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "packages/policy-engine/src/matcher.ts",
        "packages/policy-engine/src/precedence.ts",
        "packages/command-classifier/src/classify.ts",
        "packages/context-compiler/src/redact.ts",
        "packages/core/src/risk-aggregator.ts",
        "packages/core/src/fallback.ts",
      ]),
    );
    for (const path of paths) {
      expect(existsSync(repoPath(path)), path).toBe(true);
    }
  });

  it("justifies every allowed survivor with a reason that names its place", () => {
    const allowlist = readJson("tools", "mutation-allowlist.json") as {
      justified: {
        package: string;
        file: string;
        line: number;
        operator: string;
        reason: string;
      }[];
    };
    for (const entry of allowlist.justified) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(Number.isInteger(entry.line) && entry.line > 0).toBe(true);
      expect(existsSync(repoPath(entry.package, entry.file))).toBe(true);
    }
  });

  it("refuses to run on uncommitted target files, so a run can never hide a change", () => {
    const script = readText("tools", "mutate.mjs");
    expect(script).toContain("git");
    expect(script).toContain("--allow-dirty");
    expect(script).toContain("was not restored");
  });
});

/** RFX-124 — a host release that changes what the adapter reads fails a check. */
describe("RFX-124 host schema canary", () => {
  const workflow = readText(".github", "workflows", "host-schema.yml");
  const audit = (text: string) => auditWorkflow(text, HOST_SCHEMA_REQUIREMENTS);

  it("passes the audit as committed", () => {
    expect(audit(workflow)).toEqual([]);
  });

  it("runs daily, on demand, and on a pull request that changes what the adapter reads", () => {
    expect(workflow).toMatch(
      /^ {2}schedule:\n {4}(?:#.*\n {4})?- cron: "0 7 \* \* \*"/m,
    );
    expect(workflow).toContain("workflow_dispatch:");
    for (const path of [
      "packages/adapter-claude-code/src/host-schema.ts",
      "packages/adapter-claude-code/src/translate.ts",
      "packages/adapter-claude-code/fixtures/**",
      "packages/adapter-claude-code/live/check-host-schema.mjs",
    ]) {
      expect(workflow).toContain(`- "${path}"`);
    }
  });

  it("has the script it runs, which spends nothing and needs no login", () => {
    const script = readText(
      "packages",
      "adapter-claude-code",
      "live",
      "check-host-schema.mjs",
    );
    expect(script).toContain("--ignore-scripts");
    expect(script).toContain("npm");
    expect(script).not.toContain("claude -p");
    expect(script).not.toContain("--max-budget");
  });

  it.each([
    {
      label: "the check is deleted",
      tamper: (text: string) =>
        text.replace(
          "run: node packages/adapter-claude-code/live/check-host-schema.mjs --latest",
          "run: echo skipped",
        ),
      expected:
        'missing quality gate "node packages/adapter-claude-code/live/check-host-schema.mjs --latest"',
    },
    {
      label: "the check's exit code is swallowed",
      tamper: (text: string) =>
        text.replace(
          "check-host-schema.mjs --latest",
          "check-host-schema.mjs --latest || true",
        ),
      expected:
        'gate result can be swallowed: "node packages/adapter-claude-code/live/check-host-schema.mjs --latest || true"',
    },
  ])("rejects the workflow when $label", ({ tamper, expected }) => {
    expect(audit(tamper(workflow))).toContain(expected);
  });
});

/** RFX-127 — a release is built, verified and published from CI, with provenance. */
describe("RFX-127 signed releases", () => {
  const workflow = readText(".github", "workflows", "release.yml");
  const audit = (text: string) => auditWorkflow(text, RELEASE_REQUIREMENTS);

  it("passes the audit as committed", () => {
    expect(audit(workflow)).toEqual([]);
  });

  it("runs only for a version tag pushed to the repository, never on demand or from a branch", () => {
    expect(workflow).toMatch(
      /^on:\n {2}push:\n {4}tags:\n {6}- "v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"/m,
    );
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).not.toMatch(/^ {4}branches:/m);
  });

  it("asks for the OIDC token that provenance needs, and writes nothing else", () => {
    expect(workflow).toMatch(/^ {6}id-token: write$/m);
    expect(workflow).toMatch(/^ {6}attestations: write$/m);
    expect(workflow).toMatch(/^ {6}contents: read$/m);
    expect(workflow).not.toMatch(/contents: write/);
  });

  it("sets every publishable version from the tag after the gates and before publishing", () => {
    expect(workflow).toContain(
      'node tools/release/set-version.mjs "${GITHUB_REF_NAME#v}"',
    );
    const publish = workflow.indexOf("pnpm -r publish");
    const version = workflow.indexOf("set-version.mjs");
    const test = workflow.indexOf("run: pnpm test");
    expect(version).toBeGreaterThan(test);
    expect(publish).toBeGreaterThan(version);
  });

  it.each([
    {
      label: "publish loses provenance",
      tamper: (text: string) => text.replace(" --provenance", ""),
      expected:
        'missing quality gate "pnpm -r publish --access public --provenance --no-git-checks"',
    },
    {
      label: "a gate is skipped before publishing",
      tamper: (text: string) =>
        text.replace("run: pnpm test", "run: echo skipped"),
      expected: 'missing quality gate "pnpm test"',
    },
  ])("rejects the workflow when $label", ({ tamper, expected }) => {
    expect(audit(tamper(workflow))).toContain(expected);
  });
});

/** RFX-149 — the public repository's history holds no private path. */
describe("RFX-149 public history check", () => {
  const workflow = readText(".github", "workflows", "public-history.yml");
  const audit = (text: string) =>
    auditWorkflow(text, PUBLIC_HISTORY_REQUIREMENTS);

  it("passes the audit as committed", () => {
    expect(audit(workflow)).toEqual([]);
  });

  it("runs only where the repository says it is the public one, with the whole history", () => {
    expect(workflow).toContain("if: ${{ vars.REFLEX_PUBLIC == 'true' }}");
    expect(workflow).toContain("fetch-depth: 0");
  });

  it("names every private path of docs/open-core.md, and nothing else", () => {
    const listed = readText("tools", "private-paths.txt")
      .split("\n")
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter((line) => line !== "")
      .sort();
    const openCore = readText("docs", "open-core.md");
    const privateSection = openCore.slice(
      openCore.indexOf("## Private"),
      openCore.indexOf("## Rules"),
    );
    const documented = [
      ...new Set(
        [...privateSection.matchAll(/`([^`]+)`/g)]
          .map((match) => match[1] ?? "")
          .filter(
            (cell) => /^(apps|packages)\//.test(cell) || /^rdm\/?$/.test(cell),
          )
          .map((path) => path.replace(/\/$/, "")),
      ),
    ].sort();
    expect(listed).toEqual(documented);
  });

  it("checks the working tree and every ref, and exits non-zero on a finding", () => {
    const script = readText("tools", "check-public-history.sh");
    expect(script).toContain("git log --all");
    expect(script).toContain("tools/private-paths.txt");
    expect(script).toContain('exit "$status"');
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
