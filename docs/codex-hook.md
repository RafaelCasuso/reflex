# The Codex hook

What `rfx init` installs for Codex, how the hook answers on each of Codex's
two channels, and what is documentation and what is observed. Gate G8.

**Verification status.** Everything here about the host comes from Codex's
own documentation ("Hooks" and the configuration reference, read on
2026-09-27). Nothing has been checked against a live Codex yet: the Codex
installed where this was written (0.101.0) predates hooks. The fixtures
(`packages/adapter-codex/fixtures/codex-hooks-doc/`) are composed from the
documentation and say so. §5 is the procedure for the live run, which is a
maintainer's step, like RFX-087 was for Claude Code.

## 1. What gets installed

`rfx init` (when `codex` is on `PATH`, or with `--host codex`) adds one hook
to each of four events in a Codex `hooks.json`, and turns the feature on:

| Event               | What it tells REFLEX                          |
| ------------------- | --------------------------------------------- |
| `PreToolUse`        | the action itself                             |
| `PermissionRequest` | the host is about to show its approval prompt |
| `PostToolUse`       | the tool call completed                       |
| `Stop`              | the agent's turn ended                        |

Codex has no `PostToolUseFailure` or `PermissionDenied`; where it exposes no
signal, the outcome says `unknown` (RFX-093).

- **File.** `~/.codex/hooks.json` by default (scope `user`). Codex has no
  personal, project-scoped file the way Claude Code has
  `.claude/settings.local.json`: the project file `.codex/hooks.json` is
  committed and shared, and the hook command holds an absolute path to this
  user's `rfx`. `--scope project` exists and warns; `--scope local` is not a
  Codex scope and falls back to `user`, and the plan says so. A user-scoped
  hook fires in every Codex session, so **the hook keeps to the projects
  REFLEX was installed in** (the install registry, by the payload's `cwd`,
  the project or a directory under it) and records nothing elsewhere.
- **Command.** `REFLEX_MANAGED=1 '<node>' '<rfx>' hook codex`, 5 s timeout
  (the host default is 600 s).
- **The feature flag.** Codex runs no hook unless `features.hooks = true` is
  in `~/.codex/config.toml`. `rfx init` sets it with the smallest edit that
  keeps the user's bytes (a line under an existing `[features]` table, or an
  appended table), re-parses the result before trusting it, and records that
  it was REFLEX who set it, so that `rfx uninstall` unsets it and only then.
  An inline `features = { ... }` table is left to the user, and the plan
  warns that REFLEX would be installed and never run until the flag is on.
- **What is read and never written (RFX-047).** A `[hooks]` table in
  `config.toml` (the user's own representation: REFLEX installs into
  `hooks.json`, which Codex reads as well, and says so), `approval_policy`,
  `sandbox_mode`, and the project's `trust_level`; the plan reports them.
- **Edits are surgical**, as for Claude Code: `hooks.json` is never parsed and
  re-serialized, the user's hooks, comments, indentation and `description`
  keep their bytes, and every write goes through the reversible transaction
  with a backup.
- **Trust.** Codex asks the user to trust a new hook once (`/hooks` inside
  Codex). `rfx init` says so when it is done. Whether a hook is trusted is not
  something REFLEX can read yet.

`rfx uninstall` restores each file byte for byte when it has not changed
since the install, and otherwise removes only REFLEX's entries (and its
`hooks = true` line). A user file another installed project still uses is
kept; only this project's registry entry goes.

## 2. What the hook answers

Codex has two channels, and REFLEX uses each for what it is (ADR-007,
`docs/integrations.md`): `PreToolUse` sees every call and can block it or ask
for the native prompt; `PermissionRequest` fires only when Codex is about to
show its own prompt, and can approve, deny, or say nothing so that the prompt
goes on. The effect mapped is the engine's `effectiveEffect` for the project's
mode (ADR-002), read from the install registry on every call.

| effect  | `PreToolUse`                                 | `PermissionRequest`                             |
| ------- | -------------------------------------------- | ----------------------------------------------- |
| `allow` | nothing: Codex proceeds as it would have     | `decision.behavior: allow` (the prompt is gone) |
| `ask`   | `permissionDecision: ask` (Codex prompts)    | nothing: the native prompt goes on              |
| `deny`  | `permissionDecision: deny` (the call blocks) | `decision.behavior: deny`, with the reason      |
| Observe | nothing                                      | nothing                                         |

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
```

- **ASK is native delegation and nothing else.** On `PermissionRequest` it is
  abstention: the hook prints nothing and Codex shows its own prompt. On
  `PreToolUse` it is the value Codex documents for exactly that ("Codex
  shows its own prompt"); it is not a dialog of REFLEX's own, and it is what
  keeps an uncertain action from running when Codex, on its own policy,
  would not have asked. If a live run shows Codex ignoring that value, the
  row changes to "nothing", and the `PermissionRequest` abstention is what
  remains: never a simulated prompt.
- **`allow` is granted where Codex asks, not before.** `PreToolUse` never
  widens what Codex would have done on its own; the prompt that REFLEX
  eliminates is the one Codex was about to show.
- **Assist never denies:** a deny arrives as `ask`, so `PreToolUse` asks and
  `PermissionRequest` abstains. **Autopilot** blocks on `PreToolUse` and, if a
  `PermissionRequest` still arrives, denies it too. The deny's reason line
  ends with the way out (`rfx override <decisionId>`, RFX-125).
- **When the daemon cannot be reached** (ADR-003 §4): the hook answers by
  itself on the channel the event has, `ask` (or `deny` under `fail-closed`
  in Autopilot) on `PreToolUse`, abstention (or `deny`) on
  `PermissionRequest`, inside its 2.5 s budget.
- **The reason line** carries rule ids and reason codes, never a rule's name
  or an argument value; Codex may show it to the user or feed it to the model.

Held against the real binary and the real daemon in
`packages/cli/src/bin.e2e.test.ts` ("rfx hook codex"): Observe silent on
every documented event and outcomes assembled from them; nothing recorded for
a project REFLEX is not installed in; Assist `allow` on `PermissionRequest`,
`ask` on `PreToolUse`, abstention on `PermissionRequest` for a denied rule;
Autopilot `deny` on both; the client's own answers when the daemon cannot
start.

## 3. What the adapter reads (RFX-048)

- `Bash`: `tool_input.command`, copied as the command operand, never
  interpreted by the adapter (the command classifier does that, ADR-011).
- `apply_patch`: its patch, in `tool_input.command` (documented). The adapter
  reads only the file headers of the patch format (`*** Add File`,
  `*** Update File`, `*** Delete File`, `*** Move to`) into path operands, and
  classifies the call `local-write`, or `destructive` when the patch deletes
  a file, as `rm` is. A tool named `apply_patch` whose input is not a patch in
  that format is `unknown`, with no operand an allow rule could match.
- MCP tools: `mcp__<server>__<tool>` (documented) into namespace and name,
  never classified by name.
- `update_plan` is `none` (the agent's own plan). Everything else is
  `unknown`, never safe (ADR-001 §4). Hosted tools (`WebSearch`) never reach
  a hook.
- `PermissionRequest` carries no `tool_use_id` (documented): its record names
  the session and the tool, and the outcome assembler attributes it by order,
  as it does for Claude Code.

## 4. Outcomes (RFX-093)

From the three signals Codex exposes, the four cases of RFX-092 come out as:
prompted and approved (`PreToolUse`, `PermissionRequest`, `PostToolUse`);
prompted and rejected (`PreToolUse`, `PermissionRequest`, then `Stop`); ran
without a prompt (`PreToolUse`, `PostToolUse`); and no signal at all, which
is `unknown` on every axis and is never folded into "not prompted" or "did
not run" (`packages/adapter-codex/src/observe.test.ts`).

## 5. Live verification procedure

What a maintainer does with a Codex that has hooks (0.157 or later), once,
and records under `packages/adapter-codex/fixtures/codex-<version>/`:

1. In a scratch project, `rfx init --host codex --yes`, then inside Codex
   `/hooks` and trust the `REFLEX_MANAGED=1` entries.
2. Ask Codex to run one harmless command (`touch marker.txt`), once with a
   policy that allows it in Assist, once with one that denies it in
   Autopilot, once with none in Observe.
3. For each event, keep the payload Codex wrote to the hook's stdin (the
   observe log holds the shape; a one-line `tee` hook holds the bytes) and
   what Codex did with the answer: did the `PreToolUse` `ask` prompt, did the
   `PermissionRequest` `allow` skip the prompt, did the `deny` block.
4. Update this page: turn "documented" into "verified" where it held, change
   the table where it did not, and add the version to the fixtures' README.

## 6. Where these facts come from

| Fact                                              | Source                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Events, input and output fields, exit codes       | Codex documentation, "Hooks", read 2026-09-27                                            |
| `hooks.json` and `[hooks]` locations and shape    | the same page                                                                            |
| `features.hooks` and its alias, approval, sandbox | Codex configuration reference, read 2026-09-27                                           |
| `apply_patch` patch in `tool_input.command`       | "Hooks", `PermissionRequest` input notes                                                 |
| Tool names and the MCP form                       | "Hooks", matchers and tool names                                                         |
| Anything observed live                            | **nothing yet** (§5); the Codex here, 0.101.0, has no hooks (binary strings, 2026-09-27) |
