# @reflex-control/contracts

The canonical contracts. The single source of truth for every shape that
crosses a REFLEX boundary. Nothing in here is host- or provider-specific
(ADR-001), and this package depends on no other workspace package.

Read before changing anything:
[ADR-001](../../docs/adr/ADR-001-canonical-action-model.md) (what belongs in an
action) and [ADR-009](../../docs/adr/ADR-009-contract-versioning.md) (what is
additive, what is breaking, and the procedure for each).

## Layout

| File            | Contents                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ids.ts`        | Prefixed opaque IDs and the `isOpaqueId` guard                                                                                     |
| `primitives.ts` | Effects, modes, failure modes, hosts, environments, side-effect classes, and the score, confidence, timestamp and duration aliases |
| `limits.ts`     | `CONTRACT_LIMITS`                                                                                                                  |
| `validation.ts` | `ValidationResult`, `ValidationIssue`, issue codes                                                                                 |
| `action.ts`     | `CanonicalAction` and `resolveEnvironment`                                                                                         |
| `decision.ts`   | `DecisionRequest`, `ReflexDecision`, reason codes                                                                                  |
| `semantic.ts`   | `SemanticAssessment`, provider request and interface                                                                               |
| `policy.ts`     | Policy document types, `PolicyMatch`                                                                                               |
| `feedback.ts`   | `DecisionFeedback`                                                                                                                 |
| `outcome.ts`    | `ActionOutcome`: what the host did with an action (ADR-013)                                                                        |
| `parse.ts`      | The five boundary parsers                                                                                                          |
| `version.ts`    | `CONTRACT_VERSION`                                                                                                                 |
| `internal/`     | Schemas and validation machinery. Not exported.                                                                                    |
| `../fixtures/`  | Frozen, checksum-locked JSON payloads per released minor                                                                           |

Public modules are the specification: interfaces, vocabularies and pure
helpers. Only `internal/` imports the validation library, so importing types
from this package never loads that library's declarations. A test enforces it.

## Using it

Types are plain interfaces. Import them with `import type`; that costs nothing
at runtime.

At a boundary (HTTP body, hook stdin, provider response), parse:

```ts
import { parseDecisionRequest } from "@reflex-control/contracts";

const result = parseDecisionRequest(body);
if (!result.ok) {
  // result.issues: [{ path: "action.tool.name", code: "missing_field", message }]
  // Safe to log and to return: messages never contain input values.
  return reject(result.issues);
}
decide(result.value);
```

Parsers never throw and never repair. Inside a process, between functions,
trust the types and do not re-validate (`CLAUDE.md`: Zod at boundaries only).

Read the environment of an action through `resolveEnvironment(action)`, never
through `action.resource` directly. It resolves a missing resource to `unknown`
and a contradiction between `environment` and `isProduction` toward
`production` (ADR-001 §4).

## Rules that are easy to break by accident

- **Interfaces are the specification.** Each schema is asserted to be
  type-identical to its interface. Change both, or `pnpm typecheck` fails.
- **Inputs are strict, the decision output is tolerant.** See ADR-009 §2.
- **The validation library is not part of the public surface.** Do not export a
  schema. A test fails if you do.
- **Released fixtures are frozen.** Add `fixtures/vMAJOR.MINOR/`; never edit an
  existing directory.
- **Do not put an input value in an issue message.** Inputs carry secrets.
- **Shapes only.** `SemanticDecisionProvider` and `DecisionEngine` left this
  package in RFX-025 (ADR-005 §1): the provider interface and its typed
  result live in `@reflex-control/semantic-provider`, the engine interface in
  `@reflex-control/core`. No serialized shape changed, so the contract version did
  not move.
- **`action.id` is an idempotency key.** A decision gateway decides an id
  once (RFX-120): the same id with the same content returns the same decision
  and counts once; the same id with different content is rejected. Retry with
  the same id; never reuse one for a new call.

## Latency

Validation runs in front of every decision, against a deterministic-path budget
of p95 < 10 ms. Reproduce with `pnpm --filter @reflex-control/contracts bench`.

Baseline, 2026-09-18, Apple Silicon laptop, Node 24.9, Zod 4.6:

| Case                                                | mean      | p99       |
| --------------------------------------------------- | --------- | --------- |
| Decision request, minimal                           | 0.0033 ms | 0.0037 ms |
| Decision request, every field                       | 0.0042 ms | 0.0047 ms |
| Decision request, ~50 KB of arguments               | 0.0310 ms | 0.0459 ms |
| Decision request, at the JSON node limit            | 0.4698 ms | 0.8761 ms |
| Decision request, 20x over the node limit, rejected | 0.4623 ms | 0.5950 ms |
| Decision request, invalid, issues built             | 0.0110 ms | 0.0145 ms |
| Canonical action, every field                       | 0.0064 ms | 0.0069 ms |
| Semantic assessment                                 | 0.0033 ms | 0.0039 ms |
| Reflex decision, every field (adapter side)         | 0.0068 ms | 0.0095 ms |

An ordinary request costs about 4 µs, 0.04% of the budget. The cost of hostile
input is bounded by `CONTRACT_LIMITS.jsonNodes` and does not grow past it. The
benchmark carries loose tripwires against algorithmic regressions; it is not
part of `pnpm test`, because timing assertions do not belong on shared CI
runners.
