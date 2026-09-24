/**
 * Audits a GitHub Actions workflow for the RFX-003 guarantees.
 *
 * Deliberately text-based: it needs no YAML dependency, and the properties
 * it checks (“this exact command is present, nothing neutralises it”) are
 * textual. Returns human-readable problems; an empty list means compliant.
 */
export const REQUIRED_GATES = [
  "pnpm lint",
  "pnpm typecheck",
  "pnpm test",
  "pnpm build",
] as const;

const FROZEN_INSTALL = "pnpm install --frozen-lockfile";

export interface WorkflowRequirements {
  /** The exact install command the workflow must run, if it installs. */
  readonly install: string | undefined;
  /** Commands that must each be the whole of some `run` step. */
  readonly commands: readonly string[];
}

export const CI_REQUIREMENTS: WorkflowRequirements = {
  install: FROZEN_INSTALL,
  commands: REQUIRED_GATES,
};

/** RFX-090. Exact strings: a softer flag is a different command. */
export const SECURITY_REQUIREMENTS: WorkflowRequirements = {
  install: undefined,
  commands: [
    "bash .github/scripts/install-gitleaks.sh",
    "gitleaks git . --no-banner --redact --exit-code 1",
    "pnpm audit --audit-level=high",
  ],
};

/** RFX-111. The packages are built, then the decision paths are mutated. */
export const MUTATION_REQUIREMENTS: WorkflowRequirements = {
  install: FROZEN_INSTALL,
  commands: ["pnpm build", "pnpm mutation"],
};

export function auditWorkflow(
  workflow: string,
  requirements: WorkflowRequirements = CI_REQUIREMENTS,
): readonly string[] {
  const problems: string[] = [];
  const lines = workflow
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"));

  const runCommands = lines
    .map((line) => /^\s*(?:-\s+)?run:\s*(.*)$/.exec(line)?.[1]?.trim())
    .filter((command): command is string => command !== undefined);

  if (!/^\s*pull_request:/m.test(lines.join("\n"))) {
    problems.push("workflow does not run on pull_request");
  }

  if (
    requirements.install !== undefined &&
    !runCommands.includes(requirements.install)
  ) {
    problems.push(`missing "${requirements.install}"`);
  }
  for (const command of runCommands) {
    const installs = /\bpnpm\s+(install|i|add)\b/.test(command);
    if (installs && command !== requirements.install) {
      problems.push(`install is not lockfile-frozen: "${command}"`);
    }
    if (command === "" || command === "|" || command === ">") {
      problems.push("multi-line run blocks cannot be audited; use one line");
    }
    if (command.includes("||") || /;\s*(true|exit 0)\b/.test(command)) {
      problems.push(`gate result can be swallowed: "${command}"`);
    }
  }

  for (const gate of requirements.commands) {
    if (!runCommands.includes(gate)) {
      problems.push(`missing quality gate "${gate}"`);
    }
  }

  if (lines.some((line) => /continue-on-error\s*:\s*true/.test(line))) {
    problems.push("continue-on-error lets a failed gate pass");
  }

  for (const line of lines) {
    const action = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line)?.[1];
    if (action !== undefined && !/@[0-9a-f]{40}$/.test(action)) {
      problems.push(`action is not pinned to a commit SHA: "${action}"`);
    }
  }

  return problems;
}
