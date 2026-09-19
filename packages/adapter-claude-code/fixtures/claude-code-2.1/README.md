# Claude Code 2.1 hook payload fixtures

What Claude Code writes to a hook's stdin, one file per event.

## Provenance

Two kinds of file live here, and the difference matters.

### Captured from a live host

Sent by Claude Code 2.1.276 during the RFX-087 runs
(`../../live/verify-hook-failures.mjs`, headless, 2026-09-19):

| File                              | Live case                   |
| --------------------------------- | --------------------------- |
| `pre-tool-use.bash.json`          | `silent-exit-0`             |
| `post-tool-use.bash.json`         | `silent-exit-0`             |
| `permission-request.bash.json`    | `needs-permission-headless` |
| `pre-tool-use.bash-failing.json`  | `failing-command`           |
| `post-tool-use-failure.bash.json` | `failing-command`           |
| `stop.json`                       | `silent-exit-0`             |

Every field and every value is the host's, except:

- identifiers (`session_id`, `prompt_id`, `tool_use_id`) are replaced by fixed
  placeholders, so that events about one call still share theirs;
- the scratch directory is `/work/project` and the home directory `/home/dev`.

What they established, against what had been assumed: `PermissionRequest`
carries **no `tool_use_id`**; `PostToolUse` carries `tool_response` and
`duration_ms`; `PostToolUseFailure` carries `error` and `is_interrupt`; `Stop`
carries `last_assistant_message`. See `docs/claude-code-hook.md` §3.

### Constructed

`pre-tool-use.write.json`, `pre-tool-use.edit.json`, `pre-tool-use.mcp.json`,
`pre-tool-use.bash-remove.json` and `permission-denied.bash.json` have not been
seen live.

- Their **envelope** copies the live one above, field for field.
- Their **`tool_input`** follows `sdk-tools.d.ts` as shipped inside
  `@anthropic-ai/claude-code` 2.1.276 (`BashInput`, `FileWriteInput`,
  `FileEditInput`). A documentation summary consulted while building this
  adapter gave different field names for `Write` and `Edit` (`file_text`,
  `old_text`); the shipped type declarations were taken as authoritative.
- **`PermissionDenied`** was never fired by the host in any live case. Its
  envelope is a guess from the documentation.

The adapter is written so that this uncertainty cannot hurt: it never reads
inside `tool_input`, tolerates envelope fields it does not know, and returns a
typed failure for an envelope it cannot use.

RFX-089 replaces or confirms the constructed files with payloads observed in
real use, and RFX-124 adds a canary that fails when a new host release drifts
from them.
