# RDM Gate 0: architecture assessment

The RDM briefing asks, before any structural change, for an assessment of
the code as it is: what decides today, where Jev is coupled, what to reuse,
what to change, which files, and a migration order that keeps behavior. This
is that assessment, written on 2026-09-22 against `main` at `641686c` (G3
closed). It is the input for ADR-015 (open core) and ADR-016 (decision model
providers and shadow mode), and for the R0 tickets in `docs/backlog.md`.

The briefing was written for a codebase "partially implemented around Jev"
and says not to assume the target architecture already exists. The first
finding is that most of it does, under other names, and that Jev is not
coupled to anything. The second is that where the briefing and the code
disagree, the code is following `CLAUDE.md`, and the briefing's own rules
say to keep it.

## 1. What decides today

Everything below is on `main` and tested.

```text
host event
  ↓ adapter (packages/adapter-claude-code)          host payload → CanonicalAction (ADR-001)
  ↓ hook client → local daemon (apps/decision-gateway, ADR-010)
  ↓ DecisionRequest, validated strictly (ADR-009)
  ↓ createDecisionEngine (packages/core, ADR-002 §1)
      1. evaluatePolicy (packages/policy-engine + command-classifier)   resolved → done
      2. defaults.unresolved: ask | deny → done; semantic → continue
      3. semantic stage: ContextCompiler → SemanticDecisionProvider → RiskAggregator
      4. fallback (ADR-003) when a needed stage could not complete
  ↓ ReflexDecision: effect, effectiveEffect (mode table), risk, confidence, reasons, matches, latency
  ↓ telemetry after the answer (packages/telemetry): decision, fallback, rejected events
  ↓ ActionOutcome (ADR-013) assembled later from host signals, keyed by actionId
```

The three seams of the semantic stage are typed and empty
(`packages/core/src/semantic-stage.ts`): `ContextCompiler` is G5,
`SemanticDecisionProvider` is G4, `RiskAggregator` is G6. With no stage
configured, every action policy leaves open is `ask`, with confidence 0 and
no fallback, because nothing failed. The engine applies the floor of an
untrusted policy set (ADR-012) and `deny > ask > allow` after the aggregator,
so no provider and no aggregator can produce an `allow` that policy would
not.

## 2. Where Jev is coupled

Nowhere. `packages/provider-jev/src/index.ts` exports nothing. What exists
is:

- `packages/provider-jev/live/probe-latency.mjs` and its record: the RFX-107
  measurement (one request, eleven questions, p50 264 ms, $0.07 per 1,000
  actions).
- `docs/jev-provider.md` §3: what the Jev-to-contract mapping must get right
  when RFX-027 writes it (no confidence on a `noul`, `confidence` is
  concentration not reliability, coarse scale, pin the model, partial output
  is a failure, no retry on the decision path).
- `packages/core` depends on the interface in `packages/contracts` and on
  nothing Jev-shaped; the boundary test forbids `core -> provider-jev`,
  `provider-jev -> core` and `adapter -> provider-jev`, and ESLint refuses
  the imports.

So there is no behavior to preserve by refactoring. There is a provider to
build, in G4, behind an interface that already exists. The briefing's
critical rule ("do not remove Jev, do not break existing functionality") is
satisfied by construction; the work is to add, not to extract.

## 3. What the briefing describes, in this codebase's terms

| Briefing                                                                       | Here                                                                                                                                                                                                                                                                                                                                                          | Verdict                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DecisionModel.evaluate(request)`                                              | `SemanticDecisionProvider.evaluate(request, signal)` (contracts; moves to `packages/semantic-provider` in RFX-025 with a typed `ProviderResult`, ADR-005)                                                                                                                                                                                                     | exists; keep the name, it says what the thing does: it assesses, it does not decide                                                                                                                                          |
| `JevDecisionModel implements DecisionModel`                                    | `JevSemanticDecisionProvider` in `packages/provider-jev` (RFX-026, RFX-027)                                                                                                                                                                                                                                                                                   | to build, G4                                                                                                                                                                                                                 |
| `ReflexEvaluationRequest` (agent, action, context, policies)                   | `CanonicalAction` + `DecisionRequest` (ADR-001), and at the provider boundary `SemanticDecisionRequest`: the fields selected by name, redacted (ADR-006), under a token budget (principle 9)                                                                                                                                                                  | exists; the briefing's schema is not adopted. `trustLevel`, `permissions` and `policies` on the request are what ADR-001 §3 keeps out of the model's input on purpose: policy is decided by the policy engine, not predicted |
| `ModelEvaluation` (probabilities, impact, reversibility, uncertainty)          | `SemanticAssessment`: eleven independent dimensions, each `{ value, confidence }`, plus `provider`, `model`, `latencyMs`                                                                                                                                                                                                                                      | exists; a dimension the model cannot fill is a failure, never a default (ADR-005 §3). `executeProbability` and friends are effect-shaped outputs and are deliberately not in it: the aggregator owns the effect              |
| EXECUTE / ESCALATE / DENY                                                      | `allow` / `ask` / `deny`; `ask` is the host's native approval (ADR-002, ADR-007)                                                                                                                                                                                                                                                                              | same three, keep ours: closed on the wire since contract 1.0 (ADR-009)                                                                                                                                                       |
| Model → Policy Engine → decision                                               | Policy engine → (unresolved only) model → aggregator, then floors and precedence                                                                                                                                                                                                                                                                              | keep ours. `CLAUDE.md` principle 2: never call a model if deterministic policy can resolve the action. The briefing's own step 4 ("do not encode organization policy into RDM") is the same principle                        |
| "separate prediction from enforcement"                                         | "assessments are evidence; the aggregator owns the decision" (`CLAUDE.md`, ADR-002 §1)                                                                                                                                                                                                                                                                        | same rule, already load-bearing                                                                                                                                                                                              |
| `DecisionModelProvider = jev                                                   | rdm                                                                                                                                                                                                                                                                                                                                                           | shadow`                                                                                                                                                                                                                      | daemon configuration, RFX-141 (ADR-016 §2) | to build |
| shadow evaluation                                                              | not present                                                                                                                                                                                                                                                                                                                                                   | to build, RFX-142 (ADR-016 §3)                                                                                                                                                                                               |
| `DecisionEvent` for training (input, evaluations, decision, override, outcome) | three of its five parts exist as contracts: `ReflexDecision` (with `semanticAssessment`), `ActionOutcome` (ADR-013, by `actionId`), `DecisionFeedback` (by `decisionId`). The telemetry `DecisionEvent` (RFX-023) deliberately carries no content. Missing: the redacted request that was sent, the evaluations of every provider, and labels with provenance | to build as an additive contract, `DecisionRecord`, RFX-143 (ADR-016 §4). Persistence is what RFX-060 already plans, with consent (RFX-123)                                                                                  |
| autonomy taxonomy                                                              | the eleven dimensions of `SemanticAssessment` (`CLAUDE.md` "Risk model")                                                                                                                                                                                                                                                                                      | exists; §6 maps the briefing's ten onto them. No contract change                                                                                                                                                             |
| `/rdm` module                                                                  | not present                                                                                                                                                                                                                                                                                                                                                   | to build, `rdm/` at the repository root, Python, private (ADR-015, ADR-016 §5)                                                                                                                                               |
| refund scenario generator, counterfactual pairs                                | not present; `packages/evals` has the deterministic corpus (79 cases) and the replay runner                                                                                                                                                                                                                                                                   | to build, RFX-146, with the labelling rule in §7                                                                                                                                                                             |

## 4. What to reuse

- The canonical action model and the decision contract as they are. A
  refund is `tool: { name: "refunds.create", namespace: "stripe" }`,
  `arguments: { amount, currency, charge }`, `sideEffectClass: "financial"`,
  `resource.environment`. Nothing new is needed to represent the first
  scenario family.
- The stage order and the engine's seams. RDM plugs into the same
  `SemanticDecisionProvider` slot as Jev; shadow mode is one more field on
  the semantic stage.
- `ActionOutcome` and `DecisionFeedback` as the two sources of human and
  production labels, already keyed so that they can be joined to a decision
  after the fact (ADR-013 chose that on purpose).
- ADR-008's retention table, which already has the row the training record
  needs: redacted arguments and redacted semantic context, 7 days locally,
  30 days on the control plane, off until consent.
- `packages/evals`: the corpus format, the replay runner and the rule that
  a dangerous case allowed fails CI. The refund benchmark is one more corpus
  run through the same runner.
- The provider measurement discipline of RFX-107: a live probe with `--run`,
  a checked-in record, a test that holds the document to it.

## 5. What to change, and what not to

Change:

1. **Provider selection and shadow evaluation in the engine and the daemon**
   (RFX-141, RFX-142). Small: an option on `SemanticStage`, a few lines in
   `decide`, a flag on the daemon.
2. **A `DecisionRecord` contract and a local record log** (RFX-143): the
   join of what was sent, what every provider answered, what REFLEX decided,
   and, appended later, what the human and the host did. Labels carry
   provenance. Additive contract change, version 1.3.
3. **A second open provider package, `packages/provider-local`** (RFX-144):
   a client for a local inference server that speaks the canonical contract.
   RDM and Laya are checkpoints behind that server; REFLEX does not know
   which.
4. **`rdm/`**, Python, private, with the dataset schema, the first
   generator and the benchmark split rule (RFX-145, RFX-146). No model.

Do not change:

- The order policy-then-model. The briefing draws model-then-policy; the
  difference is which one runs first, and running the model first calls it
  on every action, against principle 2 and against the measured cost.
- The assessment's shape. Effect-like model outputs (execute, escalate, deny
  probabilities) would let a model decide. If RDM grows a head that
  recommends an effect, it is one more signal the aggregator weighs, carried
  in a separate optional field, never a decision.
- The vocabulary. `allow`/`ask`/`deny` and the eleven dimensions are frozen
  on the wire; "execute/escalate/deny" and the briefing's request schema
  stay in the briefing.

## 6. Taxonomy: the briefing's ten dimensions on the contract's eleven

| Briefing              | Contract dimension(s)                   | Note                                                                                                           |
| --------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| authorization         | `privilegeEscalation`                   |                                                                                                                |
| financial exposure    | `financialConsequence`                  | the amount relative to exposure is context the compiler supplies, not a threshold the model learns             |
| blast radius          | `productionMutation`, `unusualScope`    | a twelfth dimension only if the refund data shows it is not derivable; additive under ADR-009                  |
| reversibility         | `reversibility`                         |                                                                                                                |
| destructive action    | `destructiveRisk`                       |                                                                                                                |
| external side effects | `externalSideEffect`                    |                                                                                                                |
| data sensitivity      | `sensitiveDataExposure`, `secretAccess` |                                                                                                                |
| policy compliance     | none, on purpose                        | compliance is decided exactly by the policy engine; the model receives `policyHints` and never predicts a rule |
| scope                 | `unusualScope`, `objectiveAlignment`    |                                                                                                                |
| uncertainty           | `confidence` on every dimension         | calibrated per dimension (RFX-110)                                                                             |

## 7. The refund scenario and the trap it contains

"Refund €50, automatic approval up to €100, execute; refund €5,000,
escalate" is a threshold rule. In REFLEX that is one line of policy
(`arguments.amount` against the organization's limit), decided
deterministically, before any model runs, and it is exactly what the
briefing's step 4 says not to bake into RDM.

So the refund dataset has two kinds of label, kept apart:

- **Training labels are dimension vectors**, not effects: the fraud
  indicators, the customer history and the previous refunds move
  `untrustedInput`, `unusualScope` and `financialConsequence`; whether a
  refund can be clawed back moves `reversibility`. Source: `synthetic_rule`
  for the generator's own rules, `llm_teacher` where a model labels, `human`
  where a person does. That is what RDM learns.
- **Benchmark labels are effects**, produced by running the generated case
  through the real policy engine with the scenario's policy and a fixed
  aggregator configuration. Source: `deterministic_rule`. A counterfactual
  pair differs in one variable and must flip the effect end to end. That
  is what proves the pipeline, and it never enters training.

The benchmark set is written into a separate file from the first commit,
with a split rule that no generator seed, template or entity appears in
both. Mixing them once is enough to make every later number worthless.

## 8. Files and packages affected

| Where                                 | Change                                                                                                              | Ticket                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `packages/semantic-provider`          | the interface, `ProviderResult`, a fake provider, a provider registry                                               | RFX-025, RFX-029, RFX-141 |
| `packages/core/src/semantic-stage.ts` | `shadow?: readonly SemanticDecisionProvider[]`; `decision-engine.ts`: concurrent shadow calls, recorded, never used | RFX-142                   |
| `packages/contracts`                  | `DecisionRecord` (v1.3, additive), fixtures frozen                                                                  | RFX-143                   |
| `packages/telemetry`                  | `RecordLog` (7 days, ADR-008), join by `actionId` and `decisionId`                                                  | RFX-143                   |
| `apps/decision-gateway`               | `--semantic-provider`, `--shadow`, the record written after the answer                                              | RFX-141, RFX-143          |
| `packages/provider-jev`               | the Jev provider, as planned                                                                                        | RFX-026, RFX-027          |
| `packages/provider-local` (new)       | client for a local inference server on the canonical contract                                                       | RFX-144                   |
| `rdm/` (new, private)                 | dataset schema with provenance, refund generator, benchmark split, CI job                                           | RFX-145, RFX-146          |
| `docs/adr`                            | ADR-015 open core, ADR-016 providers and shadow mode                                                                | RFX-139, RFX-140          |

## 9. Migration order that keeps behavior

Every step leaves `main` green and the product working as before; none
removes anything.

1. ADR-015 and ADR-016 accepted (RFX-139, RFX-140). Nothing runs differently.
2. RFX-025 and RFX-029: the interface moves, gets a typed result and a fake.
   Core's `assess()` becomes an exhaustive switch. Tests already run
   offline; they keep running offline.
3. RFX-141: provider registry and daemon flags. Default `none`, which is
   today's behavior exactly.
4. RFX-142: shadow evaluation. Off by default; with no shadow provider
   configured the engine's path is byte-for-byte what it is now, held by the
   existing tests.
5. RFX-143: `DecisionRecord` and the local record log. Written after the
   answer, like telemetry; with the canary test extended to it. Until the
   redactor exists (RFX-031, G5) the record carries no request content, and
   the field is optional so that nothing is invented.
6. RFX-026, RFX-027: the Jev provider, first real provider, `provider: jev`.
7. RFX-144: `provider-local` with a fake server in tests. RDM and Laya can
   now plug in; neither exists yet.
8. RFX-145, RFX-146: `rdm/` schema, refund generator, counterfactual pairs,
   benchmark split, tests. No model is trained.

After 8, every criterion of the briefing's "RDM Gate 0" holds, and the
gate's own exit in the backlog says which test holds each.
