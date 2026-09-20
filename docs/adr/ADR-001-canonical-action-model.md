# ADR-001: Canonical action model

- **Status:** Accepted
- **Date:** 2026-09-18
- **Tickets:** RFX-005
- **Supersedes:** none

## Context

REFLEX sits between an agent's intent to act and the side effect. That intent
arrives in incompatible shapes: Claude Code hook payloads, Codex `PreToolUse`
and `PermissionRequest` events, MCP tool calls, SDK `guard()` invocations, raw
HTTP requests. Everything downstream of the adapter (deterministic policy,
context compilation, semantic assessment, risk aggregation, caching, replay,
telemetry) has to reason about one thing.

Three forces make the shape of that one thing a safety decision, not a
convenience:

1. **Policy must be host-agnostic.** A rule that denies production mutation
   has to mean the same thing under every host. If host-native fields reach
   the policy engine, policies fragment per host and a rule written for one
   host silently fails to apply on another. That is a false allow.
2. **Replay must be deterministic.** Policy replay and the eval corpus are only
   meaningful if a recorded action can be re-decided later, without the host
   that produced it.
3. **Whatever enters the model is attack surface.** Tool arguments and host
   payloads are influenced by the agent and by untrusted content the agent has
   read. Every field that can influence a decision is a field an adversary
   will try to write to.

`CLAUDE.md` principle 10 already fixes the location: canonical contracts live
only in `packages/contracts`, and adapters translate into them without defining
parallel action models. This ADR freezes the boundary itself: what belongs in
`CanonicalAction`, what does not, and what the one escape hatch may and may not
do.

## Decision

REFLEX has exactly one action model, `CanonicalAction` in `@reflex/contracts`.
Adapters are the only code that sees host-native events, and the canonical
action is the only representation that crosses into domain logic.

### 1. Inclusions

A field belongs in the canonical action if it describes **what the agent
intends to do, to what, where, and on whose behalf**, in terms that are true
under any host.

| Concept (architecture §4) | Contract field                                                          | Notes                                                                                                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Action identity           | `id`, `createdAt`                                                       | `act_` opaque ID. ISO 8601 UTC.                                                                                                                                                                                                                |
| Tenancy                   | `organizationId?`, `projectId?`                                         | Optional by design: anonymous local Observe must work before an account exists (RFX-058).                                                                                                                                                      |
| Session                   | `sessionId?`                                                            | Groups actions for history selection.                                                                                                                                                                                                          |
| Actor / agent identity    | `agent.id?`, `agent.name?`, `agent.model?`                              |                                                                                                                                                                                                                                                |
| Host                      | `agent.host`, `agent.hostVersion?`                                      | Host identity is a **value** from a closed set. It is not a host-shaped structure.                                                                                                                                                             |
| User objective            | `userObjective?`, `taskSummary?`                                        | Summaries only. Never a transcript.                                                                                                                                                                                                            |
| Tool                      | `tool.name`, `tool.namespace?`, `tool.description?`                     | `namespace` carries, for example, an MCP server name.                                                                                                                                                                                          |
| Operation                 | `operation?`                                                            |                                                                                                                                                                                                                                                |
| Arguments                 | `arguments`                                                             | Untrusted. Redacted before crossing a trust boundary. Never logged raw.                                                                                                                                                                        |
| Operands (v1.2, ADR-011)  | `operands?`: `.command?` (`raw?`, `argv?`), `.paths?`, `.networkHosts?` | What the action operates on, in one shape for every host, so that a policy is not written against host-shaped `arguments`. Filled by the adapter from what the host says, never by interpreting it. Absent means unknown. Promoted under §3.7. |
| Resource                  | `resource.type?`, `resource.identifier?`                                |                                                                                                                                                                                                                                                |
| Environment               | `resource.environment`, `resource.isProduction?`                        | `unknown` is a first-class value.                                                                                                                                                                                                              |
| Side-effect class         | `sideEffectClass`                                                       | Required. Closed set. `unknown` is a first-class value.                                                                                                                                                                                        |
| Workspace                 | `cwd?`, `repository.root?`, `.branch?`, `.remoteHost?`                  | Host-agnostic facts about where a coding agent is working. Added for the coding-agent wedge.                                                                                                                                                   |
| Prior relevant actions    | `priorActions?`                                                         | Bounded summaries (`toolName`, `operation`, `effect`, `occurredAt`). Never prior arguments.                                                                                                                                                    |
| Adapter escape hatch      | `adapterMetadata?`                                                      | Opaque. See §3.                                                                                                                                                                                                                                |

**Policy context is deliberately not a field of the action.** Architecture §4
lists it among the conceptual fields; it travels on the request envelope
instead: `DecisionRequest.mode`, `.failureMode`, `.policySetHash`,
`.deadlineMs`, and `SemanticDecisionRequest.policyHints`. The action says what
the agent wants to do. The envelope says how REFLEX is configured to judge it.
Keeping them apart means the same action has the same fingerprint under two
policy sets, which is what makes cache keys (architecture §11) and replay
(architecture §8) well defined.

### 2. Exclusions

The canonical action never contains:

- **Host-native structures.** No Claude-, Codex-, MCP-, OpenAI- or
  LangGraph-shaped fields: hook event names, permission-mode flags, tool-use
  correlation IDs, JSON-RPC envelopes. Host identity is carried as the
  `agent.host` value and nothing more.
- **Provider-specific data.** No Jev (or any other provider) request,
  response, prompt, model parameter or token count.
- **Decision output.** No effect, risk, confidence, reason code or policy
  match for the action itself. Those belong to `ReflexDecision`. The `effect`
  on a `priorActions` entry is history, not a verdict on this action.
- **Request configuration.** Mode, failure mode, deadline and policy set hash
  belong to `DecisionRequest`.
- **Host approval capability or UI state.** How `ask` maps onto a host's
  native approval flow is adapter territory (ADR-007, planned).
- **Conversation content.** No transcript, message history or file contents
  beyond what the tool arguments themselves carry (`CLAUDE.md` principle 9).
- **Raw secrets.** No environment variables, auth headers, API keys, private
  keys or access tokens (architecture §10). Redaction happens locally, before
  the action crosses a trust boundary.
- **Execution results.** REFLEX decides before the side effect. What happened
  afterwards is not part of the action.

### 3. The adapter metadata escape hatch

`adapterMetadata?: Readonly<Record<string, unknown>>` exists so an adapter can
keep host-specific raw metadata next to the action it produced, for
diagnostics, for correlating a decision back to the host event, and as
evidence when deciding whether a host concept deserves promotion.

It is an escape hatch for **information**, never for **influence**:

1. **Opaque to domain logic.** The policy engine, context compiler, semantic
   provider, risk aggregator, fallback logic and cache fingerprinting do not
   read it. A policy condition whose `field` path addresses `adapterMetadata`
   is an invalid policy and is rejected when the policy is compiled.
2. **Metadata invariance.** For every action `a` and every metadata bag `m`,
   deciding `a` and deciding `{ ...a, adapterMetadata: m }` yields the same
   effect, risk and reason codes. This is the testable form of rule 1.
3. **Never sent to a semantic provider.** `SemanticDecisionRequest` selects
   fields by name and does not select `adapterMetadata`.
4. **Not part of the action fingerprint.** It cannot change a decision, so it
   must not change a cache key.
5. **Untrusted, like `arguments`.** Same redaction, logging and retention
   rules. It may contain secrets and attacker-controlled strings.
6. **JSON-serializable and small.** Because it cannot influence a decision,
   the gateway may drop it (for size or retention reasons) without changing
   any outcome.
7. **Promotion, not leakage.** When a host-specific datum turns out to matter
   for decisions, it is generalized into a host-agnostic canonical field
   through a contract change and an ADR. Example: if a host's permission mode
   ever needs to influence decisions, the canonical model gains a generic
   concept that every adapter can populate. Domain code does not start reading
   `adapterMetadata.permission_mode`.

The adversarial reading is what motivates the strictness. The bag is populated
from host payloads, which are downstream of the agent and of whatever
untrusted content the agent consumed. The moment any domain code honors a key
such as `{ "preApproved": true }`, the escape hatch is a privilege-escalation
channel that no policy can see.

### 4. Rules for adapters

- **Unknown is explicit, and unknown is never safe.** An adapter that cannot
  classify an action sets `sideEffectClass: "unknown"` and
  `resource.environment: "unknown"`. It never defaults to `none`, `local-read`
  or `local`. An absent optional field means "not known". Domain logic must
  not read absence as evidence of low risk.
- **Conflicts resolve toward the more dangerous reading.** If several
  side-effect classes apply, the adapter reports the one with the greatest
  potential harm. If `environment` and `isProduction` disagree, the action is
  treated as production.
- **Translate, do not judge.** Adapters map and classify. They do not decide,
  pre-filter or drop actions they consider harmless.
- **Arguments are passed as received**, after local redaction where possible.
  Adapters do not reshape arguments into something a policy author would not
  recognize from the host's own documentation.

### 5. What "frozen" means

Adding an optional field that satisfies §1 and violates nothing in §2 is an
additive change under the contract versioning policy (RFX-011) and needs no new
ADR. A new ADR superseding this one is required to: add a host- or
provider-specific field, remove or rename a field, change whether a field is
required, put policy context or decision output on the action, or relax any
rule in §3.

## Consequences

### Positive

- One policy language, one eval corpus and one replay path for every host.
- A new host is a new adapter. Domain packages do not change.
- The semantic provider boundary stays replaceable: nothing Jev-shaped or
  host-shaped can reach it through the action.
- The attack surface of a decision is an enumerable list of named fields.
- Actions are replayable without the originating host.

### Negative

- **Translation is lossy.** Host nuance that has no canonical field is
  invisible to policy until it is promoted. Promotion costs an ADR.
- **Adapters carry the classification burden.** A wrong `sideEffectClass` is a
  wrong input to every later stage. Classifier quality becomes safety-critical
  (G2 adversarial matcher corpus, G7/G8 adapter fixtures).
- **`sideEffectClass` is single-valued.** An action that is both
  `external-write` and `destructive` must pick one, and the "greatest potential
  harm" ordering is not yet defined anywhere. Until it is, adapters and
  reviewers carry that judgment.
- **Optional tenancy** means tenant isolation cannot be assumed from the type.
  The control-plane boundary must require `organizationId` where it matters
  (G10, G16).
- **`isProduction` duplicates `environment`.** Two sources of truth for one
  fact. §4 defines the conservative reading; removing the duplication would be
  cleaner.

### Follow-ups

Status as of Gate G1 (2026-09-18): the first item is done. `ses_` is registered
in `ID_PREFIXES`, and the `CLAUDE.md` prefix list still omits it. The other two
remain open.

- **RFX-006 / RFX-007 (G1):** runtime validation must reject, not repair,
  actions that violate §2, and must apply the §4 conflict rule. Split
  `packages/contracts/src/index.ts` into the per-concern files listed in
  architecture §2. Name the anonymous nested types (`repository`,
  `ReflexDecision.fallback`) per the `CLAUDE.md` coding conventions.
- **`ses_` prefix:** `SessionId` uses `ses_`, which is missing from the ID
  prefix list in `CLAUDE.md`. Reconcile in G1.
- **Severity order for `sideEffectClass`:** define it alongside the command
  classifier (G2), or make the field multi-valued through a superseding ADR.
- **ADR-005 (planned):** `SemanticDecisionProvider` and `DecisionEngine`
  currently live in `@reflex/contracts`, while `packages/semantic-provider` is
  described as owning the provider interface. Decide the home before G4.

## Alternatives considered

- **A union of per-host action types.** Rejected: host shape leaks into every
  domain package, policies fragment per host, and adding a host becomes a
  domain change. It inverts the dependency direction `CLAUDE.md` requires.
- **Pass the raw host payload through with a thin wrapper.** Rejected: nothing
  bounds what reaches the semantic provider or storage, replay depends on host
  schemas REFLEX does not control, and redaction would have to understand every
  host format.
- **No escape hatch at all.** Rejected: adapters lose the ability to correlate
  decisions with host events, diagnostics lose the raw context, and the
  pressure to add "just one" host field to the canonical model goes up.
- **Typed, per-host metadata (a discriminated union keyed by host).**
  Rejected: `packages/contracts` would depend on host schemas that change
  outside REFLEX's release cycle, and typed metadata invites domain code to
  read it. Opacity is the point.

## Enforcement

In place as of Gate G0:

- `contracts -> anything` and the other forbidden dependency directions are
  enforced by `eslint.config.mjs` and by `tests/workspace.test.ts` against
  every package manifest. No adapter or provider type can be imported into
  `packages/contracts`.
- `SemanticDecisionRequest` structurally excludes `adapterMetadata`.

Owed by later gates (each is an acceptance-level obligation of that gate):

- **G1 (RFX-007):** schema tests proving host- or provider-specific keys are
  not part of `CanonicalAction`, and that `adapterMetadata` must be a plain
  JSON object.
- **G2 (RFX-013):** the policy compiler rejects any condition whose field path
  addresses `adapterMetadata`, with an adversarial test for path tricks
  (`adapterMetadata.x`, bracket and case variants).
- **G3 (RFX-019) and G6 (RFX-039):** a metadata-invariance property test in the
  decision engine and a corpus case in the eval harness, including a hostile
  bag such as `{ "preApproved": true, "sideEffectClass": "none" }`.
- **G5 (RFX-033):** compiler output never contains `adapterMetadata`.
- **G7 / G8:** adapter fixture tests assert that unclassifiable actions map to
  `unknown`, never to a benign class.

## References

- `CLAUDE.md`: principles 3, 5, 9 and 10; "Architectural dependency
  direction"; "Coding conventions"
- `docs/architecture.md`: §3 request lifecycle, §4 canonical action model, §8
  policy architecture, §10 privacy model, §11 caching
- `packages/contracts/src/index.ts`: `CanonicalAction`, `DecisionRequest`,
  `SemanticDecisionRequest`
- `docs/backlog.md`: RFX-005, RFX-006, RFX-007, RFX-011, RFX-013, RFX-058
