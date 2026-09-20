# ADR-006: Local redaction boundary

- **Status:** Accepted
- **Date:** 2026-09-20
- **Tickets:** RFX-116, RFX-031, RFX-033, RFX-060, RFX-123
- **Supersedes:** none

## Context

`CLAUDE.md`: redact secrets locally, before deterministic policy in the listed
order; never log raw tool arguments before redaction; never pass more context
to the provider than a test proves necessary. `docs/architecture.md` §10 lists
what is never persisted.

The listed order hides a contradiction. A rule such as "deny a command that
carries an AWS secret key" has to see the key. If redaction runs first, the
rule matches a placeholder and can never fire.

ADR-010 moves the decision onto the user's machine. "Local" now has a precise
meaning: the hook client and the daemon, same machine, same user. Since G1.5
the observation log holds the shape of the arguments only (keys, types, sizes),
because no redactor exists yet.

Approval Learning (G12) needs to see that the same thing was approved again
without seeing what it was.

## Decision

Accepted by the maintainer on 2026-09-20, as recommended when it was proposed:
**raw values exist in memory on the user's
machine and nowhere else.**

### 1. What is redacted where

| Place                    | Does                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter, hook client     | Nothing. Passes the action to the local daemon over the local socket, by value, and never logs it                                       |
| Local daemon             | Owns redaction (`packages/context-compiler`). Everything that is written to disk or sent anywhere goes through it first                 |
| Remote gateway, provider | Receives redacted, minimal context only. Runs the same redactor again as a second line; a hit there is counted as a defect of the first |
| Control plane, dashboard | Never sees a raw value. There is no code path that could send one                                                                       |

### 2. Policy is matched on the raw action

The decision order in `CLAUDE.md` stays as written: the action is normalized,
then redacted, then evaluated. What this ADR fixes is what each stage reads.
Redaction produces a **redacted view** next to the raw action; it does not
destroy the original. Every stage that writes or sends anything reads the
redacted view. **The policy matcher alone reads the raw action**, in the
daemon's memory.

That is the only way a rule about a secret can match. It is safe because
evaluation is local and pure, and because nothing it produces contains a value:
a `PolicyMatch` is rule IDs, effects and numbers.

The redacted view may be computed lazily, when something first needs it, so
that an action policy resolves and nobody records does not pay for a scan. The
observable behavior is the same: nothing unredacted is ever written or sent.

This is a reading of `CLAUDE.md` principle 2, not a change to it. It still
needs the maintainer's explicit agreement, because the principle can also be
read as "policy sees redacted text".

### 3. What may be written locally before redaction

Nothing derived from a value. Until the redactor exists (RFX-031) the local log
keeps what it keeps today: the shape of the arguments. Once it exists, redacted
arguments may be stored locally, subject to retention (ADR-008).

Never, redacted or not: environment variables, authorization headers, tool
output, transcripts, the user's conversation.

### 4. Redacted values keep a keyed fingerprint

A redacted value is replaced by `[REDACTED:<kind>:<fingerprint>]`. The
fingerprint is the first 8 hexadecimal digits of an HMAC-SHA-256 of the value
under a key that is generated at install, stored in `~/.reflex` with mode 0600
and never leaves the machine.

- The same secret gives the same placeholder on the same installation, so
  repeated approvals can be clustered and a provider can tell two values apart.
- Without the key the fingerprint cannot be confirmed by guessing, which a
  plain hash of a short value can. That is why the observation log refuses even
  a hash today.
- Fingerprints do not match across machines. Clustering across a team has to
  work on normalized operands (ADR-011), not on secret values.

## Consequences

### Positive

- A policy can be written about secrets, and the arguments of an action that
  policy resolves never leave the machine, which is most actions.
- One redactor, one owner, one adversarial corpus (RFX-035).
- Approval Learning gets repetition without content.

### Negative

- The daemon holds raw arguments in memory. It is a local process of the same
  user that ran the command, so this discloses nothing new, and it makes the
  daemon's socket and its crash dumps sensitive.
- Two views of one action are one more thing to get wrong: a stage that reads
  the raw one by mistake leaks. Types have to make that impossible (below).
- A key to protect and to delete on `rfx uninstall --purge`. Losing it only
  breaks clustering continuity.
- Redaction is best effort by nature. The second pass at the gateway is there
  because the first one will miss something one day.

### Follow-ups

- RFX-031 implements the redactor and the fingerprint; RFX-035 attacks it.
- RFX-123 asks for consent before any action content leaves the machine.
- `rfx uninstall --purge` removes the key with the rest of `~/.reflex`.

## Alternatives considered

- **Policy sees only redacted text.** The other reading of `CLAUDE.md`. It makes
  every rule about a secret impossible.
- **Match twice, on raw and on redacted.** Two semantics for one rule.
- **Plain SHA-256 of the value.** Guessable for short or structured secrets.
- **No fingerprint at all.** Safest, and Approval Learning cannot tell "the same
  token again" from "a different token every time", which are opposite signals.
- **Redact in the adapter.** Every adapter would carry a redactor, and the
  policy engine would never see a raw value.

## Enforcement

- The G3 gate exit already requires that no telemetry field contains an
  argument value; RFX-023 tests it with a canary value through the whole
  pipeline.
- `packages/telemetry` tests already hold that the local log contains no value,
  no hash of one and no token-shaped key.
- RFX-035: the redaction corpus runs at both passes; a hit at the second pass
  fails CI.
- A test that a `PolicyMatch` and a `PolicyEvaluation` serialize to nothing
  derived from the action's arguments.
- The raw action and the redacted view are different types. Telemetry, the
  context compiler and every transport accept only the redacted one, so reading
  the wrong view is a compile error and not a review comment.

## References

- `CLAUDE.md`: principle 2, principle 9, "Coding conventions"
- `docs/architecture.md`: §3, §10
- ADR-008, ADR-010, ADR-011
- `packages/telemetry/src/argument-shape.ts`
