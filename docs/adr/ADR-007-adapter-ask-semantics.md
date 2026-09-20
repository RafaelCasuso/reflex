# ADR-007: Adapter ASK semantics

- **Status:** Accepted
- **Date:** 2026-09-20
- **Tickets:** RFX-117, RFX-043, RFX-046, RFX-049, RFX-074
- **Supersedes:** none

## Context

`CLAUDE.md` principle 4: `ASK` means "let the host agent use its native
approval flow". Adapters must not build their own dialogs where the host has a
permission system, and must map the canonical decision safely onto what the
host can express.

Hosts differ, and one of them has now been measured (RFX-087, Claude Code
2.1.276, headless):

- a `PreToolUse` answer of `deny`, and exit code 2, block the call;
- a `PreToolUse` answer of `ask` **where nobody can answer is a refusal**, and
  no `PermissionRequest` event follows;
- a hook that says nothing leaves the host's own flow untouched;
- a hook that fails in any other way lets the call run.

## Decision

Accepted by the maintainer on 2026-09-20, as recommended when it was proposed.

### 1. Capability matrix

"Verified" means observed against a live host and recorded in the repository.
Everything else is from the host's documentation and is verified by the ticket
named.

| Host        | `allow`                                                      | `ask`                                                                 | `deny`                                                            | Observe                            |
| ----------- | ------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| Claude Code | `PreToolUse` answers `permissionDecision: "allow"` (RFX-043) | `PreToolUse` answers `permissionDecision: "ask"` (headless: verified) | `PreToolUse` answers `permissionDecision: "deny"` (verified)      | the hook emits nothing (verified)  |
| Codex       | `PermissionRequest` approves the request (RFX-049)           | the hook abstains and Codex shows its own prompt (RFX-049)            | `PreToolUse` blocks (RFX-048)                                     | the hook emits nothing (RFX-051)   |
| MCP proxy   | the call is forwarded (RFX-074)                              | no native prompt exists: see section 2 (RFX-074)                      | a structured error is returned and nothing is forwarded (RFX-074) | the call is forwarded and recorded |

Rules that hold for every host:

- The answer goes through the host's structured channel, with a one-line
  reason and no argument value. Exit codes are not used to answer: exit 2
  blocks and carries no reason, and any other non-zero code is read as "carry
  on".
- An adapter never turns an effect into a more lenient one. Where a host
  cannot express an effect, the adapter uses the next more restrictive one it
  can express.
- An adapter never builds its own approval dialog for a host that has one.

### 2. When the host cannot ask

Headless runs, CI, and hosts with no approval primitive at all. `ask` then
becomes a **refusal**: the action does not run, and the reason says that
approval was required and nobody was there to give it. It never becomes
`allow`.

Claude Code already behaves this way by itself in headless mode, so the
adapter does nothing special there. For MCP the proxy implements it: the
refusal is a structured tool error that tells the agent the call needs human
approval. If the MCP client supports elicitation, the proxy may use it as the
native prompt; that is for RFX-074 to verify, not assumed here.

The decision record keeps `effectiveEffect: "ask"`. That the host could not ask
is a fact about the outcome (ADR-013: `prompted: "no"`, `executed: "no"`), not a
different decision.

### 3. How Assist maps

Assist follows ADR-002 on every host: `allow` removes the prompt, `ask` and
`deny` both request the native approval. Assist therefore never blocks where a
human can answer, and refuses where nobody can, exactly like `ask`.

An adapter in Assist may add prompts that the host alone would not have shown,
when the user's host settings pre-approve something REFLEX judges risky. That
is intended: removing safe prompts and adding the missing risky one are the
same product.

## Consequences

### Positive

- One sentence covers every host: the most lenient expressible effect that is
  not more lenient than the decision.
- Headless pipelines are safe by default with no configuration.
- The matrix says which cells are verified. RFX-124 (the canary) keeps them so.

### Negative

- In CI, anything that is not explicitly allowed by policy stops the pipeline.
  A team that wants unattended autonomy has to write the allow rules. That is
  the product working as designed, and it will be the first support question.
- MCP has no prompt, so `ask` degrades to a refusal there for most clients.
- Assist can add a prompt the user did not have before. Someone will read that
  as REFLEX adding friction.

### Follow-ups

- RFX-043, RFX-046: Claude Code mapper and Assist.
- RFX-048, RFX-049, RFX-051: Codex. RFX-074: MCP.
- RFX-125: the override path for a `deny` in Autopilot.

## Alternatives considered

- **`ask` becomes `allow` when nobody can answer.** Rejected: it turns "I am not
  sure" into "yes" exactly where no human is watching.
- **A REFLEX-owned approval channel** (a notification, a web page) for headless
  runs. Out of scope by `CLAUDE.md` ("custom approval chat UI for supported
  hosts"), and a second approval system to secure.
- **Answer with exit codes.** Simpler clients, no reason shown, and one typo
  away from "carry on".
- **Assist stays silent on `ask`** and lets the host's settings decide. Then a
  broad host allowlist silently defeats REFLEX in the mode most users will run.

## Enforcement

- Adapter fixture tests per cell of the matrix: canonical decision in, host
  answer out (RFX-043, RFX-049, RFX-074).
- A property test per adapter: for every decision and mode, the expressed
  effect is never more lenient than `effectiveEffect`.
- `live/verify-hook-failures.mjs` and its checked-in record hold the verified
  cells for Claude Code; RFX-124 re-runs them on new host versions.

## References

- `CLAUDE.md`: principle 4, "Product modes", "Scope control"
- `docs/architecture.md`: §7
- `docs/claude-code-hook.md` §3
- ADR-002, ADR-003, ADR-013
