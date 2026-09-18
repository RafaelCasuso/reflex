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

export function auditWorkflow(workflow: string): readonly string[] {
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

  if (!runCommands.includes(FROZEN_INSTALL)) {
    problems.push(`missing "${FROZEN_INSTALL}"`);
  }
  for (const command of runCommands) {
    const installs = /\bpnpm\s+(install|i|add)\b/.test(command);
    if (installs && command !== FROZEN_INSTALL) {
      problems.push(`install is not lockfile-frozen: "${command}"`);
    }
    if (command === "" || command === "|" || command === ">") {
      problems.push("multi-line run blocks cannot be audited; use one line");
    }
    if (command.includes("||") || /;\s*(true|exit 0)\b/.test(command)) {
      problems.push(`gate result can be swallowed: "${command}"`);
    }
  }

  for (const gate of REQUIRED_GATES) {
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
