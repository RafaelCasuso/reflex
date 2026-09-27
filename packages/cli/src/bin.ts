#!/usr/bin/env node
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { HostScope, SupportedHost } from "./hosts.js";

/**
 * `rfx` — entry point.
 *
 * Command modules are imported lazily. The `hook` path runs inside every tool
 * call, in a process the host starts per call, so it must not pay to load the
 * installer, the settings editor or the renderer.
 */
const USAGE = `rfx — REFLEX, the autonomy control layer for AI agents

  rfx init [--host claude-code|codex] [--scope local|project|user]
           [--mode observe|assist|autopilot]
           [--failure-mode fail-open|fail-ask|fail-closed] [--yes] [--dry-run]
      Show the plan, then install the hook for each agent found (Claude Code,
      Codex), or for --host. Observe by default.
  rfx mode [observe|assist|autopilot] [--failure-mode fail-open|fail-ask|fail-closed]
      Show or change what the hook does with a decision in this project.
  rfx provider [none|jev|local] [--model <id>] [--endpoint <url>] [--consent]
      Show or choose what assesses the actions policy leaves open. A remote
      provider shows what leaves this machine and asks for your consent first.
  rfx override <decisionId>
      Let one denied action through, once: the id is in the deny's reason line.
  rfx status
      What REFLEX has observed and decided in this project. Local, offline.
  rfx uninstall [--yes] [--purge]
      Remove REFLEX from this project. --purge also deletes ~/.reflex.
`;

const write = (text: string): void => {
  process.stdout.write(text);
};

async function hook(host: string | undefined): Promise<void> {
  // Observe: no stdout, no stderr, exit 0, whatever happens (see hook.ts).
  // Assist and Autopilot: the same, plus one JSON answer on stdout when the
  // host has a channel for the decision, always, even when nothing can be
  // reached (ADR-003 §4).
  let answer: string | undefined;
  try {
    if (host !== "claude-code" && host !== "codex") {
      return;
    }
    const [hooks, { ObservationLog }, state] = await Promise.all([
      import("./commands/hook.js"),
      import("@reflex/telemetry"),
      import("./state.js"),
    ]);
    const env = environment(process.cwd());
    const home = state.reflexHome(env);
    const log = new ObservationLog({
      directory: state.statePaths(home).observe,
    });
    const stdin = await hooks.readStdin(process.stdin);
    const dependencies = {
      now: () => new Date(),
      log: {
        // `performance.now()` counts from process start, so at this point it
        // is how long the host has been waiting for this hook, as seen from
        // inside it.
        append: (record: Parameters<typeof log.append>[0]) =>
          log.append(
            record.kind === "turn-ended"
              ? record
              : {
                  ...record,
                  hookMs: Math.round(performance.now() * 10) / 10,
                },
          ),
      },
    };
    // RFX-043, G8: the project's mode, from the registry, by the payload's
    // own working directory. Observe answers nothing.
    const { readFile } = await import("node:fs/promises");
    const registry = state.parseRegistry(
      await readFile(state.statePaths(home).installs, "utf8").catch(
        () => undefined,
      ),
    );
    const { installedProjectFor } = await import("./hosts.js");

    if (host === "claude-code") {
      const observed = await hooks.runClaudeCodeHook(stdin, dependencies);
      if (
        observed.event?.kind !== "tool" ||
        observed.event.event !== "PreToolUse"
      ) {
        return;
      }
      const projectDir = observed.event.cwd ?? env.projectDir;
      const install = registry.installs.find(
        (entry) =>
          entry.host === "claude-code" && entry.projectDir === projectDir,
      );
      const mode = state.modeOf(install);
      if (mode === "observe") {
        return;
      }
      const { decideForHost } = await import("./commands/decide.js");
      const outcome = await decideForHost(observed.event, {
        home,
        nodePath: env.nodePath,
        mode,
        failureMode: state.failureModeOf(install),
        ...(install === undefined ? {} : { projectId: install.projectId }),
        now: env.now,
      });
      answer = JSON.stringify(outcome.answer);
      return;
    }

    // Codex: the user-scoped hook fires in every project and keeps to the
    // ones REFLEX is installed in (RFX-050); it decides on PreToolUse and
    // on PermissionRequest, each on its own channel (RFX-049).
    const observed = await hooks.runObserveHook(
      hooks.codexHook(
        (event) =>
          event.kind !== "tool" ||
          installedProjectFor(
            registry.installs,
            "codex",
            event.cwd ?? env.projectDir,
          ) !== undefined,
      ),
      stdin,
      dependencies,
    );
    if (
      observed.event?.kind !== "tool" ||
      observed.event.event === "PostToolUse"
    ) {
      return;
    }
    const install = installedProjectFor(
      registry.installs,
      "codex",
      observed.event.cwd ?? env.projectDir,
    );
    const mode = state.modeOf(install);
    if (mode === "observe") {
      return;
    }
    const { decideForCodex } = await import("./commands/codex-hook.js");
    const outcome = await decideForCodex(observed.event, {
      home,
      nodePath: env.nodePath,
      mode,
      failureMode: state.failureModeOf(install),
      ...(install === undefined ? {} : { projectId: install.projectId }),
      now: env.now,
    });
    if (outcome.answer !== undefined) {
      answer = JSON.stringify(outcome.answer);
    }
  } catch {
    // Deliberately silent: in Observe nothing is owed to the host, and in
    // the other modes an answer was already computed or none can be.
  } finally {
    if (answer !== undefined) {
      process.stdout.write(`${answer}\n`);
    }
  }
}

function environment(projectDir: string) {
  return {
    homeDir: homedir(),
    projectDir,
    reflexHomeOverride: process.env.REFLEX_HOME,
    platform: process.platform,
    nodePath: process.execPath,
    entryPath: fileURLToPath(import.meta.url),
    now: () => new Date(),
  };
}

function run(
  command: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string } | undefined> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: 3_000 }, (error, stdout) => {
      if (error === null) {
        resolve({ code: 0, stdout });
      } else if (typeof error.code === "number") {
        resolve({ code: error.code, stdout });
      } else {
        resolve(undefined);
      }
    });
  });
}

const probes = {
  hostVersion: async (
    host: "claude-code" | "codex",
  ): Promise<string | undefined> => {
    const result = await run(host === "codex" ? "codex" : "claude", [
      "--version",
    ]);
    return result?.code === 0 ? result.stdout.trim() : undefined;
  },
  isGitIgnored: async (path: string): Promise<boolean | undefined> => {
    const result = await run("git", ["check-ignore", "-q", path]);
    // 0: ignored. 1: not ignored. Anything else: not a repository, no git.
    return result === undefined || result.code > 1
      ? undefined
      : result.code === 0;
  },
};

async function confirm(question: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) {
    return true;
  }
  if (!process.stdin.isTTY) {
    write(
      'Not a terminal: nothing was changed. Re-run with "--yes" to apply.\n',
    );
    return false;
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: "string" },
      scope: { type: "string" },
      mode: { type: "string" },
      "failure-mode": { type: "string" },
      model: { type: "string" },
      endpoint: { type: "string" },
      consent: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      purge: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const [command, argument] = positionals;

  if (command === "hook") {
    await hook(argument);
    return 0;
  }
  if (values.help || command === undefined) {
    write(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }

  const env = environment(process.cwd());
  const [{ nodeFileSystem }, render] = await Promise.all([
    import("./backups/file-system.js"),
    import("./output/render.js"),
  ]);

  const { FAILURE_MODES, REFLEX_MODES } = await import("@reflex/contracts");
  const modeOption = REFLEX_MODES.find((known) => known === values.mode);
  const failureModeOption = FAILURE_MODES.find(
    (known) => known === values["failure-mode"],
  );
  if (values.mode !== undefined && modeOption === undefined) {
    write(`Unknown mode. Use one of: ${REFLEX_MODES.join(", ")}.\n`);
    return 2;
  }
  if (values["failure-mode"] !== undefined && failureModeOption === undefined) {
    write(`Unknown failure mode. Use one of: ${FAILURE_MODES.join(", ")}.\n`);
    return 2;
  }

  switch (command) {
    case "init": {
      const hosts = await import("./hosts.js");
      const wantedHost = values.host;
      if (wantedHost !== undefined && !hosts.isSupportedHost(wantedHost)) {
        write(
          `Unknown host. Use one of: ${hosts.SUPPORTED_HOSTS.join(", ")}.\n`,
        );
        return 2;
      }
      const scope = values.scope;
      if (
        scope !== undefined &&
        !(["local", "project", "user"] as const).some(
          (known) => known === scope,
        )
      ) {
        write("Unknown scope. Use one of: local, project, user.\n");
        return 2;
      }
      // Detect supported agents (CLAUDE.md, onboarding). None found: plan
      // for Claude Code anyway, and the plan says the host was not found.
      let chosen: SupportedHost[];
      if (hosts.isSupportedHost(wantedHost)) {
        chosen = [wantedHost];
      } else {
        const detected: SupportedHost[] = [];
        for (const host of hosts.SUPPORTED_HOSTS) {
          if ((await probes.hostVersion(host)) !== undefined) {
            detected.push(host);
          }
        }
        chosen = detected.length === 0 ? ["claude-code"] : detected;
      }
      const { applyInit, planInit } = await import("./commands/init.js");
      let failed = false;
      for (const host of chosen) {
        const plan = await planInit(
          env,
          host,
          scope as HostScope | undefined,
          nodeFileSystem,
          probes,
          {
            ...(modeOption === undefined ? {} : { mode: modeOption }),
            ...(failureModeOption === undefined
              ? {}
              : { failureMode: failureModeOption }),
          },
        );
        write(render.renderInitPlan(plan));
        if (plan.kind === "blocked") {
          failed = true;
          continue;
        }
        if (plan.kind === "already-installed" || values["dry-run"]) {
          continue;
        }
        if (!(await confirm("Apply this plan?", values.yes))) {
          continue;
        }
        const result = await applyInit(plan, nodeFileSystem, env.now);
        write(
          result.ok
            ? render.renderInitDone(plan)
            : render.renderTransactionFailure(result),
        );
        if (!result.ok) {
          failed = true;
        }
      }
      return failed ? 1 : 0;
    }

    case "mode": {
      const { changeMode, readMode } = await import("./commands/mode.js");
      const wanted = REFLEX_MODES.find((known) => known === argument);
      if (argument !== undefined && wanted === undefined) {
        write(`Unknown mode. Use one of: ${REFLEX_MODES.join(", ")}.\n`);
        return 2;
      }
      if (wanted === undefined && failureModeOption === undefined) {
        const current = await readMode(env, nodeFileSystem);
        write(
          current.installed
            ? `mode: ${current.mode}  failure mode: ${current.failureMode}\n`
            : 'Not installed in this project. Run "rfx init".\n',
        );
        return 0;
      }
      const changed = await changeMode(env, nodeFileSystem, {
        ...(wanted === undefined ? {} : { mode: wanted }),
        ...(failureModeOption === undefined
          ? {}
          : { failureMode: failureModeOption }),
      });
      if (!changed.ok) {
        write(
          changed.reason === "not-installed"
            ? 'Not installed in this project. Run "rfx init".\n'
            : "Could not write the registry.\n",
        );
        return 1;
      }
      write(
        `mode: ${changed.after.mode}  failure mode: ${changed.after.failureMode}${changed.after.mode === "observe" ? "  (records only, never interferes)" : ""}\n`,
      );
      return 0;
    }

    case "provider": {
      const provider = await import("./commands/provider.js");
      const wanted = provider.CHOOSABLE_PROVIDERS.find(
        (known) => known === argument,
      );
      if (argument === undefined) {
        const current = await provider.readProvider(env, nodeFileSystem);
        write(`provider: ${provider.describeProvider(current)}\n`);
        return 0;
      }
      if (wanted === undefined) {
        write(
          `Unknown provider. Use one of: ${provider.CHOOSABLE_PROVIDERS.join(", ")}.\n`,
        );
        return 2;
      }
      // RFX-123: a remote provider shows the statement and needs a yes to it,
      // typed here or given with --consent. Nothing is written before.
      let consented = false;
      const { isRemoteProvider } = await import("@reflex/semantic-provider");
      if (isRemoteProvider(wanted)) {
        write(`${provider.consentStatement(wanted)}\n\n`);
        consented = values.consent
          ? true
          : await confirm("Do you agree to this?", false);
        if (!consented) {
          write(
            process.stdin.isTTY || values.consent
              ? "Declined. REFLEX keeps deciding with policy alone; nothing leaves this machine.\n"
              : 'Re-run with "--consent" to agree to the statement above.\n',
          );
          return 0;
        }
      }
      const changed = await provider.changeProvider(env, nodeFileSystem, {
        provider: wanted,
        ...(values.model === undefined ? {} : { model: values.model }),
        ...(values.endpoint === undefined ? {} : { endpoint: values.endpoint }),
        consented,
      });
      if (!changed.ok) {
        switch (changed.reason) {
          case "model-required":
            write(
              'The local provider needs the checkpoint it serves: "rfx provider local --model <id>".\n',
            );
            return 2;
          case "consent-required":
            write("Nothing was changed: this provider needs your consent.\n");
            return 2;
          case "write-failed":
            write("Could not write the configuration.\n");
            return 1;
        }
      }
      write(`provider: ${provider.describeProvider(changed.after)}\n`);
      if (changed.changed) {
        // The daemon runs with what it was started with; the next decision
        // starts one with the new configuration.
        const { reflexHome } = await import("./state.js");
        const { stopDaemon } = await import("./daemon/lifecycle.js");
        const stopped = await stopDaemon(reflexHome(env));
        if (stopped.wasRunning) {
          write(
            "Daemon stopped; it starts again with this provider on the next decision.\n",
          );
        }
      }
      return 0;
    }

    case "override": {
      // RFX-125: a human's yes to one denied decision, from a terminal. When
      // the agent runs this through a tool, REFLEX's own rule asks first.
      const { isOpaqueId } = await import("@reflex/contracts");
      if (!isOpaqueId("dec", argument)) {
        write(
          'Give the decision id from the deny\'s reason line: "rfx override dec_...".\n',
        );
        return 2;
      }
      const { REFUSAL_HINTS, overrideDecision } =
        await import("./commands/override.js");
      const { reflexHome } = await import("./state.js");
      const outcome = await overrideDecision(argument, {
        home: reflexHome(env),
        nodePath: env.nodePath,
      });
      if (outcome.kind === "granted") {
        write(
          `Override recorded for ${argument}. The same action is allowed once if the agent tries it again before ${outcome.expiresAt}; anything else stays as decided.\n`,
        );
        return 0;
      }
      if (outcome.kind === "refused") {
        write(
          `Not overridden: ${outcome.message}.\n${REFUSAL_HINTS[outcome.status] ?? ""}\n`,
        );
        return 1;
      }
      write(
        outcome.kind === "unreachable"
          ? "The local daemon could not be started or reached.\n"
          : "The local daemon's answer could not be read.\n",
      );
      return 1;
    }

    case "status": {
      const { collectStatus } = await import("./commands/status.js");
      write(
        render.renderStatus(
          await collectStatus(env, nodeFileSystem),
          env.now(),
        ),
      );
      return 0;
    }

    case "uninstall": {
      const { applyUninstall, planUninstallCommand } =
        await import("./commands/uninstall.js");
      const plan = await planUninstallCommand(env, nodeFileSystem);
      write(render.renderUninstallPlan(plan));
      if (plan.writes.length > 0) {
        if (!(await confirm("Apply this plan?", values.yes))) {
          return 0;
        }
        const result = await applyUninstall(plan, nodeFileSystem, env.now);
        if (!result.ok) {
          write(render.renderTransactionFailure(result));
          return 1;
        }
        write("Removed.\n");
      }
      // RFX-138: the daemon is stopped and its socket removed. It starts
      // again on the first decision another install asks for.
      {
        const { reflexHome } = await import("./state.js");
        const { stopDaemon } = await import("./daemon/lifecycle.js");
        const stopped = await stopDaemon(reflexHome(env));
        if (stopped.wasRunning) {
          write(
            stopped.gracefully
              ? "Daemon stopped.\n"
              : "Daemon did not stop in time and was killed.\n",
          );
        }
      }
      if (values.purge) {
        const { reflexHome } = await import("./state.js");
        const { rm } = await import("node:fs/promises");
        await rm(reflexHome(env), { recursive: true, force: true });
        write(`Deleted ${render.safe(reflexHome(env))}.\n`);
      } else if (plan.writes.length > 0) {
        const { reflexHome } = await import("./state.js");
        write(
          `Your observations and backups are still in ${render.safe(reflexHome(env))}. "rfx uninstall --purge" deletes them.\n`,
        );
      }
      return plan.skipped.length > 0 ? 1 : 0;
    }

    default:
      write(USAGE);
      return 2;
  }
}

process.exitCode = await main().catch(() => {
  // The hook path never reaches here. For a human-run command an unexpected
  // failure is reported, without a stack trace that could carry file content.
  if (process.argv[2] !== "hook") {
    process.stderr.write(
      'rfx: unexpected error. Run "rfx status" to see the current state.\n',
    );
    return 1;
  }
  return 0;
});
