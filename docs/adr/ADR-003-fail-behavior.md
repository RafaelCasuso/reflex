# ADR-003: Fail behavior

- **Status:** Accepted
- **Date:** 2026-09-20
- **Tickets:** RFX-113, RFX-020, RFX-022, RFX-043
- **Supersedes:** none

## Context

`CLAUDE.md` principle 5: REFLEX may never silently disappear from the execution
path, and every adapter must define its behavior on timeout, network failure,
malformed response, unavailable provider, invalid policy and unsupported host
operation. Three fallback classes exist: `fail-open`, `fail-ask`,
`fail-closed`.

Two facts from G1.5 shape the answer:

- **The host fails open on almost everything** (RFX-087, verified live on
  Claude Code 2.1.276). A hook that crashes, prints invalid JSON, times out or
  is missing lets the call run. Only an explicit answer blocks. "Fail closed"
  cannot be left to the host.
- **`DecisionRequest.failureMode` is set by the client.** As written, a client
  can ask for `fail-open` on anything.

## Decision

Accepted by the maintainer on 2026-09-20, as recommended when it was proposed.

### 1. Who decides the failure mode

The failure mode is configuration, resolved like policy (ADR-004): every source
may set one, and the most restrictive wins (`fail-closed` > `fail-ask` >
`fail-open`). With nothing configured it is `fail-ask`.

`DecisionRequest.failureMode` is a **ceiling on leniency, not an instruction**.
The engine applies the stricter of the requested mode, the configured mode and
the floor of the action's class. A client can ask to be treated more strictly
and never less. So a client **cannot** obtain `fail-open` for a destructive
action.

### 2. Which classes may fail open

| `sideEffectClass`                                                                                                  | Most lenient fallback |
| ------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `none`, `local-read`                                                                                               | `fail-open`           |
| `local-write`, `external-read`, `external-write`, `destructive`, `financial`, `privilege`, `credential`, `unknown` | `fail-ask`            |

`external-read` is on the strict side because a read that leaves the machine
can carry data out in its URL.

`fail-open` means what `CLAUDE.md` says: defer to host behavior. It is not an
`allow`. The adapter emits nothing and the host's own flow decides, so REFLEX
failing never makes the host more permissive than it was.

`fail-ask` yields `effect: "ask"`. `fail-closed` yields `effect: "deny"`. Both
go through the mode table of ADR-002 like any other effect, so in Assist a
`fail-closed` still ends as a native prompt, and in Observe nothing is emitted.

### 3. What fails, and into what

| Failure                                          | Fallback reason  | Notes                                                                                                             |
| ------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| semantic provider timeout                        | `timeout`        | the deadline is the engine's own (RFX-022); no retry on the decision path                                         |
| provider unavailable, rate limited, bad response | `provider-error` | a partial assessment is a bad response (ADR-005)                                                                  |
| remote gateway unreachable                       | `gateway-error`  | only ever on the semantic path (ADR-010)                                                                          |
| request that does not validate                   | `invalid-input`  | treated as class `unknown`                                                                                        |
| policy that does not compile                     | not a fallback   | the last good compiled set stays in force and the error is reported; with no good set, every action is unresolved |

A failure only matters when the stage was needed. A deterministic decision
never depends on the provider, so a provider outage changes nothing for the
actions policy resolves.

### 4. When the adapter can reach nothing at all

The hook client cannot reach the daemon and cannot start it (ADR-010). It has
no engine, so it cannot classify; every action is `unknown`.

- **Observe:** silent, exit 0. One observation is lost.
- **Assist and Autopilot:** the client itself answers `ask`, inside a deadline
  shorter than the host's hook timeout. In Autopilot with `fail-closed`
  configured it answers `deny`; in Assist a deny is a request for native
  approval anyway (ADR-002). It never exits non-zero, never prints anything but
  its answer, and never exits without one.

The client knows the mode and the failure mode from its install-time
configuration, not from the daemon.

### 5. How a fallback is reported

A fallback is never silent:

- the decision carries `fallback: { used: true, reason, configuredMode }` and a
  reason code (`provider_unavailable` or `decision_timeout`);
- where the host can show a reason with its prompt or its refusal, the adapter
  gives one line: what failed and what REFLEX did about it, with no argument
  value in it;
- `rfx status` counts fallbacks by reason and shows the last one; `rfx doctor`
  explains the remedy (RFX-055);
- a fallback is a telemetry event of its own (RFX-023).

## Consequences

### Positive

- REFLEX failing never widens what the host would have done alone.
- The most dangerous request, `fail-open` for a destructive action, cannot be
  expressed.
- One table drives the engine, the client and the tests.

### Negative

- With REFLEX down, an Assist or Autopilot user is prompted for everything,
  including reads. That is the honest price of "unknown is never safe"; a
  client that could classify would duplicate the engine.
- On a host that cannot ask (headless, CI), `fail-ask` ends as a refusal
  (ADR-007). A pipeline stops when REFLEX is down. That is the safe direction,
  and it has to be visible in `rfx status`.
- The hook client grows: it must hold a deadline, start the daemon and answer
  by itself. It stays small only if it does nothing else.

### Follow-ups

- RFX-020 implements the table; RFX-022 the deadline.
- RFX-043 implements the client's own answer for Claude Code.
- The contract comment on `DecisionRequest.failureMode` should say "requested
  ceiling". A comment, not a wire change.

## Alternatives considered

- **The client decides the failure mode.** Rejected: whoever controls the
  client controls the safety property.
- **Fail closed by default.** Rejected as a default: a developer tool that
  stops all work when its daemon hiccups gets uninstalled, and an uninstalled
  REFLEX protects nothing. It remains one line of configuration.
- **Classify in the client so that reads can pass when the daemon is down.**
  Rejected: a second, weaker classifier on the path where mistakes are least
  visible.
- **Retry the provider before falling back.** Rejected on the decision path
  (RFX-026): a retry spends the latency budget twice.

## Enforcement

- RFX-020: a table-driven test over every class by every requested and
  configured mode, and an adversarial test that a request for `fail-open`
  never yields anything more lenient than the class floor.
- RFX-043: the real binary, run with the daemon absent, answers within its
  deadline in every mode, as `bin.e2e.test.ts` already does for Observe.
- `docs/claude-code-hook.md` §3 stays the record of what the host does.

## References

- `CLAUDE.md`: principle 5
- `docs/claude-code-hook.md` §3 (RFX-087)
- ADR-002, ADR-004, ADR-005, ADR-007, ADR-010
- `packages/contracts/src/decision.ts`: `FALLBACK_REASONS`, `DecisionFallback`
