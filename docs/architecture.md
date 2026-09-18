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

AGENT/HOST ──► ADAPTER ──► DECISION GATEWAY ──► DECISION
                              │
                              ├── normalize
                              ├── deterministic policy
                              ├── context compiler
                              ├── semantic provider
                              ├── risk aggregator
                              └── async telemetry

                                  DATA PLANE
```

The data plane must continue functioning if the dashboard is unavailable.

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
│   └── decision-gateway/
│       └── src/
│           ├── http/
│           ├── orchestration/
│           ├── config/
│           ├── telemetry/
│           └── server.ts
│
├── packages/
│   ├── contracts/
│   │   └── src/
│   │       ├── action.ts
│   │       ├── decision.ts
│   │       ├── policy.ts
│   │       ├── semantic.ts
│   │       ├── feedback.ts
│   │       └── index.ts
│   │
│   ├── core/
│   │   └── src/
│   │       ├── decision-engine.ts
│   │       ├── risk-aggregator.ts
│   │       ├── fallback.ts
│   │       └── cache-policy.ts
│   │
│   ├── policy-engine/
│   │   └── src/
│   │       ├── parser.ts
│   │       ├── compiler.ts
│   │       ├── matcher.ts
│   │       ├── precedence.ts
│   │       └── evaluator.ts
│   │
│   ├── context-compiler/
│   │   └── src/
│   │       ├── compile.ts
│   │       ├── redact.ts
│   │       ├── history.ts
│   │       └── token-budget.ts
│   │
│   ├── semantic-provider/
│   │   └── src/
│   │       └── provider.ts
│   │
│   ├── provider-jev/
│   │   └── src/
│   │       ├── client.ts
│   │       ├── mapper.ts
│   │       └── provider.ts
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
local/edge redaction where possible
  ↓
Decision Gateway
  ↓
PolicyEngine.evaluate()
  │
  ├── resolved → final deterministic decision
  │
  └── unresolved
          ↓
ContextCompiler.compile()
          ↓
SemanticDecisionProvider.evaluate()
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
- ADR-003 fail behavior
- ADR-004 policy precedence
- ADR-005 provider abstraction
- ADR-006 local redaction boundary
- ADR-007 adapter ASK semantics
- ADR-008 telemetry persistence strategy
