# Integration Notes

## Claude Code

REFLEX should use Claude Code's runtime permission/hook surfaces where supported and preserve the host's native approval UI for `ASK`.

Installation principles:

- project scope by default
- backup before write
- never require blanket permission bypass
- preserve existing settings
- observe first

What is installed, what the host does when the hook fails, and what a hook call costs are documented in [`claude-code-hook.md`](./claude-code-hook.md).

## Codex

Current Codex hook behavior requires a deliberate split:

- `PreToolUse` can inspect calls and can block supported calls.
- `PermissionRequest` occurs when Codex is about to ask for approval and can allow, deny, or abstain so the native prompt continues.
- Therefore REFLEX must not pretend that `PreToolUse` alone provides a universal `ASK` operation.

Adapter mapping:

```text
REFLEX allow
  → allow through the native supported mechanism

REFLEX ask
  → abstain/defer to native approval where available

REFLEX deny
  → block/deny through supported hook output
```

All host behavior must be fixture-tested against the currently supported hook schema.
"Currently" moves without a commit: a scheduled canary compares what each
adapter reads with the latest host release and fails on drift (RFX-124 for
Claude Code, `docs/claude-code-hook.md` §5).
