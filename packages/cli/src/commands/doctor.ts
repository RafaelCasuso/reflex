import { existsSync, statSync } from "node:fs";

import { configFilePath, inspectConfig } from "@reflex-control/adapter-codex";
import { isRemoteProvider } from "@reflex-control/semantic-provider";

import type { FileSystemPort } from "../backups/file-system.js";
import {
  daemonPaths,
  daemonStatus,
  shippedDaemonVersion,
  type DaemonStatus,
} from "../daemon/lifecycle.js";
import { hostProfile } from "../hosts.js";
import { activePause, parsePause, pausePath } from "../pause.js";
import {
  parseIdentity,
  parseRegistry,
  reflexHome,
  statePaths,
  type Environment,
} from "../state.js";
import { readProvider } from "./provider.js";
import { readProjectPolicy } from "./trust.js";

/**
 * RFX-055 — `rfx doctor`: what is wrong, and what to do about it.
 *
 * Every check is one line; every failure carries a remediation the user can
 * run or do, never a stack trace. It reads everything `rfx status` reads
 * and more: the hook command's binaries, the daemon's version against the
 * shipped one, the socket's permissions, the policy files, the provider and
 * its consent, the host's own switches that would leave REFLEX installed
 * and never run. Exit 1 when anything failed. Nothing here changes a file.
 */
export type CheckOutcome = "ok" | "warn" | "fail" | "info";

export interface DoctorCheck {
  readonly area:
    "install" | "hosts" | "daemon" | "policy" | "provider" | "state";
  readonly name: string;
  readonly outcome: CheckOutcome;
  readonly detail: string;
  /** Present on every `fail` and `warn`. */
  readonly remediation?: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly failures: number;
  readonly warnings: number;
}

function check(
  area: DoctorCheck["area"],
  name: string,
  outcome: CheckOutcome,
  detail: string,
  remediation?: string,
): DoctorCheck {
  return {
    area,
    name,
    outcome,
    detail,
    ...(remediation === undefined ? {} : { remediation }),
  };
}

function modeOfPath(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

export async function runDoctor(
  environment: Environment,
  fileSystem: FileSystemPort,
  probe: (home: string) => Promise<DaemonStatus> = daemonStatus,
): Promise<DoctorReport> {
  const home = reflexHome(environment);
  const paths = statePaths(home);
  const checks: DoctorCheck[] = [];

  // State.
  const registryFile = await fileSystem.read(paths.installs);
  const registry = parseRegistry(registryFile?.content.toString("utf8"));
  if (registryFile !== undefined && registry.installs.length === 0) {
    checks.push(
      check(
        "state",
        "install registry",
        "fail",
        `${paths.installs} cannot be read as a registry`,
        'Move the file aside and run "rfx init" again; your backups under the REFLEX home are untouched.',
      ),
    );
  }
  const identity = parseIdentity(
    (await fileSystem.read(paths.identity))?.content.toString("utf8"),
  );
  const installs = registry.installs.filter(
    (entry) => entry.projectDir === environment.projectDir,
  );
  if (installs.length === 0) {
    checks.push(
      check(
        "install",
        "this project",
        "fail",
        "REFLEX is not installed in this project",
        'Run "rfx init" here.',
      ),
    );
  } else {
    checks.push(
      check(
        "install",
        "this project",
        "ok",
        `installed for ${installs.map((entry) => entry.host).join(", ")}; mode ${installs[0]?.mode ?? "observe"}, failure mode ${installs[0]?.failureMode ?? "fail-ask"}`,
      ),
    );
  }
  if (identity === undefined && registryFile !== undefined) {
    checks.push(
      check(
        "state",
        "local identity",
        "warn",
        `${paths.identity} is missing or unreadable`,
        'Run "rfx init" again: it creates the identity without touching your hooks.',
      ),
    );
  }
  const pause = activePause(
    parsePause(
      (await fileSystem.read(pausePath(home)))?.content.toString("utf8"),
    ),
    environment.now(),
  );
  if (pause !== undefined) {
    checks.push(
      check(
        "state",
        "pause",
        "warn",
        `enforcement is paused until ${pause.until}${pause.reason === undefined ? "" : ` (${pause.reason})`}; REFLEX observes and answers nothing`,
        'Run "rfx resume" to enforce again before then.',
      ),
    );
  }

  // Hosts.
  if (!existsSync(environment.nodePath)) {
    checks.push(
      check(
        "hosts",
        "node binary",
        "fail",
        `${environment.nodePath} does not exist, so no installed hook can start`,
        'Run "rfx init" again from a working Node.js to rewrite the hook command.',
      ),
    );
  }
  if (!existsSync(environment.entryPath)) {
    checks.push(
      check(
        "hosts",
        "rfx entry",
        "fail",
        `${environment.entryPath} does not exist`,
        'Reinstall REFLEX and run "rfx init" again.',
      ),
    );
  }
  for (const install of installs) {
    const profile = hostProfile(install.host);
    const file = await fileSystem.read(install.settingsPath);
    const command = profile.hookCommand(
      environment.nodePath,
      environment.entryPath,
    );
    const inspection = profile.inspect(file?.content.toString("utf8"), command);
    const missing = profile.events.filter(
      (event) => !inspection.installedEvents.includes(event),
    );
    if (inspection.state === "unparseable") {
      checks.push(
        check(
          "hosts",
          `${install.host} hooks file`,
          "fail",
          `${install.settingsPath} is not valid JSON`,
          `Fix the file by hand (or move it aside) and run "rfx init --host ${install.host}" again.`,
        ),
      );
    } else if (inspection.state === "absent") {
      checks.push(
        check(
          "hosts",
          `${install.host} hooks file`,
          "fail",
          `${install.settingsPath} is gone`,
          `Run "rfx init --host ${install.host}" to install the hook again.`,
        ),
      );
    } else if (missing.length > 0) {
      checks.push(
        check(
          "hosts",
          `${install.host} hooks`,
          "fail",
          `no REFLEX hook on ${missing.join(", ")}`,
          `Run "rfx init --host ${install.host}" to repair; it keeps your other hooks.`,
        ),
      );
    } else if (inspection.alteredEvents.length > 0) {
      checks.push(
        check(
          "hosts",
          `${install.host} hooks`,
          "fail",
          `the REFLEX hook on ${inspection.alteredEvents.join(", ")} no longer runs this rfx`,
          `Run "rfx init --host ${install.host}" to repair, then look at who changed the file.`,
        ),
      );
    } else {
      checks.push(
        check(
          "hosts",
          `${install.host} hooks`,
          "ok",
          `${String(profile.events.length)} events in ${install.settingsPath}`,
        ),
      );
    }
    if (inspection.hooksDisabled) {
      checks.push(
        check(
          "hosts",
          `${install.host} hooks switch`,
          "fail",
          `"disableAllHooks" is set in ${install.settingsPath}`,
          "Remove disableAllHooks from that file; while it is there no hook runs.",
        ),
      );
    }
    if (install.host === "codex") {
      const configPath = configFilePath("user", environment);
      const config = inspectConfig(
        (await fileSystem.read(configPath))?.content.toString("utf8"),
        environment.projectDir,
      );
      if (config.state === "unparseable") {
        checks.push(
          check(
            "hosts",
            "codex config",
            "fail",
            `${configPath} is not valid TOML`,
            "Fix the file; Codex itself will refuse it too.",
          ),
        );
      } else if (config.hooksEnabled !== true) {
        checks.push(
          check(
            "hosts",
            "codex hooks feature",
            "fail",
            `features.hooks is off in ${configPath}`,
            `Add "hooks = true" under [features] in ${configPath}, or run "rfx init --host codex" again.`,
          ),
        );
      } else {
        checks.push(
          check("hosts", "codex hooks feature", "ok", "features.hooks is on"),
        );
      }
      checks.push(
        check(
          "hosts",
          "codex trust",
          "info",
          "Codex asks you to trust a new hook once: /hooks inside Codex; REFLEX cannot see whether it is trusted",
        ),
      );
    }
  }

  // Daemon.
  const daemon = await probe(home);
  const shipped = shippedDaemonVersion();
  if (!daemon.running) {
    checks.push(
      check(
        "daemon",
        "daemon",
        "info",
        "not running; it starts on the first decision it is asked for",
      ),
    );
  } else if (daemon.version !== shipped) {
    checks.push(
      check(
        "daemon",
        "daemon version",
        "warn",
        `running ${daemon.version ?? "?"}, shipped ${shipped}`,
        'The next hook replaces it; or run "rfx uninstall" and "rfx init" to restart it now.',
      ),
    );
  } else {
    checks.push(
      check(
        "daemon",
        "daemon",
        "ok",
        `running v${daemon.version ?? "?"}, pid ${String(daemon.pid ?? "?")}`,
      ),
    );
  }
  const runDir = daemonPaths(home).runDir;
  const runMode = modeOfPath(runDir);
  if (runMode !== undefined && (runMode & 0o077) !== 0) {
    checks.push(
      check(
        "daemon",
        "socket directory",
        "fail",
        `${runDir} is mode ${runMode.toString(8)}; other users could reach the daemon`,
        `Run: chmod 700 '${runDir}'`,
      ),
    );
  }
  const homeMode = modeOfPath(home);
  if (homeMode !== undefined && (homeMode & 0o077) !== 0) {
    checks.push(
      check(
        "state",
        "REFLEX home",
        "warn",
        `${home} is mode ${homeMode.toString(8)}; it holds your observations and keys`,
        `Run: chmod 700 '${home}'`,
      ),
    );
  }

  // Policy.
  const userPolicy = `${home}/policy.yaml`;
  const userPolicyFile = await fileSystem.read(userPolicy);
  if (userPolicyFile === undefined) {
    checks.push(
      check(
        "policy",
        "user policy",
        "info",
        `${userPolicy} does not exist; REFLEX's own rules and the project policy apply`,
      ),
    );
  } else {
    const { readPolicyFiles } =
      await import("@reflex-control/decision-gateway/policy.js");
    const read = await readPolicyFiles([userPolicy]);
    checks.push(
      read.ok
        ? check("policy", "user policy", "ok", `${userPolicy} loads`)
        : check(
            "policy",
            "user policy",
            "fail",
            read.problems.join("; "),
            `Fix ${userPolicy}; until then the daemon runs with REFLEX's own rules only. "rfx explain <command>" shows what applies.`,
          ),
    );
  }
  const project = await readProjectPolicy(environment, fileSystem);
  if (project.reading === undefined) {
    checks.push(
      check(
        "policy",
        "project policy",
        "info",
        'no .reflex/policy.yaml in this project; "rfx policy starter" writes a conservative one',
      ),
    );
  } else if (project.reading.problems.length > 0) {
    checks.push(
      check(
        "policy",
        "project policy",
        "fail",
        project.reading.problems.join("; "),
        `Fix ${project.reading.path}; until then it is ignored.`,
      ),
    );
  } else if (!project.reading.trusted) {
    checks.push(
      check(
        "policy",
        "project policy",
        "warn",
        `${project.reading.path} is untrusted: its ${String(project.reading.allowRules.length)} allow rule(s) are ignored, its deny and ask rules apply`,
        'Run "rfx trust" to review what it would allow and trust this version of it.',
      ),
    );
  } else {
    checks.push(
      check(
        "policy",
        "project policy",
        "ok",
        `${project.reading.path} is trusted`,
      ),
    );
  }

  // RFX-083: the team's snapshot.
  const { readTeamPolicy } = await import("./team-policy.js");
  const team = await readTeamPolicy(environment);
  if (team.problem !== undefined) {
    checks.push(
      check(
        "policy",
        "team policy",
        "fail",
        team.problem,
        'Run "rfx policy subscribe <location> --key <public key>" again, or "rfx policy unsubscribe".',
      ),
    );
  } else if (!team.subscribed) {
    checks.push(
      check(
        "policy",
        "team policy",
        "info",
        'no team policy subscription; "rfx policy subscribe <location> --key <public key>" applies a team\'s signed snapshot',
      ),
    );
  } else if (team.current === undefined) {
    checks.push(
      check(
        "policy",
        "team policy",
        "fail",
        `subscribed to ${team.location ?? "?"} but no snapshot is in force${team.lastError === undefined ? "" : `: ${team.lastError}`}`,
        "Check that the location serves the snapshot and that it was signed with the key you subscribed with; the daemon retries on its interval.",
      ),
    );
  } else if (team.lastError !== undefined) {
    checks.push(
      check(
        "policy",
        "team policy",
        "warn",
        `${team.current.version} (${team.current.hash.slice(0, 19)}...) is in force; the last fetch failed: ${team.lastError}`,
        "The last good snapshot stays in force (ADR-003 §3). Check the location; the daemon retries on its interval.",
      ),
    );
  } else {
    checks.push(
      check(
        "policy",
        "team policy",
        "ok",
        `${team.current.version} (${team.current.hash.slice(0, 19)}...) from ${team.location ?? "?"}, fetched ${team.current.fetchedAt}`,
      ),
    );
  }

  // Provider.
  const provider = await readProvider(environment, fileSystem);
  if (provider.withheld.length > 0) {
    checks.push(
      check(
        "provider",
        "provider",
        "warn",
        `${provider.withheld.join(", ")} configured without consent: the daemon runs with policy alone`,
        `Run "rfx provider ${provider.withheld[0] ?? "none"}" to review and agree, or "rfx provider none".`,
      ),
    );
  } else if (isRemoteProvider(provider.config.semanticProvider)) {
    const key = process.env.TYPESAFE_API_KEY;
    checks.push(
      key === undefined || key === ""
        ? check(
            "provider",
            "provider key",
            "fail",
            `${provider.config.semanticProvider} is configured and TYPESAFE_API_KEY is not set in the environment the hook runs in`,
            'Export TYPESAFE_API_KEY where your agent starts, or run "rfx provider none".',
          )
        : check(
            "provider",
            "provider",
            "ok",
            `${provider.config.semanticProvider}, consent given ${provider.consent?.grantedAt.slice(0, 10) ?? ""}`,
          ),
    );
  } else {
    checks.push(
      check(
        "provider",
        "provider",
        "ok",
        provider.config.semanticProvider === "none"
          ? "none: policy alone, nothing leaves this machine"
          : provider.config.semanticProvider,
      ),
    );
  }

  return {
    checks,
    failures: checks.filter((entry) => entry.outcome === "fail").length,
    warnings: checks.filter((entry) => entry.outcome === "warn").length,
  };
}

export function renderDoctor(report: DoctorReport): string {
  const mark: Readonly<Record<CheckOutcome, string>> = {
    ok: "ok  ",
    warn: "WARN",
    fail: "FAIL",
    info: "    ",
  };
  const lines = ["rfx doctor", ""];
  for (const entry of report.checks) {
    lines.push(
      `  ${mark[entry.outcome]}  ${entry.area.padEnd(8)} ${entry.name}: ${entry.detail}`,
    );
    if (entry.remediation !== undefined) {
      lines.push(`                  -> ${entry.remediation}`);
    }
  }
  lines.push(
    "",
    report.failures === 0
      ? report.warnings === 0
        ? "Everything checks out."
        : `${String(report.warnings)} warning(s), nothing failed.`
      : `${String(report.failures)} failure(s), ${String(report.warnings)} warning(s). Each line above says what to do.`,
    "",
  );
  return lines.join("\n");
}
