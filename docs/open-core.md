# Open core: what is open and what is private

ADR-015 draws one line: **everything that runs on the user's machine, and
everything a third party needs to integrate with REFLEX or to write a
provider, is open under Apache-2.0. Everything that needs an account, and
the model itself, is private.**

This page is the list. `tests/boundaries.test.ts` reads it: every workspace
package must appear here, its manifest must declare the licence written
here, and **no open package may depend on a private one**. Until the
repositories are split (RFX-149), the boundary is enforced here rather than by
distance.

The npm scope is `@reflex-control` (RFX-127, 2026-10-04): `@reflex` and `rfx`
were already taken by other organizations on npm. Package names are
`@reflex-control/<directory>`; the command is still `rfx`.

## Open (Apache-2.0)

| Package                               | Path                           |
| ------------------------------------- | ------------------------------ |
| `@reflex-control/contracts`           | `packages/contracts`           |
| `@reflex-control/policy-engine`       | `packages/policy-engine`       |
| `@reflex-control/command-classifier`  | `packages/command-classifier`  |
| `@reflex-control/core`                | `packages/core`                |
| `@reflex-control/context-compiler`    | `packages/context-compiler`    |
| `@reflex-control/semantic-provider`   | `packages/semantic-provider`   |
| `@reflex-control/provider-jev`        | `packages/provider-jev`        |
| `@reflex-control/provider-local`      | `packages/provider-local`      |
| `@reflex-control/adapter-claude-code` | `packages/adapter-claude-code` |
| `@reflex-control/adapter-codex`       | `packages/adapter-codex`       |
| `@reflex-control/adapter-mcp`         | `packages/adapter-mcp`         |
| `@reflex-control/cli`                 | `packages/cli`                 |
| `@reflex-control/decision-gateway`    | `apps/decision-gateway`        |
| `@reflex-control/telemetry`           | `packages/telemetry`           |
| `@reflex-control/evals`               | `packages/evals`               |
| `@reflex-control/sdk-typescript`      | `packages/sdk-typescript`      |

Also open: `python/reflex-sdk`, `docs/`, the root tooling. The `LICENSE` at
the root is the Apache License 2.0 and applies to everything not listed as
private below.

## Private (UNLICENSED, all rights reserved)

| Package or area             | Path             | Why                                                                                        |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `@reflex-control/api`       | `apps/api`       | the control plane                                                                          |
| `@reflex-control/dashboard` | `apps/dashboard` | the control plane's interface                                                              |
| `@reflex-control/auth`      | `packages/auth`  | accounts, keys, tenancy                                                                    |
| RDM                         | `rdm/`           | schema, splits, generators, and later weights and training (ADR-016 §5); its own `LICENSE` |

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
  workspace-wide publish reaches it; when packages are published (RFX-127)
  the publish step lists open packages by name, and the public repository
  (RFX-149) never holds it.
- A user's own provider key in the open daemon is allowed (ADR-015 §4).
