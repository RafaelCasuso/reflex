# The decision gateway

`apps/decision-gateway` is the runtime decision endpoint: `POST /v1/decisions`
in, a `ReflexDecision` out. On the user's machine it is the local daemon of
ADR-010, listening on a Unix domain socket, deciding the deterministic path
with no network and no account. The same server, listening on TCP behind API
keys, is the remote service of G14. This page is what it does today (G3) and
what it measured.

## 1. What it is made of

| Piece                                   | Where                                       | Ticket              |
| --------------------------------------- | ------------------------------------------- | ------------------- |
| Stage order, deadline, cache, fallback  | `packages/core`                             | RFX-019/022/106/020 |
| `POST /v1/decisions`, `GET /v1/health`  | `apps/decision-gateway/src/http/handler.ts` | RFX-021             |
| Body size limit, rate limit             | `src/http/body.ts`, `src/http/limits.ts`    | RFX-119             |
| Idempotency by `action.id`              | `src/http/idempotency.ts`                   | RFX-120             |
| Decision events, local decision log     | `packages/telemetry`                        | RFX-023             |
| The daemon process and its command line | `src/main.ts`, `src/config/arguments.ts`    | RFX-021             |
| Benchmark harness                       | `bench/gateway.bench.mjs`                   | RFX-024             |

The engine decides; the gateway validates, bounds, deduplicates, answers and
then reports. Nothing in the gateway reads inside an action.

## 2. The request, in order

1. **Rate limit**, on arrival, before anything is read: a token bucket per
   caller (one caller for a socket, one per address on TCP). Over the limit is
   `429` with `Retry-After`. State is in memory and bounded; losing it starts a
   caller over with one burst, never with no limit.
2. **Media type**: anything but `application/json` is `415`.
3. **Size**, before the body is read: a declared length over the limit is
   `413` without reading; a body that lies is stopped at the limit and gets
   `413` too. The default limit is 4 MiB.
4. **Strict validation** (ADR-009): `parseDecisionRequest`. A failure is
   `400` with the paths and codes of the issues, never a value from the input.
5. **Idempotency** (RFX-120): the same `action.id` with the same content
   (the engine's fingerprint, the mode, the requested failure mode) returns
   the decision already made, byte for byte, with `X-Reflex-Replayed: true`,
   and is not counted again; the same id with different content is `409`.
6. **The engine.** A client that goes away aborts the decision it asked for.
7. **The answer**: `200`, the decision as JSON, `X-Reflex-Decision-Id` and the
   request's `X-Request-Id` (echoed when usable, made up otherwise).
8. **Telemetry**, on the next turn of the event loop, after the answer has
   left. A sink that throws changes nothing.

Every rejection is `{ error: { code, message, issues? }, requestId }` with a
closed `code`: `invalid-request`, `payload-too-large`, `rate-limited`,
`idempotency-conflict`, `unsupported-media-type`, `not-found`,
`method-not-allowed`, `internal-error`. There is no stack trace on the wire.

## 3. The daemon

```
node apps/decision-gateway/dist/main.js [--socket <path> | --tcp <host:port>]
  [--policy <file>]... [--failure-mode fail-open|fail-ask|fail-closed]
  [--no-cache] [--no-telemetry] [--home <dir>] [--rate-limit <burst>/<per-second>]
  [--semantic-provider none|jev|local|reflex|fake] [--semantic-model <id>]
  [--semantic-endpoint <url>] [--shadow-provider <id>]...
  [--shadow-deadline <ms>] [--shadow-sample unresolved|all]
```

- Default: the socket `<REFLEX_HOME>/run/reflex.sock`, in a directory of mode
  `0700`, the socket `0600`. A socket nobody answers on is replaced; one that
  answers means another daemon runs, and this one exits.
- `--tcp` binds loopback only. Any other interface is refused until an
  authenticator exists (G14).
- `--policy` files are the user's own local policy. A file that does not load
  is reported on stderr and REFLEX's own rules alone are in force (ADR-003
  §3); `GET /v1/health` says so (`policyLoadedAt: null`, `policyProblems`).
- Once listening, one JSON line on stdout: `{ "listening": {...}, "version" }`.
  `SIGTERM` or `SIGINT` closes the connections, removes the socket and exits 0.
- An unknown flag exits 2. A daemon that starts with a misread flag would run
  with the wrong policy.
- `--semantic-provider` (RFX-141, ADR-016 §1) chooses what assesses the
  actions policy leaves open: `none` is the default and today's behavior (an
  open action asks); `jev` needs `TYPESAFE_API_KEY` in the daemon's
  environment, never on the command line; `local` (RFX-144,
  `docs/local-provider.md`) is an inference server on this machine, needs
  `--semantic-model` pinned to the checkpoint it serves and an endpoint on
  the loopback; `fake` is for development and answers from the action's
  class; `reflex` (G14) is refused until it exists. A provider that was asked for and cannot be built
  exits 2 with the reason: a daemon never runs without what it was told to
  run with. `--semantic-model` pins a versioned model (an alias is refused)
  and `--semantic-endpoint` overrides where the provider is reached. The
  stage is the compiler with the installation's redaction key (ADR-006), the
  provider, and the aggregator with its default configuration
  (`docs/risk-aggregation.md`), on a budget of 600 input tokens.
  `GET /v1/health` reports `semanticProvider: { id, name, model }`, pinned,
  and never the key or the endpoint; every decision the provider took part
  in carries `semanticAssessment.provider` and `.model`.
- `--shadow-provider` (RFX-142, ADR-016 §3), repeatable, names providers
  that are evaluated alongside the primary and whose answers are recorded
  and never used. A shadow gets the same redacted request as the primary,
  at the same moment, under its own `--shadow-deadline` (5,000 ms by
  default); the decision returns when the primary is done and no field of
  it, nor its latency, depends on a shadow. `--shadow-sample unresolved`
  (the default) runs shadows where the primary runs; `all` runs them on the
  actions policy resolved too, off the decision path, and is accepted for
  `local` shadows only, because ADR-010 promises that the arguments of a
  resolved action never leave the machine. A shadow needs a primary. Health
  lists `shadowProviders: [{ id, name, model, sample }]`. Each settled
  shadow evaluation is a `shadow` telemetry event of its own (provider,
  model, whether it assessed or how it failed, latency; no content), never
  a fallback. A decision served from the cache runs no shadow.
- Decision records (RFX-143, ADR-016 §4) go to
  `<REFLEX_HOME>/records/records.jsonl`, one per decision, written after the
  answer once every shadow of the decision has settled: the redacted request
  the primary was given (ADR-006; absent when no provider saw one), every
  provider's answer or failure with its role and latency, what REFLEX decided
  (effect, mode, risk, confidence, reason codes, matches, policy set hash,
  fallback; never the cache key or the clock), and a `deterministic_rule`
  label when a rule or a policy default decided. Outcomes and feedback are
  joined later by id (`@reflex/telemetry`'s `withOutcome` and `withFeedback`),
  and each adds a `human` or `production_outcome` label; a record refuses an
  outcome of another action or feedback on another decision. The log rotates
  by size and by age, and keeps seven days (ADR-008 §4, the retention of
  redacted semantic context); a record that fails to write is counted in
  health (`recordsDropped`) and never fails a decision. Off with
  `--no-telemetry`.

Decision telemetry goes to `<REFLEX_HOME>/decisions/decisions.jsonl`, rotated
by size, one event per line: a `decision` event per decision (effect, mode,
risk bucket, reason codes, matched rule ids, cache status, latency, host,
tool name; never an argument, a path or an objective), a `fallback` event of
its own when one was used (ADR-003 §5), and a `rejected` event per request
turned away. Canary values for every item of the never-stored list (ADR-008
§3) go through the whole pipeline in `src/telemetry.test.ts` and must not
come out.

### The lifecycle (RFX-138)

The CLI starts, finds, replaces and stops the daemon; the user never
manages a process. `packages/cli/src/daemon/lifecycle.ts`:

- **One daemon per user.** Its socket is `<REFLEX_HOME>/run/reflex.sock`
  (directory `0700`, socket `0600`); `run/daemon.json` remembers the pid,
  the version and when it started, advisory only; `run/daemon.log` holds
  its stderr. Every project and host of the user shares it.
- **Started once, however many hooks find it down at the same moment.**
  `ensureDaemon` probes `GET /v1/health` over the socket with a hand-written
  HTTP/1.1 client on `node:net` (the hook must not load `node:http`,
  ADR-010). Down, it takes `run/start.lock` with `O_EXCL`; the holder spawns
  `node <gateway>/dist/main.js --socket … --home … [--policy
<home>/policy.yaml] [provider flags from <home>/config.json]`, detached,
  and waits for the answer; the others wait for the same answer. A lock
  older than fifteen seconds belongs to a starter that died and is taken
  over. The whole thing fits the hook's own deadline (2.5 s by default).
- **Replaced when it is not the shipped version.** The version the health
  reports is compared with the gateway manifest this installation ships;
  another one is stopped with `SIGTERM`, which lets the gateway finish
  what is in flight before it exits, and the shipped one is started. The
  binary reports exactly its manifest's version (a test holds it), so a
  replacement never loops.
- **Never joined when stale.** A socket file nobody answers on is replaced
  by the daemon itself when it starts (`server.ts`); a `daemon.json` naming
  a dead process is ignored; the only pid ever signalled is the one the
  daemon answering on the socket reports as its own (`health.pid`).
- **Stopped on `rfx uninstall`**, with the socket and the state file
  removed; `SIGKILL` after the grace period if it does not exit. `rfx
status` shows whether it runs, its version, pid and uptime.

The daemon's configuration is the user's, `<REFLEX_HOME>/config.json`
(`semanticProvider`, `semanticModel`, `semanticEndpoint`, `shadowProviders`,
`shadowSample`, `shadowDeadlineMs`); absent or unreadable, it runs with no
provider. The user's policy is `<REFLEX_HOME>/policy.yaml` when it exists;
a project's `.reflex/policy.yaml` is G9's.

## 4. What it costs (RFX-024)

Measured on 2026-09-22 with `node bench/gateway.bench.mjs --runs 500` on an
Apple M1 Max, darwin 25.6.0 arm64, Node v24.9.0, against a policy of 204
rules (200 generated, one allow for reads, REFLEX's own three). The record is
`bench/results/apple-m1-max-node24.json`, and `src/bench-evidence.test.ts`
holds this table to it. Every number says where it was measured, as ADR-010
requires. Milliseconds.

| Case                         | Point of measurement                    |   p50 |   p95 |   p99 |
| ---------------------------- | --------------------------------------- | ----: | ----: | ----: |
| typical read (`allow`)       | in-engine, sub-millisecond, core bench  | 0.098 | 0.141 | 0.333 |
|                              | over the socket, warm client, miss      |  0.27 |  0.42 |  0.63 |
|                              | over the socket, warm client, cache hit |  0.12 |  0.19 |  0.22 |
|                              | end to end, `node:http` client          | 49.18 | 54.72 | 64.27 |
|                              | end to end, `node:net` client           | 33.42 | 37.22 | 51.90 |
| compound, 6 segments (`ask`) | in-engine, sub-millisecond, core bench  | 0.644 | 0.820 | 1.073 |
|                              | over the socket, warm client, miss      |  0.64 |  0.86 |  0.96 |
|                              | end to end, `node:http` client          | 49.91 | 54.38 | 55.91 |
|                              | end to end, `node:net` client           | 33.07 | 36.81 | 39.57 |
| bypass attempt (`ask`)       | in-engine, sub-millisecond, core bench  | 1.369 | 1.607 | 2.005 |
|                              | over the socket, warm client, miss      |  1.36 |  1.72 |  2.82 |
|                              | end to end, `node:http` client          | 50.95 | 55.18 | 57.15 |
|                              | end to end, `node:net` client           | 33.62 | 37.58 | 38.90 |

"In-engine" is from a validated request in memory to a decision, inside the
daemon; the engine reports it in whole milliseconds on every decision
(`latency.totalMs`, which reads 0 or 1 here) and `pnpm --filter @reflex/core
bench` measures it with sub-millisecond resolution, which is the row above.
"Over the socket" is one warm client process, so it is the HTTP layer, the
validation, the idempotency store and the socket on top of the engine. "End
to end" is from the start of a fresh Node process to its exit, one per
request, which is how a host runs a hook and what the user feels.

### Against the budgets in `CLAUDE.md`

| Budget                                         | Measured                                       | Holds |
| ---------------------------------------------- | ---------------------------------------------- | ----- |
| deterministic decision, p95 < 10 ms, in-engine | 0.14 to 1.6 ms                                 | yes   |
| cached decision, p95 < 20 ms, in-engine        | 0.011 ms (core bench); 0.19 ms over the socket | yes   |
| infrastructure overhead, p95 < 25 ms           | about 0.3 ms over the socket, warm             | yes   |
| end to end                                     | no budget yet (ADR-010)                        |       |

### What the harness found

1. **The gateway adds about 0.3 ms.** Over the socket, a warm client sees the
   engine's own time plus 0.2 to 0.3 ms for HTTP, validation and the
   idempotency store. HTTP/1.1 over the socket costs nothing worth a wire
   format of its own (ADR-010 implementation notes).
2. **The client must not load `node:http`.** A per-call Node process costs
   26.3 ms empty on this machine (p50). Importing `node:http` alone brings it
   to 40.2 ms; importing `node:net` to 27.8 ms. The two end-to-end rows are the
   same request from the same kind of process, and differ by 16 ms at p50 on
   that import alone. The hook client (RFX-043) will write HTTP/1.1 by hand
   over `node:net`, as `bench/client-net.mjs` does in forty lines: a request
   line, four headers, the body; a status line, headers and a body of the
   declared length.
3. **The floor for a Node client is about 33 ms end to end**, of which 26 ms
   is Node starting. That is the number ADR-010 left open: an end-to-end
   budget under about 30 ms needs a client that is not a Node script. The
   daemon is not what stands in the way.
4. **The cache is worth 0.15 ms over the socket, and nothing for the classes
   it never keeps.** The compound and bypass cases hit 0% because a command
   with `rm -rf` or `sudo` is never cached (`docs/architecture.md` §11). That
   is the intended trade: the cost of deciding such a command again is one
   policy evaluation.

## 5. What this gate does not claim

- No policy is selected per project yet: every action gets the daemon's one
  set. The engine takes the action when asked for a set, so that is a change
  in `src/orchestration/policy-source.ts`, not in the engine.
- No semantic stage runs: there is no provider (G4), no compiler (G5), no
  aggregator (G6). Every action policy leaves open is `ask`, with confidence
  0 and no fallback, because nothing failed.
- The daemon does not start itself, and nothing stops a second user from
  starting one for themselves: the socket is per user by its mode, not by
  design. RFX-138.
- TCP has no authentication and refuses to bind anywhere but loopback.
- Timing was measured on one machine, once, and is not run in CI.
