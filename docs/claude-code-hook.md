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

## 3. What the host does when the hook fails (RFX-087)

**Status: documented, not yet verified against a live host.** The table is
taken from the official hooks reference for Claude Code 2.1.x, consulted on
2026-09-19. RFX-087 asks for every row to be backed by a fixture test against
the real host; that needs running Claude Code, which spends the maintainer's
quota, and is pending their go-ahead (procedure below).

| The hook…                                   | Claude Code…                                                                                                              | Fail-open? |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------- |
| exits 0 and prints nothing                  | continues with its normal permission flow                                                                                 | by design  |
| exits 2                                     | blocks the call on `PreToolUse`; ignores it on `PermissionRequest`; on `PostToolUse` only shows stderr (the tool has run) | no         |
| exits with any other non-zero code          | treats it as a non-blocking error: the call proceeds, the user sees an error notice                                       | **yes**    |
| exits 0 and prints invalid JSON             | treats it as a non-blocking error: the call proceeds                                                                      | **yes**    |
| exceeds its timeout                         | does not block: the call continues through the normal permission flow                                                     | **yes**    |
| command is missing (`rfx` moved or removed) | treats it as a non-blocking error: the call proceeds                                                                      | **yes**    |
| was removed from the settings file          | never runs it                                                                                                             | **yes**    |
| is switched off by `disableAllHooks`        | never runs it (managed hooks aside)                                                                                       | **yes**    |
| is excluded by `allowManagedHooksOnly`      | never runs it                                                                                                             | **yes**    |

### What this means

In Observe every fail-open row is harmless, and is in fact the desired
behavior: an observer must not be able to hurt its host.

From Assist on, each of those rows is a way for REFLEX to **silently disappear
from the execution path**, which `CLAUDE.md` principle 5 forbids. The host will
not close them for us: apart from exit code 2, Claude Code fails open on
everything. They have to be closed or made loud on REFLEX's side:

| Fail-open path                        | Closed or surfaced by                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| hook removed, disabled or excluded    | `rfx status` already re-reads the file and reports `HOOK MISSING` / `DISABLED`; RFX-103 adds self-protection   |
| command missing after an upgrade/move | `rfx init` is self-healing and re-points the hook; RFX-055 (`rfx doctor`) should check the path                |
| crash, invalid output                 | the enforcing hook must catch everything and answer explicitly (`ask` or `deny`) per ADR-003; never exit non-2 |
| timeout                               | the enforcing hook needs its own deadline, shorter than the host's, and must answer before it (RFX-022)        |
| a local daemon that is down           | ADR-010 must define what the hook answers when it cannot reach it                                              |
| host schema drift                     | RFX-124 (canary)                                                                                               |

One more consequence: an enforcing hook that wants `deny` on failure must
produce it **itself**, quickly and reliably. "Fail closed" cannot rely on the
host, because the host's reading of a broken hook is "carry on".

### Live verification procedure

In a scratch directory, install a hook that misbehaves in one specific way
(exit 1, exit 2, sleep past the timeout, print `{`, point at a missing file),
run `claude -p "Run: touch marker"` with `Bash` allowed, and record whether
`marker` exists and what the transcript shows. One short headless run per row.

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

| Fact                                                        | Source                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Envelope fields, output contract, exit codes, configuration | Official Claude Code hooks reference and settings reference, 2.1.x                                            |
| `tool_input` field names                                    | `sdk-tools.d.ts` shipped inside `@anthropic-ai/claude-code` 2.1.276                                           |
| The six event names exist in this version                   | Checked against the installed 2.1.276 binary, with a made-up name as a control                                |
| Latency                                                     | Measured, this document                                                                                       |
| Host behavior on hook failure                               | Documentation only. **Not verified live.**                                                                    |
| Real payload shapes                                         | **Not captured yet** (RFX-089). Fixtures are constructed; `fixtures/claude-code-2.1/README.md` says from what |

A documentation summary consulted while building the adapter gave wrong field
names for `Write` and `Edit` (`file_text`, `old_text`). The shipped type
declarations contradicted it and were taken as authoritative. The adapter is
built so that this class of error cannot hurt: it never reads inside
`tool_input`, tolerates envelope fields it does not know, and returns a typed
failure for an envelope it cannot use.
