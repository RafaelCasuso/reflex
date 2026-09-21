# The canonical action model against real payloads

ADR-001 fixed the canonical action model before a single real payload had been
seen. This is the review RFX-089 asks for: what the host really sends, which
canonical fields nobody fills, which host data has no canonical home, and what
is worth promoting under ADR-001 §3.7.

## What was observed

Claude Code 2.1.276, headless, in scratch projects whose only hook writes down
what it is given:

| Tool                    | Captured by                                            | Record                                        |
| ----------------------- | ------------------------------------------------------ | --------------------------------------------- |
| `Bash`, run and failing | `live/verify-hook-failures.mjs` (RFX-087)              | `packages/adapter-claude-code/live/results/`  |
| `Write`, `Read`, `Edit` | `live/capture-tool-payloads.mjs` (RFX-089)             | `packages/adapter-claude-code/live/payloads/` |
| an MCP tool, `WebFetch` | the same; the MCP server is forty lines of that script | the same                                      |

Whether each tool really ran was read from the disk, not from the model.
`packages/adapter-claude-code/src/live-payloads.test.ts` holds this page and
the adapter to the record in CI.

**Not observed:** a human answering a prompt in the terminal (every run was
headless), `MultiEdit` and `NotebookEdit` (their field names come from the type
declarations shipped with the host), and any host other than Claude Code.

## 1. The envelope the host sends

Every tool event carries `session_id`, `transcript_path`, `cwd`, `prompt_id`,
`permission_mode`, `hook_event_name`, `tool_name`, `tool_input` and
`tool_use_id`, with one exception found in RFX-087: `PermissionRequest` has no
`tool_use_id` and carries `permission_suggestions` instead.

A completion adds `tool_response` and `duration_ms`; a failure adds `error` and
`is_interrupt`. An MCP tool adds `mcp_server`, an object with a `name` and a
`source` (`dynamic` for a server given on the command line, the only value
seen). `Stop` carries
`stop_hook_active`, `last_assistant_message`, `background_tasks` and
`session_crons`.

The arguments of each tool, as sent:

| Tool                    | `tool_input`                                           |
| ----------------------- | ------------------------------------------------------ |
| `Bash`                  | `command`, `description`                               |
| `Write`                 | `file_path`, `content`                                 |
| `Read`                  | `file_path`                                            |
| `Edit`                  | `file_path`, `old_string`, `new_string`, `replace_all` |
| `WebFetch`              | `url`, `prompt`                                        |
| `ToolSearch`            | `query`, `max_results`                                 |
| `mcp__notes__save_note` | whatever the server's schema declares                  |

These are the names the adapter copies operands from (ADR-011): `command`,
`file_path` and `url`. All three are now confirmed against the live host, and
not only against its type declarations.

## 2. Findings that changed code

1. **`mcp_server` is how the host says which server a tool belongs to, and the
   adapter was not reading it.** It split the name `mcp__<server>__<tool>`
   instead, and that does not split in one way only:
   `mcp__github__admin__delete` is the tool `admin__delete` of the server
   `github`, or the tool `delete` of the server `github__admin`. The namespace is
   exactly what an allow rule trusts, so a server could have chosen its name to
   be read as another one. The adapter now takes the namespace from
   `mcp_server`; when the name does not carry that prefix the two disagree, and
   the whole name is kept so that no rule about a tool name matches by
   accident. A statement that is there and cannot be read fails the event
   instead of falling back to the name.

   The first version of this fix read `mcp_server` as a string. It is an object,
   so the fix found nothing and split the name as before, and every
   hand-written test passed. The suite over the live record is what failed.
   That is the argument for keeping such a record for every host.

2. **A name that starts with `mcp__` and does not split cleanly used to get no
   namespace at all**, and so passed for one of the host's own tools, which is
   what an allow rule without `tool.namespace` reaches. It now always gets one.
3. **`ToolSearch` exists.** The host calls it before the first use of a
   deferred tool, which both the MCP tool and `WebFetch` were. Left as
   `unknown` it would have put a prompt before every such call. It loads a tool
   definition and touches nothing, so the adapter classes it `none`.
4. The fixtures for `Write`, `Edit` and an MCP tool were constructed. They are
   now the host's own payloads, and `Read`, `WebFetch`, `ToolSearch` and two
   completions were added.

## 3. Canonical fields nobody fills

For the Claude Code adapter today:

| Field                           | Filled | Why not, and what it would take                                                                                        |
| ------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `id`, `sessionId`               | yes    | derived by hashing the host's identifiers, so every event about one call agrees with no shared state                   |
| `agent.host`, `.hostVersion`    | yes    |                                                                                                                        |
| `agent.id`                      | no     | the local identity exists (RFX-058) and is not put on the action. It should be, once something reads it (G3)           |
| `agent.model`                   | no     | **the host does not say.** No hook payload names the model. It could only come from the transcript                     |
| `userObjective`, `taskSummary`  | no     | **the host does not say.** They are in the conversation, which the hook gets as a file path. Deriving them is G5       |
| `tool`, `arguments`, `operands` | yes    | `operands` since contract v1.2                                                                                         |
| `operation`                     | no     | nothing in the payload is an operation apart from the tool itself. For a shell command it is the classifier's segment  |
| `resource`                      | no     | the host knows nothing about environments. It has to come from configuration or from policy                            |
| `sideEffectClass`               | partly | `unknown` except where the name settles it. The engine classifies (ADR-011)                                            |
| `cwd`                           | yes    |                                                                                                                        |
| `repository`                    | no     | not sent. Root and branch can be read from `cwd`, which is I/O in a process that runs per call; a daemon can (ADR-010) |
| `priorActions`                  | no     | needs memory across calls, which a process per call does not have; a daemon does                                       |
| `adapterMetadata`               | yes    | `hookEventName`, `toolUseId`, `permissionMode`                                                                         |
| `createdAt`                     | yes    | the adapter's clock. The host sends no timestamp                                                                       |

Two of these matter for what comes next. **`userObjective` and `taskSummary`
are what the semantic stage weighs an action against**, and the host supplies
neither. How much that matters was measured in RFX-107: with the objective kept
and only the task summary, the environment and the prior actions taken away,
`unusualScope` moved from 0.27 to 0.54 of 3. And **three of the empty fields
wait for the same thing, a process that stays up**, which ADR-010 has since
decided.

## 4. Host data with no canonical home

| Host data                                               | What it is                                              | Verdict                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `prompt_id`                                             | groups the tool calls that one user prompt led to       | **candidate**, below                                                                                     |
| `duration_ms`                                           | how long the tool took                                  | **candidate**, below                                                                                     |
| `permission_mode`                                       | `default`, and the host's other modes                   | **candidate**, below. Today in `adapterMetadata`, where domain logic may not read it                     |
| `mcp_server.name`                                       | the server of an MCP tool                               | has a home already: `tool.namespace`                                                                     |
| `mcp_server.source`                                     | where the server's configuration came from              | unread. Worth a look in RFX-104: a server a repository brings with it is not one the user configured     |
| `permission_suggestions`                                | the rule the host would offer to remember               | stays in the adapter. Host-shaped, and useful to Approval Learning as a hint, never as a rule            |
| `tool_response`                                         | the tool's output: file contents, patches, fetched text | **never stored and never sent** (ADR-006, ADR-008). An `Edit` completion carries the whole original file |
| `error`, `is_interrupt`                                 | why a tool failed                                       | `error` is tool output and is not stored. That it failed is already an outcome (ADR-013)                 |
| `transcript_path`                                       | where the conversation is                               | stays unread. It is the conversation                                                                     |
| `last_assistant_message`                                | what the agent said last                                | stays unread, and a test holds that it never reaches a record                                            |
| `background_tasks`, `session_crons`, `stop_hook_active` | the host's own bookkeeping at the end of a turn         | no use found                                                                                             |
| `tool_input.description`                                | the agent's own account of a `Bash` command             | never evidence about the command: the agent writes it. It is in `arguments` and nowhere else             |

## 5. Candidates for promotion (ADR-001 §3.7)

None is made here. Each would be an additive contract change under ADR-009,
and each has a ticket that should decide it.

1. **A turn identifier**, from `prompt_id`. Outcomes are assembled by treating
   `Stop` as the end of a turn (RFX-092), and an unattributed permission prompt
   is matched to an action by order. A turn identifier on the action would make
   both exact. Other hosts would have to have one; Codex is the test (RFX-093).
2. **`durationMs` on `ActionOutcome`**, from `duration_ms`. Latency of the
   action itself, next to REFLEX's own. Cheap, and "how much time did the prompt
   cost compared with the work" is a number the product will want (RFX-081).
3. **The host's approval mode**, from `permission_mode`. Whether the host asks
   at all changes what `ask` means (ADR-007): in a mode that accepts edits
   without asking, an `allow` from REFLEX removes no prompt, and that matters to
   "approval prompts eliminated". It would need a closed, host-agnostic
   vocabulary, which is the hard part; until then it stays in
   `adapterMetadata`, unread.

And one that is rejected: **`permission_suggestions`**. It is the most tempting,
because the host has already written the rule the user would accept. It is also
host-shaped, written by the host for its own permission system, and promoting it
would put a second policy language inside the first.

## 6. Does the model hold?

Yes, with one correction already made and one gap that is not the model's.

- The exclusions of ADR-001 were right where it counts: `tool_response`,
  `last_assistant_message` and `transcript_path` are exactly the content that
  must not travel, and nothing canonical needed them.
- `tool.namespace` was the right abstraction and the wrong source. That is
  fixed.
- `operands` (ADR-011) was missing when ADR-001 was written. Its three kinds are
  the three that the observed tools need: a command, paths, a host.
- The gap is context. The host sends what the agent is about to do and nothing
  about why. The model has the fields; filling them is G5's work, and the
  semantic stage is only as good as that.
