# Open core: what is open and what is private

ADR-015 draws one line: **everything that runs on the user's machine, and
everything a third party needs to integrate with REFLEX or to write a
provider, is open under Apache-2.0. Everything that needs an account, and
the model itself, is private.**

This page is the list. `tests/boundaries.test.ts` reads it: every workspace
package must appear here, its manifest must declare the licence written
here, and **no open package may depend on a private one**. Until the
repositories are split, the boundary is enforced here rather than by
distance.

## Open (Apache-2.0)

| Package                       | Path                           |
| ----------------------------- | ------------------------------ |
| `@reflex/contracts`           | `packages/contracts`           |
| `@reflex/policy-engine`       | `packages/policy-engine`       |
| `@reflex/command-classifier`  | `packages/command-classifier`  |
| `@reflex/core`                | `packages/core`                |
| `@reflex/context-compiler`    | `packages/context-compiler`    |
| `@reflex/semantic-provider`   | `packages/semantic-provider`   |
| `@reflex/provider-jev`        | `packages/provider-jev`        |
| `@reflex/adapter-claude-code` | `packages/adapter-claude-code` |
| `@reflex/adapter-codex`       | `packages/adapter-codex`       |
| `@reflex/adapter-mcp`         | `packages/adapter-mcp`         |
| `@reflex/cli`                 | `packages/cli`                 |
| `@reflex/decision-gateway`    | `apps/decision-gateway`        |
| `@reflex/telemetry`           | `packages/telemetry`           |
| `@reflex/evals`               | `packages/evals`               |
| `@reflex/sdk-typescript`      | `packages/sdk-typescript`      |

Also open: `python/reflex-sdk`, `docs/`, the root tooling. The `LICENSE` at
the root is the Apache License 2.0 and applies to everything not listed as
private below.

## Private (UNLICENSED, all rights reserved)

| Package or area     | Path             | Why                                                        |
| ------------------- | ---------------- | ---------------------------------------------------------- |
| `@reflex/api`       | `apps/api`       | the control plane                                          |
| `@reflex/dashboard` | `apps/dashboard` | the control plane's interface                              |
| `@reflex/auth`      | `packages/auth`  | accounts, keys, tenancy                                    |
| RDM                 | `rdm/`           | weights, training, generators, teacher labels (ADR-016 §5) |

Approval learning (G12), team and organization policies (G16), billing and
metering (G15) and the hosted gateway configuration are private and will
live in `apps/api` or in packages listed here when they exist. A new
package that is not in either table fails the boundary test, so the
question is asked when the package is created, not after it ships.

## Rules

- An open package may depend on open packages only. A private package may
  depend on anything.
- Nothing in `packages/` or `apps/` imports from `rdm/`; ESLint refuses the
  relative path and the boundary test holds it. RDM's only contract with
  the product is the canonical one: a `SemanticDecisionRequest` in, a
  `SemanticAssessment` out, over `packages/provider-local` (RFX-144).
- `rdm/` is not a workspace package (`pnpm-workspace.yaml`), so no
  workspace-wide publish reaches it; when packages are published (RFX-076)
  the publish step lists open packages by name.
- A user's own provider key in the open daemon is allowed (ADR-015 §4).
