# ADR-010: Decision placement and hook latency

- **Status:** Proposed
- **Date:** 2026-09-18
- **Tickets:** RFX-094, RFX-088, RFX-024
- **Supersedes:** none

## Context

`CLAUDE.md` sets latency budgets: deterministic decision p95 < 10 ms, cached
semantic p95 < 20 ms, infrastructure overhead excluding inference p95 < 25 ms.
`docs/architecture.md` draws the path as host, adapter, decision gateway (an
HTTP service), decision.

Two facts do not fit that picture as drawn.

**Hosts run a hook as a new process per tool call.** Measured on 2026-09-18
(Apple Silicon laptop, Node 24.9, 25 runs each):

| Per-call Node process                            | p50     | p95      |
| ------------------------------------------------ | ------- | -------- |
| Empty process                                    | 29.5 ms | 37.5 ms  |
| Loads `@reflex/contracts`, validates one request | 70.5 ms | 102.4 ms |

Validation itself costs about 4 microseconds (see
`packages/contracts/README.md`). The budget is spent before any REFLEX code
runs. A network round trip to a remote gateway comes on top.

**First value has to work without an account** (RFX-058: "user can govern
actions locally before creating cloud account"), and the data plane "must
continue functioning if the dashboard is unavailable". A deterministic decision
that needs a remote service satisfies neither.

So two things are undefined: **where** a decision is made, and **where** the
latency budgets are measured.

## Options

**A. Per-call Node process that calls a remote gateway.** What the diagrams
imply today.

**B. Local long-lived daemon plus a minimal client.** The hook is a tiny client
that talks to a daemon over a Unix domain socket (named pipe on Windows). The
daemon holds the compiled policy set, evaluates the deterministic path locally,
and calls the remote gateway only for the semantic path.

**C. Single compiled binary per call.** Package the engine as a native or
single-executable binary so that process start is a few milliseconds, with no
daemon.

**D. Keep A and redefine the budgets as in-engine only.**

## Decision

Not decided. RFX-088 provides the baseline this decision needs; the numbers
above are a first measurement, not the benchmark.

Recommendation (not binding): **option B**, with the budgets reported at two
named points.

- A cannot meet the deterministic budget end to end, and it makes the
  no-account path depend on a server.
- C removes the daemon but pays policy load on every call, and makes the
  TypeScript engine harder to ship. It stays a fallback if daemon lifecycle
  proves too fragile.
- D is honest about measurement but does nothing for the developer, who feels
  every millisecond of every tool call. Hot-path discipline is a product
  promise, not an internal metric.

Under option B, every latency number states its measurement point: **in-engine**
(what the budgets in `CLAUDE.md` were written for) and **end to end from the
hook** (what the user feels). Both are reported, and RFX-024 covers both.

## Consequences

If option B is accepted:

### Positive

- The deterministic path is local: fast, offline-capable, account-free.
- Tool arguments never leave the machine for actions that policy resolves,
  which is most of them. That is a privacy property worth stating in the
  product.
- The gateway is only on the semantic path, which is where its cost belongs.

### Negative

- **A daemon is a new failure mode.** A daemon that is down is a hook failure,
  and must follow the fail-behavior rules (ADR-003) and whatever RFX-087 finds
  the host does. It must never become a silent fail-open.
- Lifecycle work: who starts it, how it upgrades while running, one daemon for
  many projects, cleanup on uninstall.
- The socket is an attack surface: same-user only, strict permissions, and the
  daemon must treat every client as untrusted input.
- The architecture document's request lifecycle needs a local branch, and the
  gateway stops being on every request path.

## Open questions

- On-demand start by the first hook call, or a login item installed by
  `rfx init`? The first is friendlier to uninstall, the second to latency.
- Does the client need to be non-Node to meet the end-to-end number, or is a
  dependency-free Node script enough? RFX-088 answers this with data.
- How does the daemon receive policy updates from the control plane (the
  "config snapshots" arrow), and how are they authenticated (RFX-083)?
- What is the end-to-end budget? The 10 ms figure was written for the engine.

## References

- `CLAUDE.md`: principle 1 (hot-path discipline), principle 5 (fail explicitly),
  "UX rules"
- `docs/architecture.md`: §1, §3, §12
- `packages/contracts/README.md`: validation latency baseline
- `docs/backlog.md`: RFX-024, RFX-058, RFX-087, RFX-088, RFX-094, RFX-107
- `docs/jev-provider.md`: measured semantic latency (RFX-107). A connection
  opened per call adds about 340 ms to an assessment, and the 150 ms semantic
  p50 is reachable only from close to the provider. Evidence for this decision,
  not a decision
