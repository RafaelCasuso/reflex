# ADR-005: Provider abstraction

- **Status:** Accepted
- **Date:** 2026-09-20
- **Tickets:** RFX-115, RFX-025, RFX-026, RFX-027, RFX-029
- **Supersedes:** none

## Context

`CLAUDE.md` principle 3: semantic inference depends on the
`SemanticDecisionProvider` interface, and no Jev-specific type leaks outside
the provider package. The layout gives that interface a home,
`packages/semantic-provider`. Today it lives in `packages/contracts`, next to
`DecisionEngine`, and its own comment says this ADR has to settle where it
belongs.

The interface returns `Promise<SemanticAssessment>`, so every failure is a
rejected promise with an untyped reason. `CLAUDE.md` asks the opposite: "avoid
throwing for expected domain outcomes; domain outcomes return typed result
objects". A provider that is down is an expected outcome.

RFX-107 measured the first real provider and added two facts: how many
requests an assessment takes is a property of the provider (one for Jev, where
eleven were assumed), and a provider may not supply everything the contract
requires (Jev gives no confidence for a yes/no answer).

## Decision

Accepted by the maintainer on 2026-09-20, as recommended when it was proposed.

### 1. Where things live

- **Data stays in `packages/contracts`:** `SemanticAssessment`,
  `SemanticSignal`, `SemanticDecisionRequest`. An assessment is part of a
  decision and crosses the wire.
- **Behavior moves out.** `SemanticDecisionProvider` and the provider error
  model go to `packages/semantic-provider`, together with a fake provider for
  tests (RFX-029). `DecisionEngine` goes to `packages/core`. Contracts then
  holds shapes only, which is what "canonical schemas" means.
- The move happens in RFX-025, not before. It changes no serialized shape, so
  `CONTRACT_VERSION` does not move; the package's export list does, and
  `compatibility.test.ts` is updated in the same change, on purpose.

Dependency direction is unchanged and already allowed: `core ->
semantic-provider`, `provider-jev -> semantic-provider`, both `-> contracts`.

### 2. The error model

`evaluate` never rejects for an expected outcome. It resolves to a result:

```ts
type ProviderResult =
  | { ok: true; assessment: SemanticAssessment }
  | { ok: false; error: ProviderError };

interface ProviderError {
  kind:
    | "timeout"
    | "aborted"
    | "unavailable"
    | "rate-limited"
    | "rejected-request"
    | "invalid-response";
  providerName: string;
  latencyMs: DurationMs;
  retryable: boolean;
}
```

- No message from the provider, no payload, no argument value: an error is
  logged and counted, and provider text is untrusted input.
- `retryable` is information for background callers. The decision path never
  retries (RFX-026).
- Mapping to the decision (ADR-003): `timeout` and `aborted` become the
  fallback reason `timeout`; everything else `provider-error`.
- A thrown exception is a bug in the provider. Core catches it, treats it as
  `unavailable` and reports it as a defect.

### 3. A partial assessment is an error

Confirmed. `SemanticAssessment` is parsed strictly (ADR-009): all eleven
dimensions, each with a value and a confidence, or `invalid-response`. A
provider never fills a gap with a default, and core never repairs one. Where a
provider's model has no native answer for a field, the provider package defines
the mapping explicitly and tests it; it does not invent a constant
(`docs/jev-provider.md` §3).

### 4. What stays inside a provider

How many requests an assessment takes, batching, connection reuse, the wording
of questions, the provider's own model identifiers and answer shapes. The
interface is one call in, one result out, with a deadline and an
`AbortSignal`.

## Consequences

### Positive

- Core handles provider failure with a `switch`, exhaustively, instead of
  guessing what was thrown.
- A second provider can be written against one small package, without reading
  core.
- `packages/contracts` becomes purely declarative, which is what the rule
  "contracts depends on nothing" was protecting.

### Negative

- Two exported interfaces leave `packages/contracts`. Nothing outside this
  repository uses them yet; after a public SDK exists this would be a breaking
  change to the package.
- A result type is more verbose at every call site than `await`.

### Follow-ups

- RFX-025 performs the move and defines `ProviderResult`.
- RFX-027 maps Jev's answers and owns the confidence of the boolean dimension.
- RFX-028's premise is already noted as invalid for Jev (RFX-107).

## Alternatives considered

- **Leave the interfaces in contracts.** No work, and the package that may
  depend on nothing keeps accumulating behavior.
- **Throw typed errors.** Familiar, and unenforced: nothing makes a provider
  throw the right class, and `catch` is not exhaustive.
- **Let a provider return a partial assessment with per-field errors.**
  Rejected: every consumer would need a rule for every missing field, and the
  easiest rule to write is the unsafe one.

## Enforcement

- The boundary test (`tests/boundaries.test.ts`) already forbids
  `core -> provider-*`, `provider-jev -> core` and `adapter -> provider-jev`.
- RFX-025: core compiles and its suite runs with the fake provider and without
  `provider-jev` installed (the G4 gate exit).
- RFX-027: malformed or partial provider output never yields `allow`.
- A lint rule on `packages/semantic-provider` and providers: no `throw` in
  `evaluate` paths, or a test that every failure mode of the fake resolves.

## References

- `CLAUDE.md`: principle 3, "Coding conventions", "Architectural dependency
  direction"
- `docs/jev-provider.md`
- ADR-003, ADR-009
- `packages/contracts/src/semantic.ts`
