import type { TransactionFailure } from "../backups/transaction.js";
import type {
  InitPlan,
  InitWarning,
  InstallInitPlan,
} from "../commands/init.js";
import { describeProvider } from "../commands/provider.js";
import type { StatusReport } from "../commands/status.js";
import type { UninstallCommandPlan } from "../commands/uninstall.js";
import type { SupportedHost } from "../hosts.js";

/**
 * Everything `rfx` prints. Pure functions from results to text, so the exact
 * wording of a plan is testable and deterministic (RFX-052).
 *
 * Anything that did not originate in this codebase (paths, tool names from an
 * MCP server, host versions) goes through `safe()` first: a tool name is
 * attacker-chosen text, and a terminal executes escape sequences.
 */
export function safe(value: string): string {
  return value.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "?").slice(0, 300);
}

function warning(entry: InitWarning): string {
  switch (entry.kind) {
    case "hooks-disabled":
      return `Hooks are switched off by "disableAllHooks" in ${safe(entry.path)}. REFLEX would be installed and never run until that is removed.`;
    case "managed-hooks-only":
      return `Your organization allows managed hooks only (${safe(entry.path)}). A hook installed here will not run. Ask your administrator to deploy REFLEX as a managed hook.`;
    case "not-git-ignored":
      return `${safe(entry.path)} is not ignored by git. It will contain a path that is specific to this machine, so do not commit it.`;
    case "shared-settings-file":
      return `${safe(entry.path)} is shared with everyone who clones this repository, and the hook points at a path on this machine. Prefer the default scope ("local") unless that is what you want.`;
    case "scope-substituted":
      return `--scope ${entry.scope} is not one of this host's scopes; its default is used.`;
    case "hooks-feature-not-set":
      return `Codex runs no hook until features.hooks = true is in ${safe(entry.path)}, and REFLEX could not set it there: ${entry.reason}. Set it yourself, or REFLEX would be installed and never run.`;
    case "inline-hooks-table":
      return `${safe(entry.path)} declares hooks in a [hooks] table; REFLEX leaves it as it is and installs into hooks.json, which Codex reads as well.`;
    case "host-not-found":
      return `${HOST_NAMES[entry.host]} was not found on PATH. The hook will be installed and will start working once ${HOST_NAMES[entry.host]} is.`;
  }
}

export function renderInitPlan(plan: InitPlan): string {
  const lines: string[] = [];
  switch (plan.kind) {
    case "blocked":
      return [
        `REFLEX cannot read ${safe(plan.settingsPath)} as a settings file, so it will not touch it.`,
        `Fix the JSON in that file (or move it aside) and run "rfx init" again.`,
        "",
      ].join("\n");

    case "already-installed":
      lines.push(
        `REFLEX is already installed for ${HOST_NAMES[plan.host]} in ${safe(plan.settingsPath)}. Nothing to do.`,
      );
      break;

    case "install":
      lines.push(
        `REFLEX will observe ${HOST_NAMES[plan.host]} in this project. Plan:`,
        "",
        `  ${plan.action === "create" ? "create" : "modify"}  ${safe(plan.settingsPath)}`,
        `          add one hook to each of: ${plan.events.join(", ")}`,
        `          command: ${safe(plan.command)}`,
      );
      if (plan.codex !== undefined) {
        const { codex } = plan;
        if (codex.feature === "set") {
          lines.push(
            `  ${codex.config.state === "absent" ? "create" : "modify"}  ${safe(codex.configPath)}`,
            "          set features.hooks = true (Codex runs no hook without it); nothing else in it changes",
          );
        }
        lines.push(
          `  read    ${safe(codex.configPath)}: approval policy ${codex.config.approvalPolicy ?? "default"}, sandbox ${codex.config.sandboxMode ?? "default"}, this project ${codex.config.trustLevel ?? "not listed"}${codex.feature === "already-on" ? ", hooks already on" : ""}`,
        );
      }
      if (plan.starterPolicyPath !== undefined) {
        lines.push(
          `  create  ${safe(plan.starterPolicyPath)}`,
          "          a conservative starter policy, yours to edit; trusted as written",
        );
      }
      lines.push(
        `  backup  every file it changes, under ${safe(plan.backupDir)}`,
      );
      if (plan.createsIdentity) {
        lines.push(
          "  create  an anonymous local identity (random, never sent anywhere)",
        );
      }
      lines.push(
        "",
        "Observe mode: REFLEX records which tools run and what happened to them.",
        "It never blocks, approves or prompts, and nothing leaves this machine.",
        "It stores the shape of tool arguments (keys, types, sizes), never their values.",
      );
      break;
  }

  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const entry of plan.warnings) {
      lines.push(`  - ${warning(entry)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export const HOST_NAMES: Readonly<Record<SupportedHost, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export function renderInitDone(plan: InstallInitPlan): string {
  const lines = [
    `Installed. ${safe(plan.settingsPath)} was backed up first.`,
    "",
  ];
  if (plan.host === "codex") {
    lines.push(
      "Codex reads hooks when a session starts, and asks you to trust a new hook",
      "once: inside Codex, run /hooks and trust the REFLEX_MANAGED=1 entries. The",
      "hook keeps to the projects REFLEX is installed in and does nothing elsewhere.",
      'Then use it as usual and run "rfx status".',
    );
  } else {
    lines.push(
      "Claude Code reads hooks when a session starts: restart any session that is",
      'already running. Then use it as usual and run "rfx status".',
    );
  }
  lines.push('To undo everything: "rfx uninstall".', "");
  return lines.join("\n");
}

export function renderTransactionFailure(failure: TransactionFailure): string {
  const lines: string[] = [];
  switch (failure.reason) {
    case "changed-since-plan":
      lines.push(
        `${safe(failure.path)} changed while the plan was on screen. Nothing was written.`,
        "Run the command again to see a plan for the file as it is now.",
      );
      break;
    case "backup-failed":
      lines.push(
        `Could not write a backup for ${safe(failure.path)}. Nothing was changed.`,
        `Check that ${safe(failure.backupDir)} is writable.`,
      );
      break;
    case "write-failed":
      lines.push(`Could not write ${safe(failure.path)}.`);
      if (failure.rolledBack) {
        lines.push("Every file was put back exactly as it was.");
      } else {
        lines.push(
          "Some files could NOT be put back automatically:",
          ...failure.unrestored.map((path) => `  - ${safe(path)}`),
          `Their original contents are in ${safe(failure.backupDir)} (see manifest.json).`,
        );
      }
      break;
  }
  lines.push("");
  return lines.join("\n");
}

export function renderUninstallPlan(plan: UninstallCommandPlan): string {
  const active = plan.removals.filter(
    (entry) => entry.method !== "already-gone",
  );
  if (active.length === 0 && plan.skipped.length === 0) {
    return "REFLEX is not installed in this project. Nothing to do.\n";
  }
  const lines = ["REFLEX will be removed from this project. Plan:", ""];
  for (const entry of active) {
    lines.push(
      entry.method === "exact-restore"
        ? `  restore  ${safe(entry.settingsPath)} to exactly what it was before "rfx init"`
        : `  edit     ${safe(entry.settingsPath)}: remove REFLEX's hooks, keep your changes`,
    );
  }
  for (const path of plan.skipped) {
    lines.push(
      `  skip     ${safe(path)}: REFLEX cannot read it, so it will not touch it. Remove the entries that start with REFLEX_MANAGED=1, or the hooks = true line, by hand.`,
    );
  }
  for (const path of plan.kept) {
    lines.push(
      `  keep     ${safe(path)}: another project still uses it; only this project's entry goes`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function ago(from: string, now: Date): string {
  const seconds = Math.max(
    0,
    Math.round((now.getTime() - Date.parse(from)) / 1_000),
  );
  if (seconds < 90) {
    return `${String(seconds)}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return `${String(minutes)}m ago`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? `${String(hours)}h ago`
    : `${String(Math.round(hours / 24))}d ago`;
}

const HEALTH: Readonly<Record<string, string>> = {
  active: "active",
  missing:
    'HOOK MISSING: removed or edited since install. Run "rfx init" to repair.',
  altered:
    'HOOK ALTERED: it no longer runs the command this rfx installs. Run "rfx init" to repair.',
  unreadable: "UNREADABLE: that file is not valid JSON.",
};

export function renderStatus(report: StatusReport, now: Date): string {
  const lines = [
    `REFLEX  mode: ${report.mode}  (records only, never interferes)`,
  ];
  if (report.pause !== undefined) {
    lines.push(
      `PAUSED  until ${report.pause.until}${report.pause.reason === undefined ? "" : ` (${safe(report.pause.reason)})`}: observing, enforcing nothing. "rfx resume" ends it early.`,
    );
  }
  lines.push("");

  if (report.adapters.length === 0) {
    lines.push('Not installed in this project. Run "rfx init".', "");
    return lines.join("\n");
  }
  lines.push("Adapters");
  for (const adapter of report.adapters) {
    lines.push(
      `  ${adapter.host}  ${adapter.health === "disabled" ? `DISABLED by ${adapter.disabledBy ?? "the host"}. REFLEX is not running.` : (HEALTH[adapter.health] ?? adapter.health)}`,
      `              ${safe(adapter.settingsPath)}`,
    );
  }

  lines.push("", "Observed in this project");
  const { summary } = report;
  if (summary.actions === 0) {
    lines.push(
      "  nothing yet. Restart Claude Code if it was already running, then use it.",
    );
  } else {
    lines.push(
      `  ${String(summary.actions)} actions`,
      `    ran without a prompt   ${String(summary.ranWithoutPrompt)}`,
      `    prompted               ${String(summary.prompted)}  (approved ${String(summary.approved)}, rejected ${String(summary.rejected)})`,
      `    blocked by the host    ${String(summary.blockedByHost)}`,
      `    not yet known          ${String(summary.unknown)}`,
    );
  }

  if (report.lastAction !== undefined) {
    const { lastAction } = report;
    const tool =
      lastAction.toolNamespace === undefined
        ? lastAction.toolName
        : `${lastAction.toolNamespace}/${lastAction.toolName}`;
    lines.push(
      "",
      `Last action  ${safe(tool)}  ${ago(lastAction.recordedAt, now)}  class: ${lastAction.sideEffectClass}`,
    );
  }
  if (report.overhead !== undefined) {
    lines.push(
      `Hook time    p50 ${report.overhead.p50Ms.toFixed(1)} ms, p95 ${report.overhead.p95Ms.toFixed(1)} ms inside the hook process (${String(report.overhead.samples)} calls; process start not included)`,
    );
  }
  lines.push(
    "",
    report.daemon.running
      ? `Daemon       running, v${report.daemon.version ?? "?"}${report.daemon.pid === undefined ? "" : `, pid ${String(report.daemon.pid)}`}, up ${duration(report.daemon.uptimeMs ?? 0)}`
      : "Daemon       not running (starts on the first decision it is asked for)",
    `Provider     ${describeProvider(report.provider)}`,
    `Policy       ${describeProjectPolicy(report.projectPolicy)}`,
    `Identity     ${report.identity?.agentId ?? "none"}  (local, anonymous)`,
    `Log          ${safe(report.logFile)}`,
    "",
  );
  return lines.join("\n");
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 90) {
    return `${String(seconds)}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return `${String(minutes)}m`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? `${String(hours)}h`
    : `${String(Math.round(hours / 24))}d`;
}

function describeProjectPolicy(status: StatusReport["projectPolicy"]): string {
  const { reading } = status;
  if (reading === undefined) {
    return 'no project policy ("rfx policy starter" writes one)';
  }
  if (reading.problems.length > 0) {
    return `${safe(reading.path)} does not load and is ignored ("rfx doctor")`;
  }
  return reading.trusted
    ? `${safe(reading.path)}, trusted`
    : `${safe(reading.path)}, UNTRUSTED: its ${String(reading.allowRules.length)} allow rule(s) are ignored ("rfx trust")`;
}
