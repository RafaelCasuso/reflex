import type { PolicyDocument } from "@reflex-control/contracts";

import { parsePolicy } from "../parser.js";

/**
 * RFX-103 — REFLEX's own rules, above every policy source (ADR-012).
 *
 * In Autopilot the agent REFLEX governs can edit `.reflex/policy.yaml`, remove
 * the hook from the host's settings or run `rfx uninstall`. The host fails open
 * when the hook is gone (RFX-087), so any of these switches REFLEX off without
 * a sound. These rules are what stands in the way.
 *
 * They are `mandatory`, so they are a floor no source can go under (ADR-004),
 * and they are compiled into every policy set, so no source can leave them
 * out. They resolve to `ask` and not to `deny` (ADR-012): the user must remain
 * able to change their own policy through the agent, with their approval. What
 * is forbidden is doing it without a human.
 *
 * What they cannot see is said plainly in `docs/security.md`: a script that
 * performs the write without naming the file in its command line. REFLEX is
 * not a sandbox. `rfx status` reports a hook that was removed or altered.
 */
export const BUILT_IN_POLICY_YAML = `version: 1
rules:
  - id: reflex.protect-own-files
    name: Changing REFLEX's own files, or the host settings that register it, needs a human
    effect: ask
    mandatory: true
    conditions:
      - any_of:
          - { field: path, operator: path_within, value: "\${project}/.reflex" }
          - { field: path, operator: path_within, value: "\${home}/.reflex" }
          - { field: path, operator: path_within, value: "\${project}/.claude" }
          - { field: path, operator: path_within, value: "\${home}/.claude" }
          - { field: path, operator: path_within, value: "\${home}/.claude.json" }
          - { field: path, operator: path_within, value: "\${project}/.codex" }
          - { field: path, operator: path_within, value: "\${home}/.codex" }
      - not: { field: tool.name, operator: in, value: [Read, Glob, Grep, LS] }
      - not: { field: sideEffectClass, operator: in, value: [none, local-read] }

  - id: reflex.protect-own-files-by-name
    name: A command that names REFLEX's files or the host's hook settings needs a human
    effect: ask
    mandatory: true
    conditions:
      - field: command.text
        operator: matches
        value: '(^|[\\s/"''=:])(\\.reflex(/|\\s|$)|\\.claude/settings[^\\s]*\\.json|\\.claude\\.json|\\.codex/)'
      - not: { field: sideEffectClass, operator: in, value: [none, local-read] }

  - id: reflex.protect-own-command
    name: Uninstalling, pausing or reconfiguring REFLEX needs a human
    effect: ask
    mandatory: true
    conditions:
      - { field: command.name, operator: equals, value: rfx }
      - { field: command.args, operator: in, value: [uninstall, init, pause, resume, trust, login, logout, config, mode, provider, override] }
`;

let cached: PolicyDocument | undefined;

/** Parsed by the same parser as any other policy. It gets no special path. */
export function builtInPolicy(): PolicyDocument {
  if (cached === undefined) {
    const parsed = parsePolicy(BUILT_IN_POLICY_YAML);
    if (!parsed.ok) {
      // A defect in this file, caught by the first test that loads it.
      throw new Error(
        `the built-in policy does not parse: ${parsed.issues
          .map((issue) => `${String(issue.line)}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    cached = parsed.document;
  }
  return cached;
}
