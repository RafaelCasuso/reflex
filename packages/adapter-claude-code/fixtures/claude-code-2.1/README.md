# Claude Code 2.1 hook payload fixtures

What Claude Code writes to a hook's stdin, one file per event.

## Provenance

These are **constructed from documentation, not captured from a live session**.

- **Envelope fields** (`session_id`, `transcript_path`, `cwd`, `permission_mode`,
  `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`) follow the
  official hooks reference.
- **`tool_input` shapes** follow `sdk-tools.d.ts` as shipped inside
  `@anthropic-ai/claude-code` 2.1.276 (`BashInput`, `FileWriteInput`,
  `FileEditInput`). A documentation summary consulted while building this
  adapter gave different field names for `Write` and `Edit` (`file_text`,
  `old_text`); the shipped type declarations were taken as authoritative.
- **Event names** were checked against the installed 2.1.276 binary: all six
  that REFLEX subscribes to are present.

The adapter is written so that this uncertainty cannot hurt: it never reads
inside `tool_input`, tolerates envelope fields it does not know, and returns a
typed failure for an envelope it cannot use.

RFX-089 replaces or confirms these with payloads observed from a real session,
and RFX-124 adds a canary that fails when a new host release drifts from them.
