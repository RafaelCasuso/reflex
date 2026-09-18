# Architecture Decision Records

An ADR records one architecturally significant decision: the forces at play,
what was decided, and what it costs. ADRs are how REFLEX changes its mind on
purpose instead of by drift.

`CLAUDE.md` is the engineering operating system and outranks tickets. An ADR
cannot silently override it: if a decision requires changing `CLAUDE.md`, the
ADR says so explicitly and the same change updates `CLAUDE.md`.

## Index

| ADR                                            | Title                                 | Status   | Date       | Tickets |
| ---------------------------------------------- | ------------------------------------- | -------- | ---------- | ------- |
| [ADR-001](./ADR-001-canonical-action-model.md) | Canonical action model                | Accepted | 2026-09-18 | RFX-005 |
| [ADR-009](./ADR-009-contract-versioning.md)    | Contract versioning and compatibility | Accepted | 2026-09-18 | RFX-011 |

### Planned

`docs/architecture.md` §14 requires these before Gate G2 opens. They are
listed here so the gap is visible; none of them is decided yet. Their numbers
are reserved, which is why the next ADR after ADR-001 is ADR-009.

| ADR     | Title                          |
| ------- | ------------------------------ |
| ADR-002 | Decision precedence            |
| ADR-003 | Fail behavior                  |
| ADR-004 | Policy precedence              |
| ADR-005 | Provider abstraction           |
| ADR-006 | Local redaction boundary       |
| ADR-007 | Adapter ASK semantics          |
| ADR-008 | Telemetry persistence strategy |

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
