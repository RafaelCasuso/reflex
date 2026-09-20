# ADR-008: Telemetry persistence strategy

- **Status:** Proposed
- **Date:** 2026-09-20
- **Tickets:** RFX-118, RFX-023, RFX-059, RFX-060, RFX-085, RFX-121
- **Supersedes:** none

## Context

`CLAUDE.md`: PostgreSQL for transactional control-plane data, ClickHouse only
when telemetry volume justifies it, no second database until a measured
constraint requires one, and telemetry outside the critical path whenever
possible. `docs/architecture.md` §3 allows one exception: an organization may
require synchronous audit persistence. §10 lists what is never persisted.

ADR-010 puts the decision on the user's machine. So there are two stores to
talk about, not one: the local one, which exists since G1.5 as a size-bounded
log, and the control plane's.

Nothing has been measured about event volume, because no event has ever been
sent. Any number below is a threshold to measure against, not a finding.

## Decision

Not decided.

Recommendation (not binding):

### 1. PostgreSQL until a named measurement says otherwise

Decision events go to PostgreSQL, in an append-only table partitioned by month,
apart from the transactional tables. They move to ClickHouse when **either** of
these holds on the production database for seven consecutive days:

- the dashboard's standard aggregate (30 days of decisions for one project,
  grouped by day and effect) exceeds **p95 2 s**; or
- event ingestion degrades the transactional workload: p95 latency of
  control-plane writes is **more than 20% worse** while ingestion runs than
  while it is paused.

The benchmark that produces both numbers is part of RFX-060 and is re-run
before every tenfold growth in stored events. Table size alone is not a
trigger: a big table that answers in time is not a problem.

The event schema is written so that the move is a copy: no foreign keys from
events into transactional tables, no updates, no joins in the dashboard's
aggregates that ClickHouse could not do.

### 2. When audit persistence is synchronous

Never by default. Telemetry is written after the decision is returned.

When an organization requires it, "synchronous" means: the decision is not
returned until its audit record is **durable in the local daemon's append-only
journal** (written and flushed to disk). Shipping the journal to the control
plane stays asynchronous, at least once, in order, with the journal as the
retry buffer.

So a network call is never on the decision path, even for audited
organizations, and an audited decision survives a crash or a lost connection.
The cost is one local flush, which RFX-024 has to measure before anyone
promises it.

The control plane's own audit log (RFX-085: policy changes, accepted
suggestions, mode changes, membership) is transactional data. It is written
synchronously in the same transaction as the change it records, always.

### 3. What is never stored, anywhere

- environment variables, authorization headers, API keys, private keys, access
  tokens (`docs/architecture.md` §10);
- a raw argument value before redaction (ADR-006);
- tool output, transcripts, the user's conversation, the assistant's messages;
- the semantic provider's raw request or response;
- a plain hash of any of the above.

### 4. Retention, by event class

Defaults. An organization may shorten any of them, and lengthen only the ones
marked so.

| Event class                                                      | Local                                                | Control plane                        |
| ---------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------ |
| Observation log (G1.5): action shape, outcome signals            | size-bounded, rotated (about 20 MB)                  | not sent                             |
| Decision metadata: effect, reasons, matches, risk, latency, hash | 30 days                                              | 90 days, may be lengthened           |
| Redacted arguments and redacted semantic context                 | 7 days                                               | 30 days, off until consent (RFX-123) |
| Action outcomes (ADR-013)                                        | 30 days                                              | 90 days, may be lengthened           |
| Aggregates: counts and percentiles per day                       | not kept                                             | kept                                 |
| Audit log (RFX-085)                                              | not applicable                                       | 1 year minimum, may be lengthened    |
| Synchronous audit journal                                        | until acknowledged by the control plane, then 7 days | as decision metadata                 |

Deletion on request and on leaving is RFX-121.

## Consequences

### Positive

- One database until a measurement, which exists as a test, says two.
- Synchronous audit costs a disk flush, not a round trip, and works offline.
- The never-stored list is short enough to test end to end with canary values.

### Negative

- The two triggers can only be evaluated in production. Until there is
  production, "not yet" is an assumption.
- A local journal is one more file to protect, rotate and purge, and one more
  thing that can fill a disk.
- Retention numbers are product decisions presented as engineering defaults.
  They are here so that they exist; legal review may change every one.
- Monthly partitions in PostgreSQL need maintenance that ClickHouse would not.

### Follow-ups

- RFX-059 and RFX-060: schema, partitions, the benchmark.
- RFX-023: structured telemetry with the canary test.
- RFX-085: audit log. RFX-121: retention and deletion.

## Alternatives considered

- **ClickHouse from the start.** Against `CLAUDE.md`, and a second database to
  run before the first customer.
- **A row-count trigger.** Easy to check and unrelated to any pain.
- **Synchronous audit as a remote write.** Puts the network on the decision
  path and makes an audited organization unable to work offline.
- **Keep everything forever, decide later.** The cheapest decision now and the
  most expensive one to reverse.

## Enforcement

- RFX-060: the trigger benchmark runs in CI against a seeded database and
  prints both numbers; the thresholds live next to it as constants.
- RFX-023: canary values for every item of the never-stored list go through the
  whole pipeline and must not appear in any store.
- RFX-121: a test that expired rows are gone, per class.
- The boundary test already forbids `dashboard -> database`.

## References

- `CLAUDE.md`: "Monorepo rules", principle 1, "Coding conventions"
- `docs/architecture.md`: §3, §9, §10
- ADR-006, ADR-010, ADR-013
