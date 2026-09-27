# Codex hook payload fixtures, from the documentation

What Codex writes to a hook's stdin, one file per event, **composed from the
host's documentation** ("Hooks", learn.chatgpt.com/docs/hooks, read on
2026-09-27), not captured from a live host.

## Provenance

The field names and their placement are the documentation's: `session_id`,
`transcript_path` (nullable), `cwd`, `hook_event_name`, `model`,
`permission_mode`, `turn_id`; for tool events `tool_name`, `tool_input`,
`tool_use_id` (absent on `PermissionRequest`) and `tool_response`
(`PostToolUse` only). Tool names are the documented ones: `Bash`,
`apply_patch` (its patch in `tool_input.command`), `mcp__<server>__<tool>`,
and other local function tools by name (`update_plan`).

Every value is made up and harmless: a session id in the UUID form the
documentation implies, a `call_000N` tool-use id, a model slug, a marker file.
The shape of `tool_response` is not documented and is a guess this adapter
does not read.

## What is not here

Nothing captured live. The Codex installed where these were written (0.101.0)
predates hooks. When a maintainer runs a newer Codex with `features.hooks`
on and REFLEX's hook installed, the payloads it writes belong in a sibling
directory named after that version, and `docs/codex-hook.md` §5 says what
changed. Until then, `docs/codex-hook.md` marks every row that rests on these
files as documentation only.
