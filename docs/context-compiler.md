# The context compiler and the redaction boundary

`packages/context-compiler` is where a raw action, in the daemon's memory,
becomes the least a provider can be given: the fields
`SemanticDecisionRequest` selects by name, redacted (ADR-006), with the
relevant history and the policy hints, under the token budget (`CLAUDE.md`
principle 9). It is the only path from a raw action to something that
leaves the process, and it has no path that skips the redactor. This page
is what it does (G5) and what it measured.

## 1. What is made of

| Piece                               | Where                                                      | Ticket           |
| ----------------------------------- | ---------------------------------------------------------- | ---------------- |
| The secret shapes                   | `src/patterns.ts`                                          | RFX-031          |
| The redactor and the redacted view  | `src/redact.ts`                                            | RFX-031          |
| Golden and adversarial corpora      | `corpus/`                                                  | RFX-031, RFX-035 |
| Relevant history and session memory | `src/history.ts`                                           | RFX-032          |
| The token budget                    | `src/token-budget.ts`                                      | RFX-034          |
| The compiler                        | `src/compile.ts`                                           | RFX-033          |
| The installation's key              | `apps/decision-gateway/src/orchestration/redaction-key.ts` | RFX-031          |

## 2. Redaction

**Shapes, not entropy.** A detector that fires on any random-looking string
redacts commit hashes and file names and teaches nothing. The redactor
knows fifteen kinds, each a family of credentials with a recognizable
prefix or a recognizable frame:

`aws-access-key`, `aws-secret-key`, `github-token`, `slack-token`,
`stripe-key`, `google-api-key`, `openai-key`, `anthropic-key`,
`typesafe-key`, `jwt`, `private-key`, `authorization-header`,
`url-credentials`, `assignment` (a name with `password`, `secret`, `token`,
`api_key` or the like in it, followed by a value), and `encoded`.

**What a value becomes.** `[REDACTED:<kind>:<fingerprint>]`, where the
fingerprint is the first 8 hexadecimal digits of an HMAC-SHA-256 of the
value under the installation's key (ADR-006 §4). The frame stays: a reader
of `curl -H 'Authorization: Bearer [REDACTED:github-token:3f9a1c20]'` still
knows what was there. The same secret gives the same placeholder on the
same machine; another installation gives another; nothing can be confirmed
by guessing without the key. A placeholder never reads as a secret to a
second pass, and a second pass skips placeholders it finds.

**Encoded text is decoded and scanned.** A base64 run or a percent-encoded
run that decodes to a secret is replaced whole, as kind `encoded`, two
levels deep. A string too large to scan on the hot path (256 KiB) is
replaced whole rather than sent.

**The redacted view is a type.** `redactAction` returns a `RedactedAction`,
branded and without `id`, `agent`, `cwd`, `sessionId` or
`adapterMetadata`; the compiler builds the provider's request from it and
from nothing else, so a stage that reads the raw view is a compile error,
as ADR-006's enforcement asks.

**The key.** `<REFLEX_HOME>/redaction.key`, 32 random bytes, mode 0600 in a
directory of mode 0700, created by the daemon on its first start and read
on every later one; `GET /v1/health` says whether it was created or found.
A key of the wrong size is refused, not replaced: replacing it would
silently break the continuity of every fingerprint. `rfx uninstall --purge`
removes it.

### The corpora

No secret-shaped literal exists in the repository. Every case names a kind
and a template; the secret is generated at test time from the kind's shape
with a seeded generator, so that the Security gate's allowlist stays as
narrow as it is (`corpus/README.md`).

- **Golden** (RFX-031): 23 cases, at least one per kind, each in the frame a
  developer meets it: an environment line, a header, a URL, a JSON member, a
  shell command, a file. Three seeds each. The raw secret survives in none.
- **Adversarial** (RFX-035): 14 cases: base64 and double base64, percent
  encoding, JSON-string escaping, single and double quoting, YAML, Python,
  Markdown, a here-document writing `.env`, a data URL, and a secret split
  across a shell line continuation. Zero raw known secrets survive; for the
  encoded cases the encoded run is gone too, not only the decoded value.
  The split case is counted, not hidden: no single-string redactor catches
  a secret that no single string holds, and the case says so.

## 3. History

`selectRelevantHistory` keeps, from a session's history, the most recent
items (3) and the ones about the same tool, the same MCP server or the same
resource, within a window (30 minutes) and a bound (8), newest last; a
session that runs for a day costs what one that runs for a minute costs,
held by a test over five thousand entries. What the provider gets is the
contract's `PriorActionSummary`: tool, operation, effect, time; no resource,
no namespace. `SessionMemory` is the bounded, in-memory store the daemon
will keep (RFX-141): 200 entries per session, 1,000 sessions, six hours.

## 4. The budget

`CLAUDE.md` principle 9: median semantic input under 600 tokens. The budget
governs the state the provider is given; the questions are the provider
package's own fixed cost (about 912 tokens as the named tokenizer counts,
1,400 as the provider does).

**Estimate.** Bytes divided by four, rounded up. Conservative on purpose:
against the named tokenizer over the seed corpus it is never under by more
than a tenth and never over by more than half, held by a test.

**Order of cuts,** and only when over budget, stopping as soon as it holds:
policy hints, prior actions, the task summary (to 200 characters), the
objective (to 200), the tool's description, then argument values (to 120
characters each, marked `…[truncated]`). **Never cut:** the tool, the
operation, the side-effect class, the resource, and argument keys.

### What was measured

The named tokenizer is `gpt-tokenizer` 4.0.0, encoding o200k_base, a
development dependency used by the tests and never by the daemon. The
provider counts with its own: on the request RFX-107 recorded, TypeSafe
reported 1,669 input tokens where o200k counts 1,148, a ratio of 1.45; both
numbers are reported and the budget is held on the stricter one.

| Input                                                                         | o200k tokens | as the provider counts |
| ----------------------------------------------------------------------------- | -----------: | ---------------------: |
| seed corpus, 79 actions, median compiled state                                |           51 |                     74 |
| seed corpus, p95                                                              |           70 |                    102 |
| seed corpus, max                                                              |           76 |                    110 |
| the RFX-107 "typical" state (objective, summary, environment, history, hints) |          222 |                    322 |

The seed corpus is commands and file edits with no objective or summary,
which is what the adapter sends today; with them, the RFX-107 state is the
better picture, and it is under the budget by a factor of two. Measured by
`src/budget-measurement.test.ts`, which runs in CI and prints its numbers.

## 5. What the compiler leaves out, on purpose

- The working directory, the identifiers, the agent's identity, the
  adapter's metadata: they are not in `SemanticDecisionRequest` (ADR-001
  §3) and the redacted view does not carry them.
- The repository's root: a path on this machine. The branch and the remote
  host are what say which project this is.
- Policy hints are redacted like everything else: a rule about a specific
  secret names it.

## 6. What this gate does not claim

- The daemon creates the key and holds the compiler, but no semantic stage
  runs yet: the compiler reaches a provider in RFX-141 (R0), once an
  aggregator exists (G6).
- Redaction is best effort by nature (ADR-006). The second pass at the
  gateway, where a hit counts as a defect of the first, is G10's work.
- The history selector is exercised by tests only; the daemon does not
  keep a `SessionMemory` until RFX-141.
