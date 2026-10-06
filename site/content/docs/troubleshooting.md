# Troubleshooting

Start with `rfx doctor`. It checks everything on this page, in this order, and every failure it prints names what to do. This page mirrors its checks, area by area, with the same names; a test in the repository holds the two together.

```sh
rfx doctor
```

{{{captures.doctor.html}}}

`rfx doctor --json` prints the same report for a script. Exit code 1 means at least one failure; warnings and information do not fail it.

## install

- **install registry**: `~/.reflex/installs.json` could not be read, or lists no install. Run `rfx init` again; the registry is rebuilt from what it writes.
- **this project**: this directory is not installed, or the install is in a parent directory. `rfx init` here, or run your agent from the installed directory.

## state

- **local identity**: `~/.reflex/identity.json` is missing or unreadable. `rfx init` creates it; it is random and never sent anywhere.
- **pause**: enforcement is paused until the time shown. `rfx resume` ends it early.
- **REFLEX home**: `~/.reflex` is readable by others. `chmod 700 ~/.reflex`; it holds your observations and keys.

## hosts

- **node binary**: the Node that the hook command names is gone (a version manager switched, a reinstall). `rfx init` rewrites the hook with the current one.
- **rfx entry**: the `rfx` the hook command names is gone (a global upgrade moved it). `rfx init` rewrites it.
- **claude-code hooks**, **codex hooks**: the host's settings file is gone, no longer parses, or REFLEX's hook was removed or edited. `rfx init` puts it back; a file REFLEX cannot parse is left alone and named, so you can fix it by hand. Claude Code: `disableAllHooks` in that file switches every hook off.
- **codex config**, **codex hooks feature**: Codex runs no hook while `features.hooks` is off in `~/.codex/config.toml`; `rfx init --host codex` sets it, and nothing else in that file.
- **codex trust**: Codex asks you to trust non-managed hooks once (`/hooks` inside Codex). Until then the hook is installed and never runs.

## daemon

- **daemon**: it starts on the first decision it is asked for; "not running" is normal before that. If it cannot start, the log is in `~/.reflex/run/daemon.log`; the hook answers with the project's failure mode meanwhile and never hangs the host.
- **daemon version**: a daemon older than the installed `rfx` is still answering. It is replaced on the next hook call; `rfx uninstall` and `rfx init` stop it now.
- **socket directory**: `~/.reflex/run` must be readable by you only (`0700`), or the daemon refuses to listen there. Fix the mode; the daemon creates the directory itself when it is missing.

## policy

- **user policy**: `~/.reflex/policy.yaml` does not load, with the line and the reason. Until it is fixed the daemon runs with REFLEX's own rules only. `rfx explain <command>` shows what applies.
- **project policy**: `.reflex/policy.yaml` does not load (fix it; until then it is ignored), or is untrusted (`rfx trust` shows what it would allow and trusts this version), or there is none (`rfx policy starter` writes a conservative one).
- **team policy**: the subscription record cannot be used (`rfx policy subscribe` again, or `rfx policy unsubscribe`); subscribed but no snapshot is in force (check that the location serves the snapshot and that it was signed with the key you subscribed with; the daemon retries on its interval); or the last fetch failed while a snapshot is in force (the last good one stays, by design).

## provider

- **provider**: a remote provider is configured without the consent that covers it, so it is withheld and REFLEX runs with policy alone; `rfx provider <name> --consent` shows the statement and asks.
- **provider key**: the provider's key is missing from the environment the daemon starts with, or the key file is readable by others. Set it where your shell starts the hook from, or `chmod 600` the file.

## Not in `rfx doctor`

- **The hook answers "the local daemon could not be started or reached".** The daemon log says why; a socket path longer than your platform allows (about 100 characters on macOS) is the usual cause when `REFLEX_HOME` is deep.
- **A decision takes seconds.** The first call after a restart starts the daemon; every call after that is answered from the socket. The numbers are on the [front page](/#what-a-decision-costs).
- **`rfx explain` and the host disagree.** `explain` does not know what a semantic provider would say about an unresolved action, and says so; everything else is the same evaluation.
