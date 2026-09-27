#!/usr/bin/env node
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * `rfx` — entry point.
 *
 * Command modules are imported lazily. The `hook` path runs inside every tool
 * call, in a process the host starts per call, so it must not pay to load the
 * installer, the settings editor or the renderer.
 */
const USAGE = `rfx — REFLEX, the autonomy control layer for AI agents

  rfx init [--scope local|project|user] [--yes] [--dry-run]
      Show the plan, then install the Observe hook for Claude Code.
  rfx status
      What REFLEX has observed in this project. Local, offline.
  rfx uninstall [--yes] [--purge]
      Remove REFLEX from this project. --purge also deletes ~/.reflex.
`;

const write = (text: string): void => {
  process.stdout.write(text);
};

async function hook(host: string | undefined): Promise<void> {
  // Observe: no stdout, no stderr, exit 0. Whatever happens. See hook.ts.
  try {
    if (host !== "claude-code") {
      return;
    }
    const [{ readStdin, runClaudeCodeHook }, { ObservationLog }, state] =
      await Promise.all([
        import("./commands/hook.js"),
        import("@reflex/telemetry"),
        import("./state.js"),
      ]);
    const home = state.reflexHome(environment(process.cwd()));
    const log = new ObservationLog({
      directory: state.statePaths(home).observe,
    });
    await runClaudeCodeHook(await readStdin(process.stdin), {
      now: () => new Date(),
      log: {
        // `performance.now()` counts from process start, so at this point it
        // is how long the host has been waiting for this hook, as seen from
        // inside it.
        append: (record) =>
          log.append(
            record.kind === "turn-ended"
              ? record
              : {
                  ...record,
                  hookMs: Math.round(performance.now() * 10) / 10,
                },
          ),
      },
    });
  } catch {
    // Deliberately silent.
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
  hostVersion: async (): Promise<string | undefined> => {
    const result = await run("claude", ["--version"]);
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
      scope: { type: "string", default: "local" },
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

  switch (command) {
    case "init": {
      const { SETTINGS_SCOPES } = await import("@reflex/adapter-claude-code");
      const scope = SETTINGS_SCOPES.find((known) => known === values.scope);
      if (scope === undefined) {
        write(`Unknown scope. Use one of: ${SETTINGS_SCOPES.join(", ")}.\n`);
        return 2;
      }
      const { applyInit, planInit } = await import("./commands/init.js");
      const plan = await planInit(env, scope, nodeFileSystem, probes);
      write(render.renderInitPlan(plan));
      if (plan.kind === "blocked") {
        return 1;
      }
      if (plan.kind === "already-installed" || values["dry-run"]) {
        return 0;
      }
      if (!(await confirm("Apply this plan?", values.yes))) {
        return 0;
      }
      const result = await applyInit(plan, nodeFileSystem, env.now);
      write(
        result.ok
          ? render.renderInitDone(plan.settingsPath)
          : render.renderTransactionFailure(result),
      );
      return result.ok ? 0 : 1;
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
