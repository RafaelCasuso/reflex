# CLAUDE.md — REFLEX Engineering Operating System

## Product identity

**REFLEX**  
**The autonomy control layer for AI agents.**  
**More autonomy. Less supervision.**

REFLEX sits between an AI agent's intent to act and the side effect itself. It decides whether an action should be:

- `ALLOW` — execute without human interruption.
- `ASK` — defer to the host agent's native human-approval mechanism.
- `DENY` — block execution.

REFLEX is not an agent framework, generic guardrail platform, observability product, IAM replacement, or chatbot.

The product exists to maximize **safe autonomous actions** while minimizing unnecessary human supervision.

---

## North-star metric

`safe_autonomous_actions`

Supporting product metrics:

- autonomy rate
- human intervention rate
- deny rate
- human override rate
- false allow rate
- false deny rate
- p50/p95 decision latency
- governed actions per active agent
- active protected agents
- suggested policies accepted
- approval prompts eliminated

Never optimize autonomy rate by weakening safety.

---

## Engineering principles

### 1. Hot-path discipline

REFLEX is in the execution path of an agent. Every millisecond matters.

Latency budgets:

- deterministic policy decision: p95 < 10 ms
- cached semantic decision: p95 < 20 ms
- semantic decision target: p50 < 150 ms, p95 < 400 ms
- REFLEX infrastructure overhead excluding inference: p95 < 25 ms

Do not add network calls, serialization steps, databases, tracing exporters, or framework layers to the hot path without explicitly measuring their impact.

### 2. Deterministic first, semantic second

Never call a model if deterministic policy can resolve the action.

Decision order:

1. normalize action
2. redact secrets locally
3. evaluate deterministic policies
4. return immediately if resolved
5. compile minimal semantic context
6. run semantic assessments
7. aggregate assessment into final decision
8. emit telemetry outside the critical path whenever possible

### 3. Jev is a provider, not the architecture

Semantic inference must depend on the `SemanticDecisionProvider` interface.

No Jev-specific types may leak outside the provider package.

Initial provider:
- `JevSemanticDecisionProvider`

Potential future providers:
- local provider
- LLM provider
- customer-managed provider

### 4. ASK is native delegation

`ASK` means: let the host agent use its native approval flow.

Adapters must not create custom dialogs when the host already has a permission system.

Different hosts expose different capabilities. Preserve the canonical REFLEX decision internally, then map it safely to the host's supported semantics.

### 5. Fail explicitly

REFLEX may never silently disappear from the execution path.

Every adapter must define behavior for:

- timeout
- network failure
- malformed response
- unavailable semantic provider
- invalid policy
- unsupported host operation

Supported fallback classes:

- `fail-open`
- `fail-ask`
- `fail-closed`

Default behavior:
- known low-risk read/local actions may defer to host behavior
- unknown, external, destructive, financial, credential, privilege, or production actions must fall back to human approval or denial

### 6. Policy cannot silently weaken

Local policies, organization policies and managed policies have an explicit precedence model.

A lower-precedence policy must never weaken a mandatory higher-precedence deny rule.

Every policy resolution must be explainable through:
- matched rules
- precedence
- final effect

### 7. Security-sensitive code requires tests

Any change touching these packages requires unit tests and at least one adversarial test:

- policy engine
- command classifier
- redaction
- context compiler
- semantic aggregation
- adapters
- auth
- tenant isolation

### 8. No opaque learning

Approval Learning may propose policy changes.

It may not silently alter enforcement.

Workflow:

observation → cluster → suggestion → replay → human acceptance → policy change

### 9. Minimal context

Do not pass full conversations to the semantic provider unless a test proves they are required.

Target median semantic input: < 600 tokens.

Prefer:
- task summary
- action
- resource
- environment
- relevant prior actions
- applicable policy metadata

### 10. Source-of-truth contracts

Canonical contracts live only in:

`packages/contracts`

Adapters translate host-native events into canonical contracts. They do not define parallel action models.

---

## Monorepo rules

Use:

- TypeScript strict mode
- Node.js current LTS
- pnpm workspaces
- Turborepo
- ESLint
- Prettier
- Vitest
- Zod at external/runtime boundaries only
- PostgreSQL for transactional control-plane data
- ClickHouse only when telemetry volume justifies it
- Redis only for measured latency/caching requirements

Do not introduce:
- Kafka
- Kubernetes
- microservices
- event buses
- multiple databases
- CQRS
- service mesh

until an actual measured constraint requires them.

The initial system should be a modular monolith plus a separately deployable decision gateway if latency/isolation requires it.

---

## Repository boundaries

### `apps/api`
Control-plane HTTP API.
No host-specific parsing.

### `apps/dashboard`
User interface.
Never contains authorization logic.

### `apps/decision-gateway`
Latency-sensitive runtime decision endpoint.
Must remain deployable independently of dashboard/control-plane concerns.

### `packages/contracts`
Canonical public/internal schemas.

### `packages/core`
Decision orchestration and domain logic.

### `packages/policy-engine`
Pure deterministic policy evaluation.

### `packages/context-compiler`
Minimal semantic context construction and local redaction pipeline.

### `packages/semantic-provider`
Provider interface.

### `packages/provider-jev`
Jev implementation only.

### `packages/adapter-*`
Host-specific translation only.

### `packages/cli`
Installation, detection, configuration and diagnostics.

### `packages/evals`
Regression corpus and autonomy/safety evaluation harness.

---

## Architectural dependency direction

Allowed:

`adapter -> contracts`
`adapter -> sdk`
`gateway -> core`
`core -> contracts`
`core -> policy-engine`
`core -> context-compiler`
`core -> semantic-provider`
`provider-jev -> semantic-provider`
`dashboard -> api client`

Forbidden:

`core -> adapter-*`
`policy-engine -> provider-*`
`contracts -> anything`
`dashboard -> database`
`adapter -> provider-jev`
`provider-jev -> core`

Keep the domain independent from integrations.

---

## Coding conventions

- Prefer named types over anonymous nested object types.
- No `any`.
- No non-null assertions without a comment explaining the invariant.
- Use exhaustive `switch` on discriminated unions.
- All timestamps are ISO 8601 UTC at service boundaries.
- IDs use prefixed opaque IDs (`dec_`, `act_`, `pol_`, `agt_`, `org_`, `prj_`).
- Money uses integer minor units.
- Risk is integer `0..100`.
- Confidence is float `0..1`.
- Durations in contracts are integer milliseconds.
- Public enums are lowercase string literals.
- Avoid throwing for expected domain outcomes.
- Domain outcomes return typed result objects.
- Never log raw tool arguments before redaction.

---

## Decision semantics

Final decisions:

```ts
type DecisionEffect = "allow" | "ask" | "deny";
```

Decision precedence:

`deny > ask > allow`

A deterministic explicit deny cannot be overridden by semantic inference.

A semantic provider must never directly mutate or execute an action.

Semantic assessments are evidence. The aggregator owns the decision.

---

## Risk model

Initial risk dimensions:

- objective alignment
- destructiveness
- reversibility
- external side effect
- privilege escalation
- secret access
- sensitive data
- financial consequence
- production mutation
- unusual scope
- untrusted input
- policy conflict
- semantic uncertainty

Keep dimension values independent. Do not compress everything into one model prompt asking “is this safe?”

---

## Testing requirements

Every ticket must satisfy relevant layers:

### Unit
Pure domain behavior.

### Contract
Serialization/deserialization and compatibility.

### Adapter fixture tests
Known host payload → canonical action → expected host response.

### Adversarial
At least one test designed to make REFLEX allow something it should not.

### Latency
For hot-path code, benchmark before/after.

### Replay
Policy/aggregator changes must run against the golden decision corpus.

---

## Pull request checklist

Before considering a ticket complete:

- acceptance criteria met
- tests pass
- lint passes
- typecheck passes
- no secrets logged
- decision semantics unchanged unless ticket explicitly changes them
- docs updated
- telemetry added if behavior is operationally significant
- no unnecessary dependency introduced
- migration is reversible where applicable

---

## Product modes

Canonical modes:

- `observe`: evaluate and record, never affect execution
- `assist`: automatically allow sufficiently safe actions; uncertain/high-risk actions use native host approval
- `autopilot`: enforce allow/ask/deny

Adapters must preserve these semantics.

---

## UX rules

The user should reach first value before account creation whenever technically possible.

Primary onboarding target:

`rfx init`

Expected outcome:
1. detect supported agents
2. detect supported MCP configurations
3. back up modified configuration
4. install adapter/hook
5. create `.reflex/policy.yaml`
6. start Observe mode
7. show immediate local status
8. provide optional claim/login URL

Never make the user build a policy before REFLEX can observe.

---

## Scope control

Do not build unless explicitly required by a ticket:

- generic agent orchestration
- prompt playground
- generic LLM tracing
- vector database abstraction
- user-facing workflow builder
- SIEM
- IAM replacement
- generic secrets manager
- full SOC dashboard
- custom approval chat UI for supported hosts

---

## Working protocol for Claude Code

For each ticket:

1. Read the ticket and linked ADR/docs.
2. Identify affected package boundaries.
3. State implementation assumptions in the PR/commit description.
4. Write/update tests first for decision-sensitive changes.
5. Implement the smallest complete solution.
6. Run:
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
7. Run relevant replay/eval suite.
8. Update ticket status and docs.
9. Do not start the next gate until all exit criteria of the current gate pass.

If a ticket conflicts with this file, this file wins unless the ticket explicitly updates `CLAUDE.md`.

If a product decision is missing, prefer the option that:
1. minimizes adoption friction,
2. keeps REFLEX out of the agent framework,
3. preserves safe fallback behavior,
4. is reversible,
5. keeps future providers/integrations replaceable.
