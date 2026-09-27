# The Claude Code hook

What `rfx init` installs, what Claude Code does when that hook fails, and what a
hook call costs. Gate G1.5: REFLEX observes and never answers the host.

## 1. What gets installed

`rfx init` adds one hook to each of six events in a Claude Code settings file:

| Event                | What it tells REFLEX                          |
| -------------------- | --------------------------------------------- |
| `PreToolUse`         | the action itself                             |
| `PermissionRequest`  | the host is about to show its approval prompt |
| `PostToolUse`        | the tool call completed                       |
| `PostToolUseFailure` | the host reported the call as failed          |
| `PermissionDenied`   | the host refused the call without asking      |
| `Stop`               | the agent's turn ended                        |

- **File.** `.claude/settings.local.json` by default: project-scoped, personal,
  ignored by git. The command holds an absolute path to this user's `rfx`, so
  the shared `.claude/settings.json` would give every teammate a failing hook.
  `--scope project` and `--scope user` exist and warn.
- **Command.** `REFLEX_MANAGED=1 '<node>' '<rfx>' hook claude-code`. The leading
  assignment is harmless to the shell and is how REFLEX recognizes its own
  entries later, whatever the paths are.
- **Timeout.** 5 seconds, explicit. The host default is 600 seconds, and a hung
  observer must not be able to stall an agent for ten minutes.
- **Edits are surgical.** The file is never parsed and re-serialized. The
  user's indentation, line endings, comments, key order and other hooks keep
  their bytes. Every write goes through a reversible transaction with a backup.

`rfx uninstall` restores the file byte for byte when it has not changed since
the install, and otherwise removes only REFLEX's entries and keeps the user's
edits.

## 2. The Observe guarantee

In Observe, the hook never changes what the host does. A hook speaks to Claude
Code through three channels, and the observer uses none of them:

- **stdout** is where a hook answers. JSON there can be a permission decision.
- **stderr** may be shown to the user or fed back to the model.
- **the exit code**: `2` blocks the tool call, other non-zero codes show the
  user an error notice.

So the hook prints nothing and exits `0`, whatever happens: unreadable payload,
full disk, a bug. What is lost is one observation. This is checked by running
the real binary as a child process against every failure mode
(`packages/cli/src/bin.e2e.test.ts`).

What is written to disk is the **shape** of the arguments (keys, types, sizes),
never a value, until the redactor exists (RFX-031). Key names are written only
when they look like schema identifiers and only in the top two object levels: a
token used as a map key must not reach the log.

## 2b. Decisions (RFX-043, RFX-045, RFX-046)

Since G7 the same hook decides, when the project asks it to. The mode is
per project, in REFLEX's install registry, set by `rfx init --mode` or
`rfx mode`; the daemon never knows it and the hook reads it on every call
by the payload's own working directory. Absent, `observe`.

| Mode        | What the hook does on `PreToolUse`                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `observe`   | records, answers nothing: §2 holds in full                                                                                |
| `assist`    | records, asks the daemon, answers `allow` for what a rule or the model allows and `ask` for everything else; never `deny` |
| `autopilot` | records, asks the daemon, answers `allow`, `ask` or `deny` as decided                                                     |

The answer is the host's own `PreToolUse` permission decision, one JSON
line on stdout and nothing else:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "REFLEX: needs your approval, rule deny-rm (destructive)"
  }
}
```

`ask` is native delegation and nothing else (CLAUDE.md principle 4): the
host's own approval flow decides, and REFLEX opens no dialog of its own.
The effect answered is the engine's `effectiveEffect` for the mode
(ADR-002), which is how Assist never blocks. The reason line names the rule
id, the reason codes, the provider or the fallback, never a rule's name or
an argument value; it may be shown to the user or fed to the model.

**When the daemon does not answer** (ADR-003 §4): the hook starts it once
(RFX-138, `docs/decision-gateway.md` §3), inside its own budget of 2.5 s,
well under the hook's 5 s timeout after which the host runs the call. If
it still cannot decide, the hook answers by itself: `ask`, or `deny` in
Autopilot under `fail-closed`. It never exits non-zero, never prints
anything but its answer, and never stays silent in these modes, because
silence would let the host run the call. The failure mode is per project
too (`rfx mode --failure-mode`), `fail-ask` by default.

The other events (`PermissionRequest`, `PostToolUse`, `PostToolUseFailure`,
`PermissionDenied`, `Stop`) are observed silently in every mode. Every one
of these rows is held by `packages/cli/src/bin.e2e.test.ts` against the
real binary and the real daemon: Observe silent on an allowed and on a
denied fixture; Assist `allow` for `touch marker.txt` under a rule,
`ask` for `rm -rf build` under a deny rule and for an unresolved write;
Autopilot `deny` for the same `rm`; and the client's own `deny` under
`fail-closed` when the daemon cannot start, in time.

## 2c. Consent before action content leaves the machine (RFX-123)

With no provider, nothing the hook sees leaves the machine: the daemon
decides by policy and an open action asks. Choosing a remote provider is
the first time a redacted command or path is sent anywhere, and it is done
by the human, once, in a terminal:

```
rfx provider jev            shows the statement, asks "Do you agree to this?"
rfx provider jev --consent  the same, for a script or a non-interactive shell
rfx provider none           back to policy alone; the consent is withdrawn
rfx provider local --model <checkpoint>   an inference server on this machine; no consent needed
```

The statement (`packages/semantic-provider/src/consent.ts`) says what is
sent per action (tool, operation, class, arguments after redaction, the
objective and task summary after redaction, environment, branch and remote
host, summaries of prior actions, matching rule names; never identity,
project id, working directory, tool output, transcripts or host metadata),
what is redacted first on the machine (fifteen shapes of secret, inside
encodings too, replaced by fingerprints; what the redactor does not
recognize is sent as it is), where it goes and for how long (the provider
named; the redacted request kept locally for seven days), and that
declining keeps REFLEX working with policy alone. A yes is recorded in
`<REFLEX_HOME>/consent.json` with the provider and the digest of the
statement shown, user-only. A changed statement has another digest, and
the question is asked again.

Two checks hold it, so that a `config.json` written by hand or through the
agent uploads nothing: the CLI passes a remote provider to the daemon only
under a consent that covers it and otherwise starts the daemon with policy
alone (`rfx status` says `jev configured without consent`); the daemon,
given a remote provider, refuses to start without the covering record
(`--remote-consent`), before it reads any key. `rfx provider` is one of the
commands REFLEX's own rule asks a human about (RFX-103), so the agent cannot
give consent for you. Held end to end in `bin.e2e.test.ts`.

## 3. What the host does when the hook fails (RFX-087)

**Status: verified against a live host.** Claude Code 2.1.276, headless
(`claude -p`), 2026-09-19. Each row marked _live_ was produced by
`packages/adapter-claude-code/live/verify-hook-failures.mjs`: a scratch project
with one `PreToolUse` hook that misbehaves in exactly one way, a session asked
to run `touch marker.txt`, and the answer read from the disk (does the marker
exist), not from the model. The recorded runs are checked in under
`packages/adapter-claude-code/live/results/`, and
`src/live-evidence.test.ts` holds this table to that record in CI.

| The hook…                                   | Claude Code…                                                                                                        | Fail-open? | Evidence                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------- |
| exits 0 and prints nothing                  | continues with its normal permission flow                                                                           | by design  | live: `silent-exit-0`         |
| exits 2 on `PreToolUse`                     | blocks the call. No completion event follows                                                                        | no         | live: `exit-2`                |
| answers `permissionDecision: "deny"`        | blocks the call. No completion event follows                                                                        | no         | live: `json-deny`             |
| exits with any other non-zero code          | carries on: the call runs                                                                                           | **yes**    | live: `exit-1`                |
| exits 0 and prints invalid JSON             | carries on: the call runs                                                                                           | **yes**    | live: `invalid-json`          |
| exceeds its timeout                         | carries on: the call runs, even though the hook would have blocked it (it exits 2 after 20 s; the session took 8 s) | **yes**    | live: `timeout` (2 s timeout) |
| command is missing (`rfx` moved or removed) | carries on: the call runs                                                                                           | **yes**    | live: `missing-command`       |
| is switched off by `disableAllHooks`        | runs no hook at all, for any event, and runs the call                                                               | **yes**    | live: `hooks-disabled`        |

Every row above is backed by a recorded live run and a test. What follows is
**not**, and is kept out of the table for that reason:

- **Documentation only:** `allowManagedHooksOnly` excludes the hook, which then
  never runs (fail-open). Exit code 2 is ignored on `PermissionRequest`, and on
  `PostToolUse` only shows stderr, because the tool has already run.
- **By construction:** a hook removed from the settings file never runs
  (fail-open). It is the host's baseline, and `hooks-disabled` shows the host
  runs the call when no hook does.
- **Not observed:** the interactive terminal (every run was headless), and what
  the user is shown when a hook errors. The hook engine is the same, but that
  is an inference, not a measurement. RFX-089 closed without it: its runs were
  headless too, because a harness has nobody to press a key.

### What else the live runs showed

These were not in the documentation consulted, and three of them changed code.

1. **`PermissionRequest` does not say which call it is about.** `PreToolUse`,
   `PostToolUse` and `PostToolUseFailure` carry `tool_use_id`;
   `PermissionRequest` does not (it carries `permission_suggestions` instead).
   The adapter used to drop a signal it could not tie to a call, so no action
   would ever have been recorded as prompted, and "approval prompts eliminated"
   would have been computed from nothing. The signal is now recorded with the
   session and the tool name, and attributed to the latest action of that
   session and tool that has not been prompted, has not completed and whose
   turn has not ended. Nothing derived from the arguments takes part, not even
   a hash. Known limit: two calls to the same tool running in parallel can swap
   a prompt between them. Counts stay right; a signal with no plausible owner
   is dropped, never forced onto an action.
2. **`PostToolUseFailure` means the tool ran.** It fired for a command that
   executed and exited non-zero (`error: "Exit code 1 …"`,
   `is_interrupt: false`), and for no refused or blocked call. A failed action
   may have had its side effects, so its outcome is `executed: "yes"` (it used
   to be `unknown`).
3. **A call that is not approved leaves no completion event.** The host fires
   `PermissionRequest`, then nothing for that call, then `Stop`. That is the
   only trace of a refusal, and it is what the outcome rule "prompted, turn
   ended, never executed ⇒ rejected" relies on. It was observed headless, where
   the host refuses on the human's behalf. A human pressing "no" in the
   terminal has still not been observed: the RFX-089 runs were headless too.
4. **`PermissionRequest` fires in headless mode** when a tool is not
   pre-approved, although nobody can answer.
5. **A hook that answers `ask` where nobody can answer gets a refusal**, with
   no `PermissionRequest` event. For the enforcing adapter this means `ASK`
   degrades to a denial in headless hosts. That is the safe direction, and
   ADR-003 must state it rather than discover it.
6. **A call blocked by a hook leaves no trace at all**: no completion, no
   `PermissionDenied`, no prompt. REFLEX reports such an outcome as `unknown`
   on all three fields. From Assist on, the hook knows what it answered and
   must record it itself; it cannot be read back from the host.
7. **`PermissionDenied` was never observed**, in any case. The adapter keeps
   subscribing to it, and the rule that reads it is untested against a live
   host.
8. **`Stop` carries `last_assistant_message`**, which is conversation content.
   The adapter reads none of it, and a test holds that it never reaches a
   record.
9. **Project hooks do run in `-p`**, with `--setting-sources project`.

### What this means

In Observe every fail-open row is harmless, and is in fact the desired
behavior: an observer must not be able to hurt its host.

From Assist on, each of those rows is a way for REFLEX to **silently disappear
from the execution path**, which `CLAUDE.md` principle 5 forbids. The host will
not close them for us: apart from exit code 2, Claude Code fails open on
everything. They have to be closed or made loud on REFLEX's side:

| Fail-open path                              | Closed or surfaced by                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hook removed, disabled, altered or excluded | `rfx status` re-reads the file and reports `HOOK MISSING`, `DISABLED` or `HOOK ALTERED` (the marker is still there and the command is not the one this `rfx` installs); built-in mandatory rules make every write to REFLEX's files or to the host's hook settings ask a human first (RFX-103) |
| command missing after an upgrade/move       | `rfx init` is self-healing and re-points the hook; RFX-055 (`rfx doctor`) should check the path                                                                                                                                                                                                |
| crash, invalid output                       | the enforcing hook must catch everything and answer explicitly (`ask` or `deny`) per ADR-003; never exit non-2                                                                                                                                                                                 |
| timeout                                     | the enforcing hook needs its own deadline, shorter than the host's, and must answer before it (RFX-022)                                                                                                                                                                                        |
| a local daemon that is down                 | ADR-010 must define what the hook answers when it cannot reach it                                                                                                                                                                                                                              |
| host schema drift                           | RFX-124 (canary)                                                                                                                                                                                                                                                                               |

One more consequence: an enforcing hook that wants `deny` on failure must
produce it **itself**, quickly and reliably. "Fail closed" cannot rely on the
host, because the host's reading of a broken hook is "carry on".

### Live verification procedure

```sh
cd packages/adapter-claude-code
node live/verify-hook-failures.mjs                       # prints the usage, runs nothing
node live/verify-hook-failures.mjs --run                 # every case, rewrites the record
node live/verify-hook-failures.mjs --run --only exit-2 --merge
```

It runs the real host, so it needs a logged-in Claude Code and spends that
account's quota: about $0.02 per case, $0.23 for the eleven cases on the
cheapest model. Nothing runs without `--run`, and an unknown flag is an error
rather than a run. It is not part of `pnpm test`.

Each session is confined to a scratch directory, may run only the one command
its case names, loads no user settings and no MCP servers, is not persisted,
and has a hard budget cap. Scratch paths and the home directory are replaced
before anything is written to the record, and a test refuses a record that
holds a path, an address or a credential of the machine it ran on.

Run it again for a new host version: the record is written per version, and
the evidence suite runs on every record present. RFX-124 (canary) is the
ticket that makes this routine.

## 4. What a hook call costs (RFX-088)

Wall clock from `spawn` to `exit` with a real payload on stdin: process start,
module loading, payload parse, translation, record, exit. That is what the host
waits for. Reproduce with `pnpm --filter @reflex/cli bench`.

Baseline, 2026-09-19. Apple M1 Max, macOS (darwin 25.6.0 arm64), Node 24.9.0.
60 sequential runs per case after 5 warm-up runs.

| Case                                          | min     | p50     | p95     |
| --------------------------------------------- | ------- | ------- | ------- |
| Floor: an empty Node process                  | 27.2 ms | 30.2 ms | 40.6 ms |
| Hook, `PreToolUse` (translate, shape, record) | 45.0 ms | 48.8 ms | 59.3 ms |
| Hook, `PostToolUse` (signal, record)          | 43.1 ms | 46.3 ms | 49.4 ms |
| Hook, an event it ignores                     | 42.1 ms | 45.1 ms | 56.1 ms |

### Against the budgets in `CLAUDE.md`

| Budget                                               | Measured end to end       | Verdict                                        |
| ---------------------------------------------------- | ------------------------- | ---------------------------------------------- |
| Deterministic policy decision, p95 < 10 ms           | 59 ms before any decision | **Unreachable** with one Node process per call |
| Infrastructure overhead excl. inference, p95 < 25 ms | 59 ms                     | **Exceeded**                                   |

The floor alone, a Node process that does nothing, is three times the
deterministic budget. No amount of optimizing REFLEX's code fixes that. The
budgets are reachable **inside** an engine (contract validation costs about 4
µs, see `packages/contracts/README.md`); they are not reachable end to end with
this process model. That is the evidence ADR-010 was waiting for.

Note also that one tool call runs the hook up to three times (`PreToolUse`,
`PermissionRequest`, `PostToolUse`). The first two are on the critical path
before the tool runs.

### Where REFLEX's own ~17 ms go

| Added on top of an empty process                               | p50       |
| -------------------------------------------------------------- | --------- |
| Node built-ins that `rfx` imports statically                   | +5.1 ms   |
| `@reflex/telemetry` and the adapter's hook entry (~15 modules) | +8.5 ms   |
| The settings editor (`jsonc-parser`), **avoided** on this path | (+7.6 ms) |
| Reading stdin, translating, writing one record                 | ~3 ms     |

An event the hook ignores costs almost as much as one it records: the cost is
loading modules, not doing work.

### What was tried and did not help

- **Node's compile cache** (`NODE_COMPILE_CACHE`): 44.9 ms to 44.3 ms. The
  modules are tiny, so compiling them is not the cost; resolving and linking
  many small ES modules is.
- **A dedicated entry point for the hook**, without the built-ins that only the
  human-facing commands use: 43.7 ms to 42.0 ms. Inside the noise, and it
  duplicated logic, so it was reverted.

What would help is removing the per-call process (a resident daemon with a
minimal client) or the per-call module graph (one bundled file, or a compiled
binary). Both are ADR-010's decision, not an optimization to slip in here.

`rfx status` also reports the time measured from inside the hook process. That
number excludes process start, so it is a lower bound on what the host waits.

## 5. Where these facts come from

| Fact                                                        | Source                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Envelope fields, output contract, exit codes, configuration | Official Claude Code hooks reference and settings reference, 2.1.x                                                                                                                                                                                       |
| `tool_input` field names                                    | `sdk-tools.d.ts` shipped inside `@anthropic-ai/claude-code` 2.1.276, and the schema canary (RFX-124, `live/check-host-schema.mjs`, daily in CI against the latest release on npm; 2.1.282 and 2.1.283 checked identical for the tools the adapter reads) |
| The six event names exist in this version                   | Checked against the installed 2.1.276 binary, with a made-up name as a control                                                                                                                                                                           |
| Latency                                                     | Measured, this document                                                                                                                                                                                                                                  |
| Host behavior on hook failure                               | **Verified live** on 2.1.276, headless (RFX-087, §3). Two rows remain documentation only and say so                                                                                                                                                      |
| Real payload shapes                                         | **Captured live** on 2.1.276, headless: `Bash` (RFX-087); `Write`, `Read`, `Edit`, `WebFetch`, `ToolSearch` and an MCP tool (RFX-089, `docs/canonical-action-review.md`). `MultiEdit`, `NotebookEdit` and `PermissionDenied` have not been seen          |

**The schema canary (RFX-124).** The host releases several times a week,
outside REFLEX's cycle. `packages/adapter-claude-code/src/host-schema.ts`
lists the top-level fields the adapter reads from each built-in tool's input
(`Bash.command`, `Read/Write/Edit.file_path`, `NotebookEdit.notebook_path`,
`WebFetch.url`) and the interface each is declared under; a test holds that
list to what `translate.ts` actually reads. `live/check-host-schema.mjs`
fetches a release's declarations (`npm pack`, no login, no cost) and fails
when an interface the adapter relies on is gone, when a field it reads is no
longer top-level, or when a recorded fixture carries a field the release
does not declare. `.github/workflows/host-schema.yml` runs it daily against
the latest release, on demand, and on a pull request that changes what the
adapter reads. What it cannot see: the hook envelope is not declared in that
file; at run time a payload the adapter does not recognize is a typed failure
(`readHookInput`: `not-json`, `missing-event-name`, `invalid-tool-event`; an
unknown event is `ignored`), never a guess, and in Assist or Autopilot the
hook then answers as the failure mode says (§2b). `MultiEdit` is declared by
no checked release; the adapter keeps its entry for hosts that still have it.

A documentation summary consulted while building the adapter gave wrong field
names for `Write` and `Edit` (`file_text`, `old_text`). The shipped type
declarations contradicted it, were taken as authoritative, and the live host has
since confirmed them (RFX-089). The adapter is built so that this class of error
cannot hurt: inside `tool_input` it reads three argument names (`command`,
`file_path` or `notebook_path`, `url`) and only to copy them into `operands`,
where a missing one satisfies no allow rule (ADR-011); it tolerates envelope
fields it does not know, and returns a typed failure for an envelope it cannot
use.
