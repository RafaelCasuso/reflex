# ADR-016: Decision model providers, shadow mode and decision records

- **Status:** Proposed
- **Date:** 2026-09-22
- **Tickets:** RFX-140, RFX-141, RFX-142, RFX-143, RFX-144, RFX-145, RFX-146, RFX-147
- **Supersedes:** none

## Context

REFLEX will use three kinds of decision model: Jev (TypeSafe, hosted,
today's bootstrap), Laya (Convai Innovations, open weights, Python, no
HTTP API of its own) and RDM, the Reflex Decision Model (proprietary,
ModernBERT-large with decision heads, to be trained). The long-term
architecture must not depend on Jev, RDM must be developed without
risking production decisions, and every useful decision must be able to
become training data.

`docs/rdm/gate-0-assessment.md` found that the abstraction already exists:
`SemanticDecisionProvider` (ADR-005), the eleven-dimension
`SemanticAssessment`, the stage order of ADR-002 in which a model is only
called for what policy leaves open, and an engine that applies the
untrusted floor and `deny > ask > allow` after any aggregator. Jev is not
wired to anything; nothing Jev-shaped exists outside `packages/provider-jev`.

What does not exist: a way to choose a provider, a way to run a second one
whose answer is recorded and never used, and a record that joins what was
sent, what each model answered, what REFLEX decided and what the human and
the host then did, with the provenance of every label.

## Decision

Proposed; the maintainer decides.

### 1. One interface, three kinds of provider, one vocabulary

REFLEX keeps `SemanticDecisionProvider` as the only model interface and
`SemanticAssessment` as the only model output. The briefing's
`DecisionModel`, `ReflexEvaluationRequest`, `ModelEvaluation` and
execute/escalate/deny are read as the names of these, not as new types
(assessment §3). An assessment is evidence; the aggregator owns the effect.
A model output that names an effect (execute, escalate, deny probabilities)
is not a dimension: if RDM grows such a head it travels in an optional
`recommendation` field of the assessment, and the aggregator may weigh it
and may not defer to it.

Providers are packages behind that interface:

| Provider id | Package                          | What it talks to                                                                                                                                                                                            |
| ----------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jev`       | `packages/provider-jev`          | TypeSafe's API, with the user's key or the hosted gateway's                                                                                                                                                 |
| `local`     | `packages/provider-local`        | a local inference server that speaks the canonical contract (`POST /v1/assess`: `SemanticDecisionRequest` in, `SemanticAssessment` out). RDM and Laya are checkpoints behind it; REFLEX does not know which |
| `reflex`    | `packages/provider-reflex` (G14) | the hosted REFLEX gateway: RDM as a service, needs an account                                                                                                                                               |
| `fake`      | `packages/semantic-provider`     | tests and development (RFX-029)                                                                                                                                                                             |

The daemon selects with `--semantic-provider none|jev|local|reflex`;
`none` is today's behavior and the default. A provider's model name and
version are recorded on every assessment, pinned, never an alias.

### 2. The order stays policy first

The model is called only for actions policy leaves open (ADR-002 §1,
`CLAUDE.md` principle 2). The refund threshold of the first scenario family
is a policy rule, decided before any model runs. What a model learns is the
evidence around the rule, never the rule.

### 3. Shadow evaluation

`SemanticStage.shadow` names providers that are evaluated alongside the
primary one and whose answers are recorded and never used:

- A shadow provider receives the same `SemanticDecisionRequest` as the
  primary, is called concurrently, and has its own deadline. The decision
  returns when the primary is done; a shadow answer that arrives later is
  still recorded, one that never arrives is counted.
- Nothing a shadow returns, or fails to return, changes `effect`, `risk`,
  `confidence`, `reasonCodes`, `fallback` or latency. A test holds every
  field of the decision equal with and without shadows, for a shadow that
  answers the opposite, one that hangs and one that throws.
- Shadows run where the primary runs: on unresolved actions. Running a
  shadow on actions policy resolved would give free labels
  (`deterministic_rule`) and is allowed only for a `local` provider,
  because ADR-010 promises that the arguments of a resolved action never
  leave the machine. Off by default (`--shadow-sample unresolved|all`).
- With no shadow configured the engine's path is byte for byte what it is
  today.

### 4. Decision records

A `DecisionRecord` is an additive contract (version 1.3, ADR-009) and the
unit of training data:

```text
DecisionRecord
  decisionId, actionId, recordedAt, contractVersion
  request?     the SemanticDecisionRequest that was sent, after redaction
               (ADR-006); absent until the redactor exists (RFX-031)
  evaluations  [{ provider, model, version, role: primary | shadow,
                  assessment | error, latencyMs }]
  decision     effect, effectiveEffect, mode, risk, confidence, reasonCodes,
               policyMatches, policySetHash, fallback
  labels       [{ dimension | effect, value, source, at }]
  outcome?     ActionOutcome (ADR-013), appended later by actionId
  feedback?    DecisionFeedback[], appended later by decisionId
```

`labels[].source` is closed and every label carries one:
`deterministic_rule` (a rule or a policy default resolved it),
`synthetic_rule` (a generator's rule), `llm_teacher`, `human` (an outcome's
`humanResponse`, or feedback), `production_outcome` (what the host did).
Labels of different sources are never merged into one.

Records are written after the answer, off the decision path, to a local
size-rotated log with the retention ADR-008 already gives redacted semantic
context: 7 days. They reach the control plane only with consent (RFX-123),
through the persistence RFX-060 already plans, and there for 30 days. The
never-stored list (ADR-008 §3) applies to records, and the canary test
covers them.

### 5. RDM is a private Python module with a public API

`rdm/` at the repository root, Python, managed with `uv`, private under
ADR-015:

```text
rdm/
  schema/        the dataset record, generated from the contract's fixtures
  generators/    scenario families; the first is payment refunds
  dataset/       provenance, splits; benchmark and training never share a
                 seed, a template or an entity
  benchmark/     run through packages/evals' runner against the real engine
  training/      later; ModernBERT-large with decision heads
  inference/     later; the server packages/provider-local talks to, which
                 also loads Laya
```

Its only contract with the product is the canonical one: the inference
server accepts a `SemanticDecisionRequest` and returns a
`SemanticAssessment`. Nothing in TypeScript imports from `rdm/`.

### 6. Taxonomy

The eleven dimensions are the taxonomy (assessment §6). Policy compliance
is not a dimension: it is decided, not predicted. A twelfth dimension
(blast radius) is added only if the refund data shows it is not derivable
from `productionMutation` and `unusualScope`, and then additively.

### 7. Labels in the first dataset

Training labels are dimension vectors from the generator's rules, a
teacher or a person. Benchmark labels are effects produced by running each
generated case through the real policy engine with the scenario's policy
and a fixed aggregator configuration. A counterfactual pair differs in one
variable and flips the effect end to end. The two never mix (assessment
§7).

## Consequences

### Positive

- RDM, Laya and any customer model plug into the slot Jev uses, and
  switching is configuration.
- RDM can be developed against production traffic without a single
  decision depending on it.
- Training data has provenance from the first record, and the same record
  feeds approval learning (G12) and the decision timeline (G10).

### Negative

- A shadow call costs what a call costs: a local one costs CPU, a remote
  one money and, if sampled on resolved actions, the promise of ADR-010.
  Hence local-only for that.
- One more contract, one more log, one more retention row to purge.
- Two label kinds in one dataset is a discipline, and disciplines erode;
  the split rule has to be a test.

### Follow-ups

- RFX-141 to RFX-147 in `docs/backlog.md`, R0.
- RFX-025 gives the interface its typed result; core's `assess()` becomes
  an exhaustive switch.
- RFX-060 ingests records; RFX-123 gates it on consent.

## Alternatives considered

- **Adopt the briefing's schemas.** They restate ours with policy inside
  the model's input and effects inside its output, which is the coupling
  the briefing itself says to avoid.
- **A separate "training event" pipeline apart from telemetry.** Two writers
  of the same facts drift; one record, appended to, does not.
- **RDM as a TypeScript package.** The model is Python; only its API is
  ours to define, and it is already defined.
- **Laya as its own provider package.** It has no API; it is a checkpoint
  for the same local server RDM needs.

## Enforcement

- RFX-142: the equality test over every decision field with and without
  shadows; a shadow that would allow a deny leaves `deny`.
- RFX-143: the canary test extended to records; a record with a label
  without a source fails to parse.
- RFX-145: a test that no benchmark seed, template or entity appears in a
  training split.
- The boundary test: nothing in `packages/` or `apps/` imports from `rdm/`.

## References

- `CLAUDE.md`: principles 2, 3, 8, 9; "Risk model"; "Decision semantics"
- ADR-002, ADR-005, ADR-006, ADR-008, ADR-009, ADR-010, ADR-013, ADR-015
- `docs/rdm/gate-0-assessment.md`, `docs/jev-provider.md`
