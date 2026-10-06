# Hosts

REFLEX installs as a hook into each host and translates the host's events into one canonical action, so one policy decides for every host. This page says, per host, what is hooked, how a verdict reaches the host, and how much of it is verified against the real thing rather than its documentation.

## Claude Code

**Verified against the real binary.** The repository's end-to-end tests install the hook, start the daemon and run `claude` headless with recorded payloads; the hook's inputs are also checked daily against the type declarations of the latest Claude Code release on npm, so a change in what the hook receives fails a check before it fails a user.

| What                    | How                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Install                 | `rfx init` adds one hook to each of `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `Stop` in the project's `.claude/settings.local.json` (or the scope you choose); your own hooks stay |
| `allow`                 | `PreToolUse` answers `permissionDecision: allow`; the host runs the tool without a prompt                                                                                                                                            |
| `ask`                   | `PreToolUse` answers `permissionDecision: ask`; the host's own permission prompt is shown, with the rule's name as the reason                                                                                                        |
| `deny`                  | `PreToolUse` answers `permissionDecision: deny` with the rule and the override command; the tool does not run                                                                                                                        |
| Observe                 | the hook answers nothing, ever; the host behaves as if REFLEX were not there                                                                                                                                                         |
| Outcomes                | `PostToolUse`, `PostToolUseFailure` and `PermissionDenied` say what happened; `rfx status` counts prompts, approvals, rejections and host blocks                                                                                     |
| If REFLEX cannot decide | the project's failure mode (ask by default); the hook answers within the host's own timeout and never hangs it                                                                                                                       |

Claude Code's Auto mode and its sandbox keep working underneath. REFLEX decides before them, from your policy; they still catch what your policy did not name.

## Codex

**Built from Codex's documentation; not yet verified live.** Codex's hooks are a near-port of Claude Code's and REFLEX follows the documented behaviour exactly; the fixtures in the repository are composed from the documentation and say so. Until a live run confirms them, the rows below are "documented", not "verified", and the repository's notes say which questions a live run answers.

| What                    | How                                                                                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install                 | `rfx init` adds hooks to `~/.codex/hooks.json` for `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, and sets `features.hooks = true` in `~/.codex/config.toml`, which Codex needs to run any hook; nothing else in that file changes |
| `allow`                 | on `PermissionRequest`, the hook answers `allow`; on `PreToolUse` it never does, so REFLEX never widens what Codex would do on its own                                                                                                        |
| `ask`                   | on `PreToolUse`, the documented `ask`; on `PermissionRequest`, the hook abstains and Codex's own approval goes on                                                                                                                             |
| `deny`                  | on both events, with the rule and the override command                                                                                                                                                                                        |
| Observe                 | the hook answers nothing                                                                                                                                                                                                                      |
| If REFLEX cannot decide | `PreToolUse` asks (denies under `fail-closed`); `PermissionRequest` abstains (denies under `fail-closed`)                                                                                                                                     |

Hooks that are not managed by an organization need to be trusted once in Codex (`/hooks`); `rfx doctor` says when `features.hooks` is off.

## Both

- The hook is the same program (`rfx hook <host>`) and the daemon is the same; a team's snapshot, a project's policy and your own apply to both hosts identically.
- Tool names are stripped of control characters before they are printed anywhere: an MCP server chooses its tool names, and a terminal runs escape sequences.
- The hook costs what starting a Node process costs; the decision itself is made in the daemon and takes well under a millisecond on a cache hit. The numbers are on the [front page](/), each from the file that measured it.

## Next

MCP servers reached through a proxy, and SDKs for agents you build yourself, are the next hosts; they translate into the same canonical action.
