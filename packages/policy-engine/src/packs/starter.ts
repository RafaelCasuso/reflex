import type { PolicyDocument } from "@reflex/contracts";

import { parsePolicy } from "../parser.js";

/**
 * RFX-017 — the starter policy for a coding agent.
 *
 * What `rfx init` writes to `.reflex/policy.yaml` (RFX-054), so it is an
 * ordinary policy: the user owns it, edits it, and can delete every line.
 *
 * It is conservative on purpose. It allows what only reads the project, what
 * file tools write inside it, and a short list of routine local commands, and
 * **it never allows anything destructive, external, privileged, financial or
 * touching credentials, and nothing whose class is unknown**, which includes
 * every script runner: `pnpm test` is not in here. Running the tests is the
 * most common thing a coding agent does, and what `test` means is written in a
 * file this policy has not read. That allowance is the user's to give, or
 * Approval Learning's to suggest once it has been approved a few times.
 *
 * Everything else is unresolved and goes to `defaults.unresolved`.
 */
export const STARTER_POLICY_YAML = `# REFLEX starter policy. It is yours: edit it, or delete any rule.
# Reference: docs/policy-language.md
version: 1

defaults:
  # What no rule resolves is assessed semantically. Until a provider is
  # configured that means: ask.
  unresolved: semantic

rules:
  - id: starter.allow-reads
    name: Commands that only read, or change nothing
    effect: allow
    conditions:
      - { field: sideEffectClass, operator: in, value: [none, local-read] }

  - id: starter.ask-reads-outside-project
    name: Reading outside the project needs a human
    effect: ask
    conditions:
      - { field: sideEffectClass, operator: in, value: [none, local-read] }
      - not:
          any_of:
            - { field: path, operator: path_within, value: "\${project}" }
            - { field: path, operator: path_within, value: /tmp }
            - { field: path, operator: path_within, value: /private/tmp }
            - { field: path, operator: path_within, value: /var/folders }
            - { field: path, operator: path_within, value: /dev }

  - id: starter.allow-file-tools-in-project
    name: File tools inside the project
    effect: allow
    conditions:
      - { field: tool.name, operator: in, value: [Read, Write, Edit, MultiEdit, NotebookEdit] }
      - { field: sideEffectClass, operator: in, value: [unknown, local-read, local-write] }
      - { field: path, operator: path_within, value: "\${project}" }
      - not: { field: path, operator: path_within, value: "\${project}/.git" }
      - not: { field: path, operator: path_within, value: "\${project}/.github" }

  - id: starter.allow-routine-local-commands
    name: Creating files and directories inside the project
    effect: allow
    conditions:
      - { field: command.name, operator: in, value: [touch, mkdir] }
      - { field: sideEffectClass, operator: equals, value: local-write }
      - { field: path, operator: path_within, value: "\${project}" }

  - id: starter.allow-local-git
    name: Local git work that can be undone
    effect: allow
    conditions:
      - { field: sideEffectClass, operator: equals, value: local-write }
      - field: command.text
        operator: matches
        value: "^git (add|commit|checkout|switch|stash|branch|tag|mv)( |$)"
`;

let cached: PolicyDocument | undefined;

export function starterPolicy(): PolicyDocument {
  if (cached === undefined) {
    const parsed = parsePolicy(STARTER_POLICY_YAML);
    if (!parsed.ok) {
      throw new Error(
        `the starter policy does not parse: ${parsed.issues
          .map((issue) => `${String(issue.line)}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    cached = parsed.document;
  }
  return cached;
}
