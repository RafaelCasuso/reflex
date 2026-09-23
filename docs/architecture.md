# REFLEX Architecture

## 1. System shape

REFLEX is split conceptually into a **data plane** and **control plane**.

```text
                                 CONTROL PLANE

                    ┌─────────────────────────────┐
                    │ Dashboard / API             │
                    │ orgs, projects, policy,     │
                    │ billing, analytics, replay  │
                    └──────────────┬──────────────┘
                                   │ config snapshots
                                   ▼

AGENT/HOST ──► ADAPTER ──► LOCAL DAEMON ──► DECISION
               (hook       │
                client)    ├── normalize
                           ├── deterministic policy
                           ├── context compiler + local redaction
                           ├── risk aggregator
                           ├── async telemetry
                           │
                           └── unresolved only ──► DECISION GATEWAY ──► semantic provider

                                  DATA PLANE
```

The data plane must continue functioning if the dashboard is unavailable.

Decisions are made on the user's machine (ADR-010). The host starts a hook
process per tool call; that process is a minimal client of a local, long-lived
daemon, which holds the compiled policy set and resolves the deterministic path
with no network and no account. Only an action that policy does not resolve
reaches a remote service, and only as redacted, minimal context. Tool arguments
of an action that policy resolves never leave the machine.

---

## 2. Exact monorepo layout

```text
reflex/
├── CLAUDE.md
├── README.md
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── tsconfig.json            # root-level TS only (vitest.config.ts, tests/)
├── vitest.config.ts         # repo-level integrity tests only
├── eslint.config.mjs        # also enforces the forbidden dependency directions
├── .prettierrc
├── .nvmrc
├── tests/                   # repo-level integrity tests: workspace shape,
│                            # dependency direction, CI gates, ADR index
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── security.yml
│       └── release.yml
│
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── auth/
│   │       │   ├── organizations/
│   │       │   ├── projects/
│   │       │   ├── policies/
│   │       │   ├── decisions/
│   │       │   ├── feedback/
│   │       │   ├── replay/
│   │       │   └── billing/
│   │       └── server.ts
│   │
│   ├── dashboard/
│   │   ├── app/
│   │   └── src/
│   │       ├── features/
│   │       ├── components/
│   │       └── lib/
│   │
│   └── decision-gateway/     # the local daemon and the remote gateway, one server (ADR-010)
│       ├── bench/            # RFX-024 harness and its record
│       └── src/
│           ├── http/         # handler, body and rate limits, idempotency, typed problems
│           ├── orchestration/# the policy set in force, engine assembly
│           ├── config/       # the daemon's command line
│           ├── server.ts     # listen on a socket or loopback TCP
│           └── main.ts       # the daemon's entry point
│
├── packages/
│   ├── contracts/
│   │   ├── fixtures/            # frozen JSON payloads per released minor (ADR-009)
│   │   └── src/
│   │       ├── ids.ts
│   │       ├── primitives.ts
│   │       ├── limits.ts
│   │       ├── validation.ts
│   │       ├── action.ts
│   │       ├── decision.ts
│   │       ├── policy.ts
│   │       ├── semantic.ts
│   │       ├── feedback.ts
│   │       ├── parse.ts         # boundary parsers, the only public entry to validation
│   │       ├── version.ts
│   │       ├── internal/        # schemas and validation machinery, not exported
│   │       └── index.ts         # explicit public surface
│   │
│   ├── core/
│   │   └── src/
│   │       ├── decision-engine.ts   # stage order, deadline (ADR-002, RFX-019, RFX-022)
│   │       ├── semantic-stage.ts    # the seams G4, G5 and G6 fill
│   │       ├── fallback.ts          # failure modes (ADR-003, RFX-020)
│   │       ├── risk.ts, modes.ts    # the tables of ADR-002
│   │       ├── fingerprint.ts       # keyed action fingerprint, cache key (RFX-106)
│   │       ├── cache.ts             # deterministic decision cache
│   │       └── risk-aggregator.ts   # G6
│   │
│   ├── policy-engine/
│   │   └── src/
│   │       ├── parser.ts
│   │       ├── compiler.ts
│   │       ├── matcher.ts
│   │       ├── precedence.ts
│   │       └── evaluator.ts
│   │
│   ├── command-classifier/   # ADR-011: one classifier for every host
│   │   └── src/
│   │       ├── shell/        # grammar: segments, or "not understood"
│   │       └── classify.ts   # side-effect class; escalates, never lowers
│   │
│   ├── context-compiler/    # the redaction boundary (ADR-006) and the minimal request
│   │   ├── corpus/          # golden and adversarial secrets, generated at test time
│   │   └── src/
│   │       ├── patterns.ts      # the secret shapes (RFX-031)
│   │       ├── redact.ts        # placeholders, fingerprints, the branded redacted view
│   │       ├── history.ts       # relevant-history selector, bounded session memory (RFX-032)
│   │       ├── token-budget.ts  # estimate and cuts, required fields never cut (RFX-034)
│   │       └── compile.ts       # raw action in, SemanticDecisionRequest out (RFX-033)
│   │
│   ├── semantic-provider/   # the interface and its typed result (ADR-005)
│   │   └── src/
│   │       ├── provider.ts
│   │       └── fake.ts      # deterministic fake for tests and development (RFX-029)
│   │
│   ├── provider-jev/        # Jev-specific types never leave this package
│   │   ├── live/            # RFX-107 probe and record, live verification harness
│   │   └── src/
│   │       ├── client.ts    # one request per assessment, typed errors, no retry (RFX-026)
│   │       ├── questions.ts # the eleven questions, constants (RFX-027)
│   │       ├── state.ts     # the request as structured data
│   │       └── response.ts  # strict parse into the contract
│   │
│   ├── adapter-claude-code/
│   │   └── src/
│   │       ├── detect.ts
│   │       ├── install.ts
│   │       ├── hook-input.ts
│   │       ├── hook-output.ts
│   │       └── adapter.ts
│   │
│   ├── adapter-codex/
│   │   └── src/
│   │       ├── detect.ts
│   │       ├── install.ts
│   │       ├── pre-tool-use.ts
│   │       ├── permission-request.ts
│   │       └── adapter.ts
│   │
│   ├── adapter-mcp/
│   │   └── src/
│   │       ├── proxy.ts
│   │       ├── discovery.ts
│   │       └── translation.ts
│   │
│   ├── sdk-typescript/
│   ├── cli/
│   │   └── src/
│   │       ├── commands/
│   │       │   ├── init.ts
│   │       │   ├── doctor.ts
│   │       │   ├── status.ts
│   │       │   ├── trust.ts
│   │       │   └── uninstall.ts
│   │       ├── detection/
│   │       ├── backups/
│   │       └── output/
│   │
│   ├── telemetry/
│   ├── auth/
│   └── evals/
│       ├── corpus/
│       ├── harness/
│       ├── scorers/
│       └── fixtures/
│
├── python/
│   └── reflex-sdk/
│
├── docs/
│   ├── product.md
│   ├── architecture.md
│   ├── decision-engine.md
│   ├── policy-language.md
│   ├── integrations.md
│   ├── security.md
│   ├── evals.md
│   ├── pricing.md
│   ├── backlog.md
│   └── adr/                 # index: adr/README.md, template: ADR-000-template.md
│
└── infra/
    ├── local/
    └── deployment/
```

---

## 3. Request lifecycle

```text
host event
  ↓
adapter
  ↓
CanonicalActionRequest
  ↓
local daemon (Unix domain socket, same user)
  ↓
PolicyEngine.evaluate()              on the raw action, in memory (ADR-006)
  │
  ├── resolved → final deterministic decision, nothing leaves the machine
  │
  └── unresolved
          ↓
local redaction
          ↓
ContextCompiler.compile()
          ↓
SemanticDecisionProvider.evaluate()  the only remote call, over a kept connection
          ↓
RiskAggregator.aggregate()
          ↓
ReflexDecision
  ↓
adapter maps decision to host capability
  ↓
host executes / asks / blocks
```

Telemetry is emitted after the final decision and must not block the action path unless an organization explicitly requires synchronous audit persistence.

If the daemon does not answer, the hook client answers by itself and never exits without an answer in an enforcing mode: hosts read a failed hook as "carry on" (ADR-010, `docs/claude-code-hook.md` §3).

---

## 4. Canonical action model

All integrations map their native events into the same conceptual fields:

- actor / agent identity
- host
- session
- user objective
- tool
- operation
- arguments
- resource
- environment
- side-effect class
- prior relevant actions
- policy context

The canonical model deliberately does not contain Claude-, Codex-, MCP-, OpenAI-, LangGraph- or Jev-specific fields.

Host-specific raw metadata may be attached under an opaque `adapterMetadata` bag but may not affect domain logic directly.

---

## 5. Decision model

The decision engine returns:

```text
effect
risk
confidence
reason codes
matched policies
semantic assessment summary
latency
cache metadata
fallback metadata
```

The final `effect` is owned by REFLEX, not by the semantic provider.

### Precedence

1. mandatory deterministic deny
2. mandatory deterministic ask
3. deterministic allow
4. semantic aggregation
5. configured fallback

---

## 6. Semantic assessment strategy

Do not ask a single generic safety question.

Initial assessment dimensions:

```text
objective_alignment        0..100
destructive_risk           0..100
reversibility              0..100
external_side_effect       boolean
privilege_escalation       0..100
secret_access              0..100
sensitive_data_exposure    0..100
financial_consequence      0..100
production_mutation        0..100
unusual_scope              0..100
untrusted_input            0..100
```

Each carries independent confidence.

The aggregator uses:

- hard thresholds
- policy-specific overrides
- uncertainty handling
- environment-specific rules

Low semantic confidence should bias toward `ask`, not `allow`.

---

## 7. Host integration semantics

### Claude Code

Primary integration path:

- `PreToolUse`/permission-related lifecycle interception where available
- native permission system as the UI for `ASK`
- managed/local settings respected
- install into project scope first by default
- back up modified settings before write

REFLEX must never tell users to run Claude Code with blanket permission bypass as part of normal installation.

### Codex

Use:

- `PreToolUse` to observe/block/rewrite only where explicitly required
- `PermissionRequest` to decide requests that are actually entering Codex's approval flow
- native Codex prompt when REFLEX abstains/asks

Important limitation:
`PreToolUse` is not treated as a universal “ask the human” primitive. The adapter must distinguish blocking from native approval delegation.

### MCP

REFLEX proxy acts as a transparent intermediary:

- expose same server/tool names where technically possible
- preserve schemas
- normalize call
- decide
- forward only if allowed
- return safe structured denial if denied

---

## 8. Policy architecture

Policy sources, highest precedence first:

1. mandatory organization policy
2. environment policy
3. project policy
4. user/local policy
5. learned suggestions not yet accepted: no enforcement effect

Policy compiler outputs immutable `CompiledPolicySet` with a content hash.

Every decision records `policySetHash`.

This makes replay deterministic.

---

## 9. Storage

### PostgreSQL

Use for:

- organizations
- users
- projects
- memberships
- agents
- API keys metadata
- policy versions
- policy suggestions
- feedback
- replay jobs
- billing state

### Decision telemetry

Start with PostgreSQL if load is low enough.
Move high-volume immutable events to ClickHouse only after benchmarked need.

Do not begin with dual-write complexity unless required by measured volume.

### Redis

Use only for:

- short TTL decision cache
- rate limiting
- config snapshot cache

The system must remain correct if Redis is flushed.

---

## 10. Privacy model

Prefer local redaction in adapters/CLI.

Never persist:

- raw environment variables
- auth headers
- API keys
- private keys
- access tokens

Tool arguments are classified before storage.

Per organization:

- event retention
- argument retention
- hashing/redaction level
- regional processing later

---

## 11. Caching

Cache deterministic decisions using:

- canonical action fingerprint
- policy hash
- environment
- project
- relevant resource identity

Semantic caching allowed only for explicitly safe/repeatable classes.

Never blindly cache:

- destructive mutations
- financial actions
- production changes
- IAM/privilege changes
- secret access
- external publication/sending

---

## 12. Deployment evolution

### Phase 1

On the user's machine: the hook client and the local daemon (ADR-010). They
need no account and no server.

Single region:

- dashboard
- API
- decision gateway
- PostgreSQL
- optional Redis

### Phase 2

Separate decision gateway autoscaling from control plane.

### Phase 3

Regional decision gateways with replicated signed policy/config snapshots.

### Phase 4

Enterprise private gateway / hybrid deployment.

Do not build later phases before revenue/latency requires them.

---

## 13. Observability

For every decision:

- decision ID
- total latency
- policy latency
- semantic latency
- cache status
- provider
- final effect
- risk bucket
- fallback used
- adapter
- host version if available

Never include unredacted action arguments in metrics labels.

---

## 14. First architectural ADRs

ADRs live in [`docs/adr/`](./adr/README.md), which holds the index, the
template and the process.

Create these before Gate 2:

- ADR-001 canonical action model
  ([accepted](./adr/ADR-001-canonical-action-model.md))
- ADR-002 decision precedence
  ([accepted](./adr/ADR-002-decision-precedence-and-effective-effect.md))
- ADR-003 fail behavior ([accepted](./adr/ADR-003-fail-behavior.md))
- ADR-004 policy precedence ([accepted](./adr/ADR-004-policy-precedence.md))
- ADR-005 provider abstraction
  ([accepted](./adr/ADR-005-provider-abstraction.md))
- ADR-006 local redaction boundary
  ([accepted](./adr/ADR-006-local-redaction-boundary.md))
- ADR-007 adapter ASK semantics
  ([accepted](./adr/ADR-007-adapter-ask-semantics.md))
- ADR-008 telemetry persistence strategy
  ([accepted](./adr/ADR-008-telemetry-persistence-strategy.md))

Written since: ADR-009 contract versioning and compatibility
([accepted](./adr/ADR-009-contract-versioning.md)), ADR-010 decision placement
and hook latency
([accepted](./adr/ADR-010-decision-placement-and-hook-latency.md)), ADR-013
action outcome observation
([accepted](./adr/ADR-013-action-outcome-observation.md)). Also accepted:
[ADR-011](./adr/ADR-011-normalized-operands-and-classification.md) normalized
operands and classification ownership, and
[ADR-012](./adr/ADR-012-self-protection-and-workspace-trust.md) self-protection
and workspace trust.
