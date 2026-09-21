# Claude Code 2.1 hook payload fixtures

What Claude Code writes to a hook's stdin, one file per event.

## Provenance

Two kinds of file live here, and the difference matters.

### Captured from a live host

Sent by Claude Code 2.1.276, headless, in scratch projects.

By the RFX-087 runs (`../../live/verify-hook-failures.mjs`, 2026-09-19):

| File                              | Live case                   |
| --------------------------------- | --------------------------- |
| `pre-tool-use.bash.json`          | `silent-exit-0`             |
| `post-tool-use.bash.json`         | `silent-exit-0`             |
| `permission-request.bash.json`    | `needs-permission-headless` |
| `pre-tool-use.bash-failing.json`  | `failing-command`           |
| `post-tool-use-failure.bash.json` | `failing-command`           |
| `stop.json`                       | `silent-exit-0`             |

By the RFX-089 runs (`../../live/capture-tool-payloads.mjs`, 2026-09-21), which
are recorded whole in `../../live/payloads/`:

| File                            | Live case  |
| ------------------------------- | ---------- |
| `pre-tool-use.write.json`       | `write`    |
| `post-tool-use.write.json`      | `write`    |
| `pre-tool-use.read.json`        | `edit`     |
| `pre-tool-use.edit.json`        | `edit`     |
| `post-tool-use.edit.json`       | `edit`     |
| `pre-tool-use.tool-search.json` | `mcp`      |
| `pre-tool-use.mcp.json`         | `mcp`      |
| `post-tool-use.mcp.json`        | `mcp`      |
| `pre-tool-use.web-fetch.json`   | `webfetch` |

Every field and every value is the host's, except:

- identifiers (`session_id`, `prompt_id`, `tool_use_id`) are replaced by fixed
  placeholders, so that events about one call still share theirs;
- the scratch directory is `/work/project` and the home directory `/home/dev`.

What they established, against what had been assumed:

- `PermissionRequest` carries **no `tool_use_id`**; `PostToolUse` carries
  `tool_response` and `duration_ms`; `PostToolUseFailure` carries `error` and
  `is_interrupt`; `Stop` carries `last_assistant_message` (RFX-087, see
  `docs/claude-code-hook.md` §3).
- An MCP tool event carries **`mcp_server`, an object** with `name` and
  `source`. The host calls **`ToolSearch`** before the first use of a deferred
  tool. A `PostToolUse` for `Edit` carries the **whole original file** in
  `tool_response`. The `tool_input` names of `Write`, `Read`, `Edit` and
  `WebFetch` are the ones in the shipped type declarations (RFX-089, see
  `docs/canonical-action-review.md`).

### Constructed

`pre-tool-use.bash-remove.json` and `permission-denied.bash.json` have not been
seen live.

- `pre-tool-use.bash-remove.json` is the live `Bash` payload with another
  command. It exists so that a destructive command has a fixture, and no live
  run was going to execute one.
- **`PermissionDenied`** was never fired by the host in any live case. Its
  envelope is a guess from the documentation.
- `MultiEdit` and `NotebookEdit` have no fixture. The argument names the adapter
  reads for them (`file_path`, `notebook_path`) come from `sdk-tools.d.ts` as
  shipped inside `@anthropic-ai/claude-code` 2.1.276.

A documentation summary consulted while building this adapter gave different
field names for `Write` and `Edit` (`file_text`, `old_text`); the shipped type
declarations contradicted it, were taken as authoritative, and the live host has
since confirmed them.

The adapter is written so that this kind of uncertainty cannot hurt. Inside
`tool_input` it reads three argument names and nothing else, and only to copy
them into `operands` (ADR-011): if the host renames one, the operand is absent,
and an absent operand satisfies no allow rule. It tolerates envelope fields it
does not know, and returns a typed failure for an envelope it cannot use.

RFX-124 adds a canary that fails when a new host release drifts from these
files.
