#!/usr/bin/env node
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { HostScope, SupportedHost } from "./hosts.js";
import { CLI_VERSION } from "./version.js";

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
  rfx explain <command...> | rfx explain --tool Read|Write|Edit --path <file>
      Why an action would be allowed, asked or denied here: rules, precedence, effect.
  rfx trust [--yes] [--revoke]
      Review what this project's .reflex/policy.yaml would allow, and trust that version.
  rfx policy starter [--force]
      Write the conservative starter policy to .reflex/policy.yaml.
  rfx policy keygen [--out <dir>]
      Create the team's signing key pair (private key in ~/.reflex/keys unless --out).
  rfx policy snapshot --policy <org.yaml> [--environment <env>=<file>]... --key <private.pem> --label <version> --out <file>
      Compile and sign the team's policy into one snapshot to publish.
  rfx policy subscribe <https URL | file> --key <public.pem>  |  rfx policy unsubscribe
      Apply a team's signed snapshot as the organization and environment sources, no account needed.
  rfx pause --for <30m|2h|1d> [--reason <text>]  |  rfx resume
      Suspend enforcement for a bounded time; REFLEX keeps observing.
  rfx doctor [--json]
      Check hooks, daemon, policy, provider and host switches; each failure says what to do.
  rfx status
      What REFLEX has observed and decided in this project. Local, offline.
  rfx uninstall [--yes] [--purge]
      Remove REFLEX from this project. --purge also deletes ~/.reflex.
  rfx --version
      Print the version of this installation.
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
      import("@reflex-control/telemetry"),
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
    // RFX-126: paused means Observe, for every host and project, until the
    // pause ends by itself or `rfx resume` ends it.
    const pauseModule = await import("./pause.js");
    const paused =
      pauseModule.activePause(
        pauseModule.parsePause(
          await readFile(pauseModule.pausePath(home), "utf8").catch(
            () => undefined,
          ),
        ),
        env.now(),
      ) !== undefined;

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
      if (mode === "observe" || paused) {
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
    if (mode === "observe" || paused) {
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

/** The options that take a value, so that the value is never read as a command. */
const VALUED_OPTIONS = new Set([
  "host",
  "scope",
  "mode",
  "failure-mode",
  "model",
  "endpoint",
  "tool",
  "path",
  "for",
  "reason",
  "key",
  "out",
  "label",
  "policy",
  "environment",
]);

/**
 * `rfx explain git push --force`: from the first word of the command on,
 * every token is the agent's, dashes and all, and none of them is an option
 * of rfx. rfx's own options (`--json`, `--tool`, `--path`) go before it.
 */
function splitExplain(args: readonly string[]): {
  readonly own: readonly string[];
  readonly command: readonly string[];
} {
  if (args[0] !== "explain") {
    return { own: args, command: [] };
  }
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && VALUED_OPTIONS.has(arg.slice(2))) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return { own: args.slice(0, index), command: args.slice(index) };
  }
  return { own: args, command: [] };
}

function parseArguments(args: readonly string[]) {
  const { own, command } = splitExplain(args);
  const parsed = parseArgs({
    args: [...own],
    allowPositionals: true,
    options: {
      version: { type: "boolean", short: "v", default: false },
      host: { type: "string" },
      scope: { type: "string" },
      key: { type: "string" },
      out: { type: "string" },
      label: { type: "string" },
      policy: { type: "string" },
      environment: { type: "string", multiple: true },
      mode: { type: "string" },
      "failure-mode": { type: "string" },
      model: { type: "string" },
      endpoint: { type: "string" },
      consent: { type: "boolean", default: false },
      tool: { type: "string" },
      path: { type: "string" },
      for: { type: "string" },
      reason: { type: "string" },
      revoke: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      purge: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  return {
    values: parsed.values,
    positionals: [...parsed.positionals, ...command],
  };
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArguments>;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    // The hook path stays silent whatever it is given (see hook.ts): a
    // hook that cannot parse its own arguments must never block the host.
    if (process.argv[2] === "hook") {
      return 0;
    }
    // For a human: an option rfx does not know, or a value missing after
    // one. Not "unexpected"; say which, and show the usage.
    process.stderr.write(
      `rfx: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    write(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, argument] = positionals;

  if (command === "hook") {
    await hook(argument);
    return 0;
  }
  if (values.version) {
    write(`rfx ${CLI_VERSION}\n`);
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

  const { FAILURE_MODES, REFLEX_MODES } =
    await import("@reflex-control/contracts");
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
      const { isRemoteProvider } =
        await import("@reflex-control/semantic-provider");
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
      const { isOpaqueId } = await import("@reflex-control/contracts");
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

    case "explain": {
      const { explain, renderExplanation } =
        await import("./commands/explain.js");
      const words = positionals.slice(1);
      if (
        words.length === 0 &&
        values.tool === undefined &&
        values.path === undefined
      ) {
        write(
          'Give a command ("rfx explain git push --force") or a file tool ("rfx explain --tool Write --path src/a.ts").\n',
        );
        return 2;
      }
      const { parseRegistry, statePaths, reflexHome } =
        await import("./state.js");
      const { readFile } = await import("node:fs/promises");
      const registry = parseRegistry(
        await readFile(statePaths(reflexHome(env)).installs, "utf8").catch(
          () => undefined,
        ),
      );
      const host =
        registry.installs.find((entry) => entry.projectDir === env.projectDir)
          ?.host ?? "claude-code";
      const explanation = await explain(
        {
          host,
          ...(words.length > 0 ? { command: words.join(" ") } : {}),
          ...(values.tool === undefined ? {} : { tool: values.tool }),
          ...(values.path === undefined ? {} : { path: values.path }),
        },
        env,
        nodeFileSystem,
      );
      write(
        values.json
          ? `${JSON.stringify(explanation, null, 2)}\n`
          : renderExplanation(explanation, env),
      );
      return 0;
    }

    case "trust": {
      const trust = await import("./commands/trust.js");
      if (values.revoke) {
        const revoked = await trust.trustProjectPolicy(env, nodeFileSystem, {
          revoke: true,
        });
        write(
          revoked.kind === "revoked"
            ? `Trust revoked for ${render.safe(revoked.path)}: its allow rules are ignored again.\n`
            : revoked.kind === "no-policy"
              ? "This project has no .reflex/policy.yaml.\n"
              : "Could not write the trust record.\n",
        );
        return revoked.kind === "revoked" || revoked.kind === "no-policy"
          ? 0
          : 1;
      }
      const status = await trust.readProjectPolicy(env, nodeFileSystem);
      if (status.reading === undefined) {
        write(
          'This project has no .reflex/policy.yaml. "rfx policy starter" writes one.\n',
        );
        return 0;
      }
      if (status.reading.problems.length > 0) {
        write(
          `${render.safe(status.reading.path)} does not load:\n  ${status.reading.problems.join("\n  ")}\nFix it before trusting it.\n`,
        );
        return 1;
      }
      if (status.reading.trusted) {
        write(
          `${render.safe(status.reading.path)} is already trusted at this content.\n`,
        );
        return 0;
      }
      write(
        [
          `${render.safe(status.reading.path)} is untrusted: its deny and ask rules apply, its allow rules do not.`,
          "Trusting this version would let through:",
          ...trust.describeAllowRules(status.reading.allowRules),
          "A changed file is untrusted again and asks again.",
          "",
        ].join("\n"),
      );
      if (!(await confirm("Trust this policy?", values.yes))) {
        return 0;
      }
      const result = await trust.trustProjectPolicy(env, nodeFileSystem);
      if (result.kind !== "trusted") {
        write("Could not write the trust record.\n");
        return 1;
      }
      const { appendAudit } = await import("./commands/pause-command.js");
      const { reflexHome } = await import("./state.js");
      await appendAudit(reflexHome(env), {
        at: env.now().toISOString(),
        kind: "trust",
        projectDir: env.projectDir,
        detail: { path: result.path, policyHash: result.policyHash },
      });
      write(
        `Trusted ${render.safe(result.path)} (${result.policyHash.slice(0, 19)}...). Its allow rules apply from the next decision.\n`,
      );
      return 0;
    }

    case "policy": {
      if (
        argument === "keygen" ||
        argument === "snapshot" ||
        argument === "subscribe" ||
        argument === "unsubscribe"
      ) {
        const team = await import("./commands/team-policy.js");
        if (argument === "keygen") {
          const keys = await team.generateKeys(env, nodeFileSystem, {
            ...(values.out === undefined ? {} : { out: values.out }),
          });
          if (keys.kind === "exists") {
            write(
              `${render.safe(keys.privateKeyPath)} exists and was not touched. Choose another --out, or move it first.\n`,
            );
            return 1;
          }
          if (keys.kind === "write-failed") {
            write(`Could not write ${render.safe(keys.privateKeyPath)}.\n`);
            return 1;
          }
          write(
            [
              `Private key  ${render.safe(keys.privateKeyPath)}  (mode 600; keep it where the team keeps secrets, never in a repository)`,
              `Public key   ${render.safe(keys.publicKeyPath)}  (give this one to every subscriber)`,
              `Key id       ${keys.keyId}`,
              "",
            ].join("\n"),
          );
          return 0;
        }
        if (argument === "snapshot") {
          if (
            values.policy === undefined ||
            values.key === undefined ||
            values.label === undefined ||
            values.out === undefined
          ) {
            write(
              "Usage: rfx policy snapshot --policy <org.yaml> [--environment <env>=<file>]... --key <private.pem> --label <version> --out <file>\n",
            );
            return 2;
          }
          const written = await team.writeSnapshot(env, nodeFileSystem, {
            policy: values.policy,
            environments: values.environment ?? [],
            key: values.key,
            label: values.label,
            out: values.out,
          });
          if (written.kind === "invalid") {
            write(`Not written: ${render.safe(written.reason)}\n`);
            return 1;
          }
          if (written.kind === "write-failed") {
            write(`Could not write ${render.safe(written.path)}.\n`);
            return 1;
          }
          write(
            `Wrote ${render.safe(written.path)}: version ${written.version}, ${String(written.sources)} source(s), ${written.hash}, signed with ${written.keyId}. Publish it where every member can fetch it over HTTPS or from a shared file.\n`,
          );
          return 0;
        }
        if (argument === "subscribe") {
          const location = positionals[2];
          if (location === undefined || values.key === undefined) {
            write(
              "Usage: rfx policy subscribe <https URL | file> --key <public.pem>\n",
            );
            return 2;
          }
          const result = await team.subscribe(env, nodeFileSystem, {
            location,
            key: values.key,
          });
          if (result.kind === "invalid") {
            write(`Not subscribed: ${render.safe(result.reason)}\n`);
            return 1;
          }
          if (result.kind === "write-failed") {
            write("Could not write the subscription.\n");
            return 1;
          }
          const first =
            result.first.kind === "applied"
              ? `Snapshot ${result.first.version} (${result.first.hash.slice(0, 19)}...) verified and in force from the next decision.`
              : result.first.kind === "refused"
                ? `The snapshot there could not be applied yet (${render.safe(result.first.reason)}); the daemon keeps trying and "rfx status" shows it.`
                : "Nothing fetched yet.";
          write(
            `Subscribed to ${render.safe(result.location)} with key ${result.keyId}. ${first}\n`,
          );
          return result.first.kind === "applied" ? 0 : 1;
        }
        const result = await team.unsubscribe(env, nodeFileSystem);
        write(
          result.kind === "unsubscribed"
            ? `Unsubscribed from ${render.safe(result.location)}. The team's rules no longer apply from the next decision.\n`
            : result.kind === "not-subscribed"
              ? "No team policy subscription.\n"
              : "Could not remove the subscription.\n",
        );
        return result.kind === "write-failed" ? 1 : 0;
      }
      if (argument !== "starter") {
        write(
          "Usage: rfx policy starter [--force] | keygen | snapshot | subscribe | unsubscribe\n",
        );
        return 2;
      }
      const { writeStarterPolicy } = await import("./commands/starter.js");
      const written = await writeStarterPolicy(env, nodeFileSystem, {
        force: values.force,
      });
      if (written.kind === "written") {
        write(
          `Wrote ${render.safe(written.path)} and trusted it as written. Edit it freely; "rfx explain" shows what applies.\n`,
        );
        return 0;
      }
      if (written.kind === "exists") {
        write(
          `${render.safe(written.path)} exists and was not touched. Re-run with --force to replace it; the current file is backed up first.\n`,
        );
        return 1;
      }
      if (written.kind === "replaced") {
        write(
          `Replaced ${render.safe(written.path)}; the previous file is at ${render.safe(written.backup ?? "")}. Trusted as written.\n`,
        );
        return 0;
      }
      write("Could not write the policy file.\n");
      return 1;
    }

    case "pause": {
      const { pauseEnforcement } = await import("./commands/pause-command.js");
      const result = await pauseEnforcement(
        env,
        nodeFileSystem,
        values.for,
        values.reason,
      );
      if (result.kind === "paused") {
        write(
          `Paused until ${result.record.until}. REFLEX keeps observing and answers nothing until then. "rfx resume" ends it early.\n`,
        );
        return 0;
      }
      if (result.kind === "bad-duration") {
        write(
          'A pause needs a bounded duration: "rfx pause --for 30m" (s, m, h, d; at most 1d).\n',
        );
        return 2;
      }
      write("Could not write the pause.\n");
      return 1;
    }

    case "resume": {
      const { resumeEnforcement } = await import("./commands/pause-command.js");
      const result = await resumeEnforcement(env, nodeFileSystem);
      if (result.kind === "resumed") {
        write(`Resumed. The pause was to end at ${result.wasPausedUntil}.\n`);
        return 0;
      }
      if (result.kind === "not-paused") {
        write("REFLEX was not paused.\n");
        return 0;
      }
      write("Could not remove the pause file.\n");
      return 1;
    }

    case "doctor": {
      const { renderDoctor, runDoctor } = await import("./commands/doctor.js");
      const report = await runDoctor(env, nodeFileSystem);
      write(
        values.json
          ? `${JSON.stringify(report, null, 2)}\n`
          : renderDoctor(report),
      );
      return report.failures > 0 ? 1 : 0;
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
