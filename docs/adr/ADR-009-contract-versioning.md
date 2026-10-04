# ADR-009: Contract versioning and compatibility

- **Status:** Accepted
- **Date:** 2026-09-18
- **Tickets:** RFX-011
- **Supersedes:** none

## Context

The canonical contracts cross boundaries that are released on different
clocks:

- **Adapters and the CLI** are installed on developer machines. They upgrade
  slowly and there is always a long tail of old versions.
- **The decision gateway** is upgraded by whoever operates it, usually first
  and often.
- **SDKs** exist in two languages and must agree on the wire.
- **Stored decision events** are replayed against future policies, long after
  the code that wrote them is gone.

A versioning policy for a safety product can fail in two opposite ways:

1. A reader **silently ignores** something it needed to understand, and
   decides on incomplete information. That is a false allow.
2. A reader **rejects** something harmless, so every action falls back to a
   human prompt. Approval fatigue returns and REFLEX gets uninstalled.

A single rule ("be liberal in what you accept", or "be strict everywhere")
picks one of these failures for every boundary. The boundaries are not
symmetric, so the rule cannot be either.

## Decision

### 1. One version, two numbers

`CONTRACT_VERSION = { major, minor }` in `@reflex-control/contracts`.

- `major` changes on a breaking change. It is the `v1` in `/v1/decisions`.
- `minor` changes on every additive change.

The npm version of `@reflex-control/contracts` is a packaging concern and is not the
wire version: the package is released for reasons that do not touch the wire.

### 2. Direction of tolerance

**Inputs to a decision are read strictly.** `CanonicalAction`,
`DecisionRequest`, `SemanticAssessment`, `DecisionFeedback`, and policy
documents (G2). An unknown field is rejected. It is never stripped, defaulted
or repaired. The party making a safety decision does not ignore what it does
not understand (ADR-001 §2).

**Outputs of a decision are read tolerantly, within limits.**
`ReflexDecision`, including the assessment summary and policy matches nested in
it:

- unknown object keys are ignored
- unknown members of the **informational** enums, `reasonCodes` and
  `fallback.reason`, are dropped
- the **enforcement** fields, `effect`, `effectiveEffect` and `mode`, are
  closed. A value the reader does not know invalidates the whole decision, and
  the adapter falls back according to its failure mode. An unknown effect is
  never coerced to a known one.

`SemanticAssessment` is therefore read in two modes from one declaration:
strictly when REFLEX consumes what a provider returned, tolerantly when a
consumer reads it back out of a decision.

### 3. What counts as additive, and what is breaking

| Change                                                                         | Class                                  |
| ------------------------------------------------------------------------------ | -------------------------------------- |
| New optional field on an output                                                | Additive                               |
| New member of an open enum (`ReasonCode`, `FallbackReason`)                    | Additive                               |
| New runtime export, new ID prefix                                              | Additive                               |
| Loosening a limit in `CONTRACT_LIMITS`                                         | Additive                               |
| New optional field on an input                                                 | Additive, **receiver first**           |
| New member of an input enum (`HostKind`, `SideEffectClass`, `EnvironmentKind`) | Additive, **receiver first**           |
| Removing or renaming a field, an enum member or an export                      | Breaking                               |
| Optional field becomes mandatory                                               | Breaking                               |
| Changing a type, tightening a format or a limit                                | Breaking                               |
| Changing what an existing field or value **means**                             | Breaking                               |
| A new field a reader **must understand** to stay safe                          | Breaking                               |
| New member of `DecisionEffect`, `ReflexMode` or `FailureMode`                  | Breaking                               |
| Letting `adapterMetadata` influence a decision                                 | Breaking, and needs ADR-001 superseded |

**The must-ignore-safe rule.** An additive output field has to be safe to
ignore: a consumer that ignores it must never end up less safe than one that
reads it. "Allow, but only under these conditions" cannot be shipped as an
optional `conditions` field next to `effect: "allow"`, because every older
adapter would allow unconditionally. That is a change of meaning, so it is
breaking.

### 4. Deployment order

"Receiver first" means the reader is deployed before any writer starts sending
the new field or value. For inputs, the gateway goes before adapters.

The opposite skew (a newer adapter talking to an older gateway, for example a
self-hosted one) is rejected explicitly with `unrecognized_field` or
`invalid_value`, and the adapter applies its failure mode. It is loud and safe.
It is never silent.

### 5. Procedure

Additive change:

1. Make the change. Bump `CONTRACT_VERSION.minor`.
2. Copy the latest fixture directory to `fixtures/vMAJOR.MINOR/`, extend it, and
   record its checksums in `compatibility.test.ts`.
3. Never edit a released fixture directory. It is evidence of what older
   clients send.

Breaking change:

1. Write an ADR. Bump `major`, serve `/v2` next to `/v1` for a stated
   deprecation window.
2. `v1` fixtures keep being tested against the `v1` readers for as long as `v1`
   is served.

If a compatibility test fails, the change under review is breaking. Editing the
recorded expectation to make the failure disappear is not a fix.

### 6. Limits are part of the contract

`CONTRACT_LIMITS` bounds string lengths, collection sizes and the depth and
size of the two untyped bags. Validation work, log lines and stored rows are
bounded by the contract, not by an attacker. Transport limits (HTTP body size)
come on top and belong to the gateway.

### 7. Validation failures are contract too

`parse*()` functions return `ValidationResult<T>` and never throw. Issue codes
are a closed, versioned set. Messages are built from the contract and never
contain a value taken from the input, because inputs carry secrets and a
validation error is the first thing anyone logs. Key names taken from the input
appear only in `path`, sanitized and truncated.

## Consequences

### Positive

- A gateway release that adds decision fields or reason codes does not break a
  single installed adapter.
- No decision is ever made on an input REFLEX only partially understood.
- "Is this change breaking?" has a mechanical answer: run the tests.
- The frozen JSON fixtures are language-neutral, so the Python SDK (RFX-077) can
  prove wire parity against the same files.
- Replay of stored events has a defined contract to parse against.

### Negative

- **New adapter, old gateway fails.** Strict inputs make that skew a hard
  failure. Self-hosted gateways will need an upgrade-first discipline, and
  `rfx doctor` should learn to diagnose it (G9).
- **Older readers lose information.** A dropped reason code is invisible to the
  adapter that dropped it. Acceptable because those fields are informational by
  definition, but it means a reason code can never become load-bearing.
- **Two reading modes for one type** is more machinery than one schema.
- **Fixture sets accumulate**, one per minor. That is the cost of the evidence.
- **Input enums grow receiver-first only.** Adding a host means shipping the
  gateway before the adapter, always.
- **Durations are integer milliseconds** (`CLAUDE.md`). A 0.3 ms policy
  evaluation serializes as `0`. Moving to a finer unit later is a breaking
  change for strict readers, so this is worth deciding before G3 emits real
  latency numbers.

### Follow-ups

- **G3 (RFX-021):** map a request validation failure to a typed response and to
  `fallback.reason: "invalid-input"`. Never echo the rejected body.
- **G7 / G8:** adapters read decisions only through `parseReflexDecision`, and
  treat a failed parse like any other gateway failure.
- **G10 (RFX-060):** persist the contract version with every stored event.
- **G14 (RFX-077):** Python parity tests consume `packages/contracts/fixtures`.
- **Open:** an optional `contractVersion` on `DecisionRequest` would let an old
  gateway answer "you are newer than me" instead of a generic rejection. It is
  additive and can be added when `rfx doctor` needs it.
- **Open (needs ADR-002 before G3):** the relationship between `effect`,
  `effectiveEffect` and `mode` is not defined anywhere, in particular what
  `effectiveEffect` is in Observe mode. The contracts validate each field and
  deliberately enforce no relation between them.

## Alternatives considered

- **Tolerant everywhere (ignore what you do not know).** Rejected. On a
  decision input, "ignore" means deciding without information the sender
  thought relevant. It is the false-allow failure, made systematic.
- **Strict everywhere.** Rejected. Every gateway release that adds an output
  field would push all installed adapters into their failure mode at once.
- **Per-request version negotiation.** Deferred, not rejected. It is additive
  (see the open follow-up) and nothing needs it yet.
- **Use the npm package version as the wire version.** Rejected. It changes for
  reasons unrelated to the wire and would make every release look like a
  protocol event.
- **Schema-first contracts with inferred types.** Rejected. The hand-written
  interfaces are the specification people, ADRs and other-language SDKs read.
  Schemas are checked to be type-identical to them, so neither can drift, and
  the validation library stays out of the public surface.

## Enforcement

All in `packages/contracts/src/compatibility.test.ts` unless noted:

- every frozen fixture of every released minor still parses, unchanged
- released fixtures are checksum-locked
- the mandatory field set of each contract equals its v1.0 set
- every exported closed set still contains all of its v1.0 members, and the
  three decision-semantics sets are equal to them
- limits are at least their v1.0 values
- the runtime export surface equals the recorded list, and contains nothing
  that looks like a schema
- inputs reject an unknown field; the decision output ignores one
- each schema is type-identical to its interface (`toEqualTypeOf` in the
  per-contract tests), checked by `pnpm typecheck`
- bumping `CONTRACT_VERSION.minor` without adding its fixture directory fails

## References

- `CLAUDE.md`: principles 1, 5 and 10; "Coding conventions"; "Decision
  semantics"
- ADR-001: §2 exclusions, §3 adapter metadata, §5 what "frozen" means
- `docs/architecture.md`: §5 decision model, §8 policy architecture
- `packages/contracts/README.md`: public surface, limits, latency baseline
- `docs/backlog.md`: RFX-011, RFX-021, RFX-060, RFX-077
