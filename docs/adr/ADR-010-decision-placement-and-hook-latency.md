# ADR-010: Decision placement and hook latency

- **Status:** Accepted
- **Date:** 2026-09-20
- **Tickets:** RFX-094, RFX-088, RFX-024, RFX-107
- **Supersedes:** none

## Context

`CLAUDE.md` sets latency budgets: deterministic decision p95 < 10 ms, cached
semantic p95 < 20 ms, infrastructure overhead excluding inference p95 < 25 ms.
`docs/architecture.md` draws the path as host, adapter, decision gateway (an
HTTP service), decision.

Two facts do not fit that picture as drawn.

**Hosts run a hook as a new process per tool call.** Measured on 2026-09-18
(Apple Silicon laptop, Node 24.9, 25 runs each):

| Per-call Node process                                    | p50     | p95      |
| -------------------------------------------------------- | ------- | -------- |
| Empty process                                            | 29.5 ms | 37.5 ms  |
| Loads `@reflex-control/contracts`, validates one request | 70.5 ms | 102.4 ms |

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

**Option B**, accepted by the maintainer on 2026-09-20: a local long-lived
daemon plus a minimal client. The hook is a small client that talks to the
daemon over a Unix domain socket (a named pipe on Windows). The daemon holds
the compiled policy set, evaluates the deterministic path locally, and is the
only component that talks to a remote service, for the semantic path only.

It was proposed on 2026-09-18 with the reasoning below, which stands as the
rationale, and accepted after two measurements:

- RFX-088: a Node process per hook call costs 48.8 ms at p50 and 59.3 ms at p95
  end to end, of which an empty Node process alone is about 30 ms. Neither a
  compile cache nor a dedicated entry point changed that.
- RFX-107: a process per call cannot keep a connection open. A semantic
  assessment costs about 600 ms over a new connection and about 260 ms over a
  kept one, from the same machine.

Why not the others:

- A cannot meet the deterministic budget end to end, and it makes the
  no-account path depend on a server.
- C removes the daemon but pays policy load on every call, cannot keep a
  connection open either, and makes the TypeScript engine harder to ship. It
  stays a fallback if daemon lifecycle proves too fragile.
- D is honest about measurement but does nothing for the developer, who feels
  every millisecond of every tool call. Hot-path discipline is a product
  promise, not an internal metric.

### Where each budget is measured

Every latency number states its measurement point. The budgets in `CLAUDE.md`
were written for the engine and are measured **in-engine**: inside the daemon,
from the moment a validated request is in memory to the moment the decision
is. What the user feels is measured **end to end from the hook**: from the
start of the hook process to its exit. Both are always reported (RFX-024).

| Budget in `CLAUDE.md`                                    | Measured                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| deterministic policy decision, p95 < 10 ms               | in-engine                                                                       |
| cached semantic decision, p95 < 20 ms                    | in-engine                                                                       |
| semantic decision, p50 < 150 ms and p95 < 400 ms         | in-engine, from the request to the provider's complete answer, network included |
| infrastructure overhead excluding inference, p95 < 25 ms | in-engine total minus the provider's round trip                                 |

There is **no end-to-end budget yet**. The measured baseline for a Node client
is 48.8 ms at p50 before it does anything useful, so a Node client cannot bring
the end-to-end number under about 30 ms whatever the daemon does. Setting an
end-to-end budget, and with it whether the client has to be something other
than Node, is a change to `CLAUDE.md` and stays with the maintainer.

### When the daemon does not answer

A daemon that is down is a hook failure, and the host's reading of a failed
hook is "carry on" (RFX-087). So the client never exits on an error path
without an answer. If the daemon does not answer, the client tries once to
start it, and if it still has no decision inside its own deadline, which is
shorter than the host's hook timeout, it answers by itself:

- in **Observe**, nothing: it stays silent and exits 0, as it does today;
- in **Assist** and **Autopilot**, the configured failure mode, applied by the
  client with no engine behind it. Without an engine nothing is classified, so
  every action is of unknown class, and an unknown class never fails open
  (`CLAUDE.md` principle 5). The answer is `ask`, or `deny` where `fail-closed`
  is configured. ADR-003 owns the full table.

The client reads the mode and the failure mode from its install-time
configuration, because it has to know them with the daemon down.

## Implementation notes

Made precise while starting G3 (2026-09-22). They narrow the accepted decision
and do not change it.

- **The daemon is `apps/decision-gateway`, listening on a Unix domain socket.**
  `CLAUDE.md` already defines that app as the latency-sensitive runtime
  decision endpoint, deployable on its own, and the G3 tickets are written for
  it. One server, two ways to listen: a socket path on the user's machine
  (same user, no account, no key), and TCP for the remote service that G14
  puts behind API keys. The handler for `POST /v1/decisions` is the same code
  in both. No new package.
- **The protocol over the socket is HTTP/1.1.** Node serves it on a socket
  path natively, the client needs nothing but `node:http`, and the tickets of
  this gate are HTTP concepts (a size limit is 413, a rate limit 429, an
  idempotency conflict 409). What it costs against a raw frame is one of the
  numbers RFX-024 reports, and the choice is reversible: the client sees a
  request and a response, not a wire format.
- **The socket is private to the user.** It lives in a directory of mode
  `0700` under the REFLEX home, the socket file is `0600`, and the daemon
  binds nothing else unless told to. A TCP listener that is not loopback
  refuses to start without an authenticator (G14), because "fail explicit"
  applies to configuration too.
- **The daemon treats every client as untrusted input.** Every request is
  parsed strictly at the boundary (ADR-009), bounded in size before it is read
  and in rate before it is validated (RFX-119), and answered with a typed
  error, never a stack trace.
- **The client writes HTTP/1.1 by hand over `node:net`.** Measured in RFX-024
  (`docs/decision-gateway.md` §4): a per-call Node process costs about 26 ms
  empty, 28 ms with `node:net` loaded and 40 ms with `node:http` loaded. The
  same request end to end is 33 ms at p50 from a `node:net` client and 49 ms
  from a `node:http` one. So the hook client (RFX-043) loads `node:net` and
  nothing else, and the protocol stays HTTP so that the daemon has one
  handler. The floor for a Node client is about 33 ms end to end, of which
  26 ms is Node starting; the open question about a client that is not a
  Node script is unchanged, and the daemon is not what stands in the way.
- **Who starts the daemon is not this gate's work.** The client's own answer
  when the daemon is down is RFX-043 (G7); starting it on demand, keeping one
  daemon for many projects, upgrading it while it runs and removing it on
  uninstall need a ticket of their own, RFX-138, which G3 adds to G7 ahead
  of RFX-043.

## Consequences

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

_Resolved 2026-09-27 by RFX-138 (`docs/decision-gateway.md` §3, "The lifecycle"): who starts the daemon (the first hook that finds it down, once, under a lock), one daemon per user, replacement by version with in-flight decisions finished, removal on uninstall, stale sockets never joined._

- On-demand start by the first hook call, or a login item installed by
  `rfx init`? The first is friendlier to uninstall, the second to latency.
- The end-to-end budget, and whether the client can stay a Node script. The
  data says a Node client costs about 30 ms before it runs a line of REFLEX
  code; a native client is the only way under that.
- How does the daemon receive policy updates from the control plane (the
  "config snapshots" arrow), and how are they authenticated (RFX-083)?
- Where the remote semantic path is served from. RFX-107 measured 95 ms of
  provider time and about 160 ms of round trip from a laptop; the 150 ms p50 is
  reachable only from close to the provider.

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
