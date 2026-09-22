# Architecture Decision Records

An ADR records one architecturally significant decision: the forces at play,
what was decided, and what it costs. ADRs are how REFLEX changes its mind on
purpose instead of by drift.

`CLAUDE.md` is the engineering operating system and outranks tickets. An ADR
cannot silently override it: if a decision requires changing `CLAUDE.md`, the
ADR says so explicitly and the same change updates `CLAUDE.md`.

## Index

| ADR                                                              | Title                                                      | Status   | Date       | Tickets |
| ---------------------------------------------------------------- | ---------------------------------------------------------- | -------- | ---------- | ------- |
| [ADR-001](./ADR-001-canonical-action-model.md)                   | Canonical action model                                     | Accepted | 2026-09-18 | RFX-005 |
| [ADR-002](./ADR-002-decision-precedence-and-effective-effect.md) | Decision precedence and effective effect                   | Accepted | 2026-09-20 | RFX-112 |
| [ADR-003](./ADR-003-fail-behavior.md)                            | Fail behavior                                              | Accepted | 2026-09-20 | RFX-113 |
| [ADR-004](./ADR-004-policy-precedence.md)                        | Policy precedence                                          | Accepted | 2026-09-20 | RFX-114 |
| [ADR-005](./ADR-005-provider-abstraction.md)                     | Provider abstraction                                       | Accepted | 2026-09-20 | RFX-115 |
| [ADR-006](./ADR-006-local-redaction-boundary.md)                 | Local redaction boundary                                   | Accepted | 2026-09-20 | RFX-116 |
| [ADR-007](./ADR-007-adapter-ask-semantics.md)                    | Adapter ASK semantics                                      | Accepted | 2026-09-20 | RFX-117 |
| [ADR-008](./ADR-008-telemetry-persistence-strategy.md)           | Telemetry persistence strategy                             | Accepted | 2026-09-20 | RFX-118 |
| [ADR-009](./ADR-009-contract-versioning.md)                      | Contract versioning and compatibility                      | Accepted | 2026-09-18 | RFX-011 |
| [ADR-010](./ADR-010-decision-placement-and-hook-latency.md)      | Decision placement and hook latency                        | Accepted | 2026-09-20 | RFX-094 |
| [ADR-011](./ADR-011-normalized-operands-and-classification.md)   | Normalized operands and classification ownership           | Accepted | 2026-09-20 | RFX-095 |
| [ADR-012](./ADR-012-self-protection-and-workspace-trust.md)      | Self-protection and workspace trust                        | Accepted | 2026-09-20 | RFX-102 |
| [ADR-013](./ADR-013-action-outcome-observation.md)               | Action outcome observation                                 | Accepted | 2026-09-19 | RFX-091 |
| [ADR-015](./ADR-015-open-core-boundary.md)                       | Open core boundary                                         | Proposed | 2026-09-22 | RFX-139 |
| [ADR-016](./ADR-016-decision-model-providers-and-shadow-mode.md) | Decision model providers, shadow mode and decision records | Proposed | 2026-09-22 | RFX-140 |

## When an ADR is required

Write one before merging a change that touches any of:

- product semantics: the meaning of `allow` / `ask` / `deny`, or of the
  `observe` / `assist` / `autopilot` modes
- decision precedence or policy precedence
- safety fallback behavior (`fail-open` / `fail-ask` / `fail-closed`)
- package boundaries or the allowed dependency direction
- a breaking change to a canonical contract in `packages/contracts`
- what may cross a trust boundary unredacted
- introducing infrastructure that `CLAUDE.md` defers until a measured
  constraint requires it

Routine implementation choices inside one package do not need an ADR.

## Process

1. Copy [`ADR-000-template.md`](./ADR-000-template.md) to
   `ADR-NNN-short-kebab-title.md`, using the next free number. Numbers are
   never reused.
2. Fill it in with status `Proposed` and reference the ticket.
3. Review it like code. On acceptance, set the status to `Accepted`.
4. Add it to the index above in the same change.
   `tests/adr.test.ts` fails if an ADR is missing from the index, if the
   index status disagrees with the file, or if a required section is absent.

## Statuses

| Status                  | Meaning                                        |
| ----------------------- | ---------------------------------------------- |
| `Proposed`              | Under review. Not binding.                     |
| `Accepted`              | Binding. Code and tickets must conform.        |
| `Rejected`              | Considered and declined. Kept for the record.  |
| `Deprecated`            | No longer relevant. Nothing replaces it.       |
| `Superseded by ADR-NNN` | Replaced. The newer ADR is the one that binds. |

## Immutability

An accepted ADR is not rewritten. To change a decision, write a new ADR that
supersedes it and update only the old ADR's status line. Fixing typos and
broken links is fine; changing meaning is not.
