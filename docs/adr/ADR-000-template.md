# ADR-NNN: Short, specific title

- **Status:** Proposed
- **Date:** YYYY-MM-DD
- **Tickets:** RFX-NNN
- **Supersedes:** none

<!--
Statuses: Proposed | Accepted | Rejected | Deprecated | Superseded by ADR-NNN
Keep it short. An ADR that nobody reads protects nothing.
-->

## Context

What forces are at play? State the problem, the constraints that matter
(latency budget, safety property, package boundary, host limitation), and what
happens if nothing is decided. Facts, not advocacy.

## Decision

What is decided, in the active voice: "REFLEX will …". Be precise enough that
a reviewer can tell whether a given change complies.

## Consequences

### Positive

What becomes easier, safer or faster.

### Negative

What becomes harder, slower or riskier. Every real decision has a cost; an
empty section means the cost has not been found yet.

### Follow-ups

Work this decision creates, with ticket IDs where they exist.

## Alternatives considered

Each serious alternative and the specific reason it lost.

## Enforcement

How compliance is verified mechanically: tests, lint rules, types, CI gates.
A decision that only lives in prose erodes. If nothing enforces it yet, say
which ticket will.

## References

Links to `CLAUDE.md` sections, architecture sections, tickets, prior ADRs.
