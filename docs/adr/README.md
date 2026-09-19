# Architecture Decision Records

An ADR records one architecturally significant decision: the forces at play,
what was decided, and what it costs. ADRs are how REFLEX changes its mind on
purpose instead of by drift.

`CLAUDE.md` is the engineering operating system and outranks tickets. An ADR
cannot silently override it: if a decision requires changing `CLAUDE.md`, the
ADR says so explicitly and the same change updates `CLAUDE.md`.

## Index

| ADR                                                            | Title                                            | Status   | Date       | Tickets |
| -------------------------------------------------------------- | ------------------------------------------------ | -------- | ---------- | ------- |
| [ADR-001](./ADR-001-canonical-action-model.md)                 | Canonical action model                           | Accepted | 2026-09-18 | RFX-005 |
| [ADR-009](./ADR-009-contract-versioning.md)                    | Contract versioning and compatibility            | Accepted | 2026-09-18 | RFX-011 |
| [ADR-010](./ADR-010-decision-placement-and-hook-latency.md)    | Decision placement and hook latency              | Proposed | 2026-09-18 | RFX-094 |
| [ADR-011](./ADR-011-normalized-operands-and-classification.md) | Normalized operands and classification ownership | Proposed | 2026-09-18 | RFX-095 |
| [ADR-012](./ADR-012-self-protection-and-workspace-trust.md)    | Self-protection and workspace trust              | Proposed | 2026-09-18 | RFX-102 |
| [ADR-013](./ADR-013-action-outcome-observation.md)             | Action outcome observation                       | Accepted | 2026-09-19 | RFX-091 |

### Planned

`docs/architecture.md` §14 requires these before Gate G2 opens. They are
listed here so the gap is visible; none of them is decided yet. Their numbers
are reserved, which is why the next ADR after ADR-001 is ADR-009.

| ADR     | Title                          | Ticket  | Must answer                                                                                                                                                                                                                                                                                                      |
| ------- | ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-002 | Decision precedence            | RFX-112 | The full table of mode (observe, assist, autopilot) by effect (allow, ask, deny): what `effectiveEffect` is in each cell and what the adapter does. Whether a semantic result can ever lower a deterministic ask. How `risk` and `confidence` are set for a purely deterministic decision.                       |
| ADR-003 | Fail behavior                  | RFX-113 | Which side-effect classes may fail open, and who decides the failure mode: can a client request `fail-open` for a destructive action? What the adapter does when it can reach nothing at all. How a fallback is reported to the user.                                                                            |
| ADR-004 | Policy precedence              | RFX-114 | What `mandatory` means exactly. Whether a lower source can override a non-mandatory rule from a higher source. How `PolicyMatch.precedence` is derived, how ties inside one source are broken, and how `defaults.unresolved` combines across sources. How trust (ADR-012) enters precedence.                     |
| ADR-005 | Provider abstraction           | RFX-115 | Where `SemanticDecisionProvider` and `DecisionEngine` live: in contracts, where they are today, or in `packages/semantic-provider`. The typed provider error model. Confirmation that a partial assessment is an error (ADR-009 reads assessments strictly).                                                     |
| ADR-006 | Local redaction boundary       | RFX-116 | What is redacted where (adapter, CLI, gateway). What may be written locally before redaction. Whether policy is matched before or after redaction, since a rule about a secret-shaped argument cannot match redacted text. Whether redacted values are hashed so that repeated approvals can still be clustered. |
| ADR-007 | Adapter ASK semantics          | RFX-117 | A capability matrix per host: how allow, ask and deny are expressed, and in which hook. What `ask` becomes when the host cannot ask, for example headless or CI runs. How Assist maps onto each host.                                                                                                            |
| ADR-008 | Telemetry persistence strategy | RFX-118 | The measured trigger for moving events from PostgreSQL to ClickHouse. When audit persistence is synchronous. What is never stored. Retention per event class.                                                                                                                                                    |

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
