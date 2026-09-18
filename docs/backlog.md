# REFLEX Build Backlog

This backlog is ordered by **gates**, not by feature excitement. A gate may not close until all exit criteria pass.

Ticket IDs are stable. Claude Code should reference them in commits/PRs.

**Status convention.** A ticket carries a `**Status:**` line only once work on it has happened. `Done` means every acceptance criterion was verified, and the line says how. `Implemented, verification pending` means the work is complete but a criterion cannot be verified yet, and the line says exactly what is missing. No status line means not started.

## G0 — Repository foundation

### RFX-001 — Initialize pnpm/Turborepo workspace

**Goal:** Create root workspace, strict TS config, lint, formatting and test commands.

**Acceptance:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` run from repo root on a clean checkout.

**Status:** Done (2026-09-18). Verified on a simulated clean checkout (only files git would track, no `node_modules`, no `dist`) on macOS and in a clean `node:24` Linux container: frozen install, then all three commands exit 0. TypeScript is pinned to 6.0.x because `typescript-eslint` does not yet support 7.x. Guarded by `tests/toolchain.test.ts`.

### RFX-002 — Create package skeletons

**Goal:** Create exact package/app directories from architecture document with package manifests.

**Acceptance:** All workspace packages resolve and can import `@reflex/contracts`.

**Status:** Done (2026-09-18). 3 apps and 14 packages, manifests plus an empty entry point each; no implementation. Every package has a `src/workspace.test.ts` that imports `@reflex/contracts` at runtime and at the type level through its own manifest. `python/reflex-sdk` is a placeholder README (not a pnpm package). The forbidden dependency directions from `CLAUDE.md` are enforced by lint and by `tests/workspace.test.ts`, with adversarial cases in `tests/boundaries.test.ts`. Not created, because no G0 ticket covers them: `infra/`, the per-package inner directories, and the split contract files (G1).

### RFX-003 — Set CI quality gates

**Goal:** Add CI for install, lint, typecheck, tests and build.

**Acceptance:** PR fails on any quality gate; CI uses lockfile-frozen install.

**Status:** Done (2026-09-18). First GitHub Actions run on `main` is green: [run 35366580681](https://github.com/RafaelCasuso/reflex/actions/runs/35366580681), every gate `success`. **Quality gates** is a required status check on `main`, pinned to the GitHub Actions app so no other integration can satisfy it by reusing the name; admins may bypass, no review is required, force pushes and branch deletion are off. Verified before the push: `actionlint` reports 0 errors; the exact CI command sequence passes in a clean `node:24` Linux container; fault injection proves each gate exits non-zero (lint, architectural boundary, non-exhaustive switch, `any`, formatting, typecheck, build, failing test, forbidden manifest edge, lockfile drift); `tests/ci.test.ts` rejects ten ways of weakening the workflow. Branch protection is a repository setting, not a file: it does not travel with a fork or a transfer and must be re-applied there.

### RFX-004 — Create ADR framework

**Goal:** Create ADR template and ADR index.

**Acceptance:** ADRs are discoverable and template includes context/decision/consequences.

**Status:** Done (2026-09-18). `docs/adr/README.md` (index, process, statuses, when an ADR is required) and `docs/adr/ADR-000-template.md`. Linked from `README.md` and `docs/architecture.md` §14. `tests/adr.test.ts` fails if an ADR is missing from the index, if the index status disagrees with the file, or if a required section is absent.

### RFX-005 — Write ADR-001 canonical action model

**Goal:** Freeze first canonical action boundary.

**Acceptance:** ADR explains inclusions/exclusions and adapter metadata escape hatch.

**Status:** Done (2026-09-18). `docs/adr/ADR-001-canonical-action-model.md`, status `Accepted`. A test keeps the ADR in sync with every `CanonicalAction` field, and a type-level test locks `adapterMetadata` out of `SemanticDecisionRequest`. Needs maintainer review: the ADR makes three interpretive calls (policy context lives on the request envelope, absence means unknown and never safe, conflicts resolve toward the more dangerous reading) and lists enforcement obligations for G1, G2, G3, G5, G6, G7 and G8.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

**Gate status:** Closed (2026-09-18). All five tickets are done, documented and green in CI on GitHub. No decision logic exists yet, so there is no false-allow surface to regress. Carried into later gates: ADR-002 to ADR-008 are owed before G2 (`docs/architecture.md` §14), and ADR-001 lists enforcement obligations for G1, G2, G3, G5, G6, G7 and G8.

## G1 — Canonical contracts

### RFX-006 — Implement ID and primitive types

**Goal:** Add opaque IDs, modes, effects, risk/confidence primitives.

**Acceptance:** Type tests prevent accidental cross-ID assignment.

**Status:** Done (2026-09-18). `ids.ts` and `primitives.ts`. Template-literal ID types make every pair of ID kinds mutually unassignable, and a plain `string` unassignable to any of them; `ids.test.ts` proves it with `@ts-expect-error` cases and an exhaustive pairwise type matrix that covers the whole prefix registry. `isOpaqueId` is the only way an untrusted string becomes a typed ID, and restricts the body to characters that are inert in logs, URLs, file names and cache keys. Every closed set is one readonly tuple from which both the union type and the validator derive. Risk, confidence, duration and timestamp are documented aliases with strict runtime validation; they are not branded types (see the gate notes).

### RFX-007 — Implement CanonicalAction

**Goal:** Implement canonical action schema and runtime validation.

**Acceptance:** Valid actions parse; missing mandatory fields fail with typed validation errors.

**Status:** Done (2026-09-18). `action.ts` and `parse.ts`. `parseCanonicalAction` returns `ValidationResult<CanonicalAction>` and never throws; a missing mandatory field yields `{ path, code: "missing_field", message }`. The hand-written interface stays the specification and the schema is asserted type-identical to it, so drift in either direction fails `pnpm typecheck`. Discharges the ADR-001 obligations for G1: strict at every level (host-, provider- and decision-shaped keys are rejected, never stripped), `adapterMetadata` and `arguments` must be plain JSON within depth and size bounds (iterative walker, safe against nesting bombs and cycles), nested types are named, and `resolveEnvironment()` applies the §4 conflict rule. Issue messages never contain input values.

### RFX-008 — Implement DecisionRequest/ReflexDecision

**Goal:** Add canonical request and decision contracts.

**Acceptance:** Serialization round-trip tests pass.

**Status:** Done (2026-09-18). `decision.ts` and `parse.ts`. Minimal and full fixtures of both contracts survive parse, JSON and parse again, unchanged and byte-stable (the byte-level test caught and fixed a parser that reordered keys). `DecisionRequest` is read strictly. `ReflexDecision` is read tolerantly per ADR-009: unknown keys and unknown informational enum members are ignored, while `effect`, `effectiveEffect` and `mode` are closed and never coerced. No relation between `effect`, `effectiveEffect` and `mode` is enforced, because none is defined anywhere yet (needs ADR-002 before G3).

### RFX-009 — Implement semantic assessment contracts

**Goal:** Add independent semantic signal types.

**Acceptance:** No provider-specific fields leak into contract.

**Status:** Done (2026-09-18). `semantic.ts`. Eleven independent dimensions, each with its own confidence, matching `docs/architecture.md` §6. The assessment is read strictly: provider-specific extras are rejected at the top level and inside each signal, a missing dimension or confidence invalidates the whole assessment (a partial one can never become an implicit allow), and any attempt to return a verdict (`effect`, `decision`, `safe`) is rejected. A type test proves no field of the contract can carry a `DecisionEffect`. `SemanticDecisionProvider` stays in contracts for now; its home is for ADR-005 before G4.

### RFX-010 — Implement feedback contracts

**Goal:** Add decision feedback types and validation.

**Acceptance:** All four feedback values supported and timestamp/ID validated.

**Status:** Done (2026-09-18). `feedback.ts`. Exactly `correct`, `should-allow`, `should-ask`, `should-deny`. `decisionId` must be a `dec_` ID (an `act_` ID is rejected), `createdAt` must be ISO 8601 UTC (offsets and impossible dates are rejected). Read strictly: feedback feeds Approval Learning, so an unknown field such as `weight` or `applyImmediately` is rejected instead of ignored.

### RFX-011 — Contract versioning strategy

**Goal:** Document additive/breaking change policy.

**Acceptance:** Versioning documented with compatibility test fixture.

**Status:** Done (2026-09-18). Policy in `docs/adr/ADR-009-contract-versioning.md`: strict inputs, tolerant decision output, a change classification table, the must-ignore-safe rule, receiver-first deployment, and the procedure for additive and breaking changes. Fixture in `packages/contracts/fixtures/v1.0/` (language-neutral JSON, reusable by the Python SDK), enforced by `compatibility.test.ts`: frozen payloads keep parsing, fixtures are checksum-locked and excluded from Prettier, mandatory field sets and limits cannot tighten, vocabularies cannot shrink, the three decision-semantics sets cannot change at all, and the runtime export surface is pinned.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

**Gate status:** Closed (2026-09-18). All six tickets are done, documented and green in CI on GitHub: pull request #2 passed the required check and was merged as three self-contained commits, and [run 35376636374](https://github.com/RafaelCasuso/reflex/actions/runs/35376636374) is green on `main`. No decision logic exists yet, so there is no false-allow surface to regress; the contracts are built so that the later gates cannot create one through the boundary (nothing is defaulted, coerced or repaired). Validation cost on the hot path is about 4 µs for an ordinary request and under 1 ms for the worst input the contract accepts (`packages/contracts/README.md`). Open items carried forward: the meaning of `effectiveEffect` per mode (ADR-002, before G3); integer-millisecond latency loses sub-millisecond resolution (`CLAUDE.md` convention, decide before G3); `ses_` is missing from the ID prefix list in `CLAUDE.md`; Unicode look-alike and invisible characters in names are not filtered at the contract level and belong to the matcher corpus (RFX-018); ADR-002 to ADR-008 are owed before G2.

## G2 — Deterministic policy engine

### RFX-012 — Define policy YAML schema

**Goal:** Implement v1 policy document parser.

**Acceptance:** Invalid YAML/schema produces actionable line/path errors.

### RFX-013 — Implement policy condition matcher

**Goal:** Support equals, not_equals, starts_with, matches, in, exists.

**Acceptance:** Unit tests cover positive, negative and malformed cases.

### RFX-014 — Implement precedence engine

**Goal:** Resolve mandatory org/env/project/local precedence.

**Acceptance:** Deny/ask/allow precedence is deterministic and exhaustively tested.

### RFX-015 — Implement policy evaluator

**Goal:** Return resolved/unresolved plus matches and latency.

**Acceptance:** Pure evaluation has no I/O and benchmark p95 target under test fixture.

### RFX-016 — Policy hash and immutable compiled set

**Goal:** Canonicalize and hash compiled policy set.

**Acceptance:** Identical policy content yields identical hash regardless of formatting.

### RFX-017 — Bootstrap coding-agent policy pack

**Goal:** Provide conservative starter rules for common read/test/status operations.

**Acceptance:** Default pack never auto-allows destructive/external/privilege actions.

### RFX-018 — Adversarial matcher tests

**Goal:** Test shell tricks, quoting, chaining and misleading command prefixes.

**Acceptance:** Known bypass corpus does not bypass explicit deny rules.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G3 — Decision engine API

### RFX-019 — Implement decision engine orchestration

**Goal:** Wire normalize → policy → semantic → aggregate → decision.

**Acceptance:** Deterministically resolved actions never invoke semantic provider.

### RFX-020 — Implement failure-mode engine

**Goal:** Implement fail-open/fail-ask/fail-closed with risk-class constraints.

**Acceptance:** Unknown dangerous classes cannot silently fail open by default.

### RFX-021 — Create decision gateway HTTP endpoint

**Goal:** Implement `POST /v1/decisions`.

**Acceptance:** Validated request returns canonical decision with correlation ID.

### RFX-022 — Deadline and cancellation support

**Goal:** Propagate deadlines/AbortSignal through engine.

**Acceptance:** Timed-out semantic calls terminate and follow fallback policy.

### RFX-023 — Structured decision telemetry

**Goal:** Emit latency/effect/cache/fallback metrics.

**Acceptance:** Telemetry contains no raw action arguments.

### RFX-024 — Gateway benchmark harness

**Goal:** Create repeatable local benchmark.

**Acceptance:** Baseline report produced for deterministic path.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G4 — Semantic provider / Jev

### RFX-025 — Define SemanticDecisionProvider interface

**Goal:** Finalize provider abstraction package.

**Acceptance:** Core compiles with fake provider and without Jev dependency.

### RFX-026 — Implement Jev client boundary

**Goal:** Create authenticated Jev transport with timeout/retry policy.

**Acceptance:** Transport errors map to typed provider errors.

### RFX-027 — Map Jev outputs to semantic signals

**Goal:** Implement structured mapping and validation.

**Acceptance:** Malformed/partial provider output never becomes an implicit allow.

### RFX-028 — Implement parallel semantic dimensions

**Goal:** Evaluate independent dimensions with bounded concurrency.

**Acceptance:** Result includes confidence for each required dimension.

### RFX-029 — Provider fixture/fake implementation

**Goal:** Add deterministic fake provider for tests/dev.

**Acceptance:** Entire decision engine test suite runs offline.

### RFX-030 — Semantic provider latency telemetry

**Goal:** Record provider/model/dimension latencies.

**Acceptance:** Dashboard-ready metrics exposed without sensitive inputs.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G5 — Context compiler and redaction

### RFX-031 — Implement local secret redactor

**Goal:** Redact common token/key/header/env patterns.

**Acceptance:** Golden corpus confirms secrets never survive redaction.

### RFX-032 — Implement relevant-history selector

**Goal:** Select bounded prior actions relevant to current tool/resource.

**Acceptance:** History size remains bounded under long sessions.

### RFX-033 — Implement semantic context compiler

**Goal:** Produce minimal provider request from canonical action.

**Acceptance:** Median test corpus stays under configured token budget.

### RFX-034 — Token budget enforcement

**Goal:** Hard-truncate/summarize optional context by priority.

**Acceptance:** Required action/resource fields are never truncated.

### RFX-035 — Redaction adversarial corpus

**Goal:** Add encoded, quoted and embedded secret fixtures.

**Acceptance:** Corpus reports zero raw known secrets after compiler.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G6 — Risk aggregation and evals

### RFX-036 — Implement risk aggregator v1

**Goal:** Convert semantic dimensions + policy hints into risk/effect.

**Acceptance:** Thresholds are explicit config, not magic scattered constants.

### RFX-037 — Low-confidence escalation rule

**Goal:** Bias uncertain semantic assessments toward ASK.

**Acceptance:** Low-confidence high-impact action never auto-allows.

### RFX-038 — Create golden eval corpus

**Goal:** Add safe/destructive/off-task/secret/prod/financial cases.

**Acceptance:** Each case has expected acceptable effects.

### RFX-039 — Implement replay/eval harness

**Goal:** Run engine version against corpus and summarize regressions.

**Acceptance:** CI can fail on dangerous false-allow regression.

### RFX-040 — Add regression threshold CI gate

**Goal:** Define initial false-allow safety threshold.

**Acceptance:** Any new dangerous false allow fails CI.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G7 — Claude Code adapter

### RFX-041 — Detect Claude Code installation/config scope

**Goal:** Detect project/user config safely.

**Acceptance:** Detection is read-only and returns exact mutation plan.

### RFX-042 — Implement Claude hook input translator

**Goal:** Translate supported hook payload into CanonicalAction.

**Acceptance:** Fixture tests cover Bash, file edits and MCP calls.

### RFX-043 — Implement Claude decision mapper

**Goal:** Map allow/ask/deny to supported native permission behavior.

**Acceptance:** ASK delegates to host approval; DENY reliably blocks where supported.

### RFX-044 — Implement reversible Claude installer

**Goal:** Install project-scoped config/hook and create backup.

**Acceptance:** `rfx uninstall` restores original config byte-for-byte.

### RFX-045 — Claude Observe mode

**Goal:** Evaluate/record without changing execution.

**Acceptance:** No observed action is blocked or auto-approved in Observe.

### RFX-046 — Claude Assist mode

**Goal:** Auto-resolve safe supported actions and delegate others.

**Acceptance:** Unsafe/uncertain fixture always reaches native approval or block.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G8 — Codex adapter

### RFX-047 — Detect Codex hooks/config

**Goal:** Detect `.codex`/user hooks and trust-sensitive setup.

**Acceptance:** Detection never overwrites existing hook representation.

### RFX-048 — Implement Codex PreToolUse translator

**Goal:** Translate supported PreToolUse events.

**Acceptance:** Bash/apply_patch/MCP fixture coverage.

### RFX-049 — Implement Codex PermissionRequest handler

**Goal:** Allow/deny/abstain using native permission semantics.

**Acceptance:** ASK is implemented as abstention/native approval, not fake PreToolUse ask.

### RFX-050 — Implement reversible Codex installer

**Goal:** Install one supported hooks representation with backup.

**Acceptance:** Existing user hooks are preserved/merged safely.

### RFX-051 — Codex Observe/Assist modes

**Goal:** Honor product-mode semantics across both hook types.

**Acceptance:** Observe never changes execution; Assist never suppresses needed approval.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G9 — CLI and zero-friction onboarding

### RFX-052 — Implement `rfx init` detector

**Goal:** Scan supported agents and MCP configs.

**Acceptance:** Command prints deterministic plan before mutation.

### RFX-053 — Implement backup transaction

**Goal:** All config writes participate in reversible transaction.

**Acceptance:** Partial failure rolls back prior modifications.

### RFX-054 — Generate starter `.reflex/policy.yaml`

**Goal:** Create readable conservative starter policy.

**Acceptance:** Existing file never overwritten without explicit user action.

### RFX-055 — Implement `rfx doctor`

**Goal:** Diagnose adapters, gateway, policy, auth and host config.

**Acceptance:** Each failure includes concrete remediation.

### RFX-056 — Implement `rfx status`

**Goal:** Show mode, connected adapters, last decision and latency.

**Acceptance:** Works without opening dashboard.

### RFX-057 — Implement `rfx uninstall`

**Goal:** Remove hooks/adapter and restore backups.

**Acceptance:** Idempotent; leaves user's unrelated config untouched.

### RFX-058 — Anonymous local Observe identity

**Goal:** Allow first value without signup.

**Acceptance:** User can govern actions locally before creating cloud account.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G10 — Persistence and Observe product

### RFX-059 — Create control-plane DB schema

**Goal:** Organizations/projects/agents/policy versions/decisions/feedback.

**Acceptance:** Migrations are reversible and tenant IDs mandatory.

### RFX-060 — Persist redacted decision events

**Goal:** Store canonical redacted event plus decision metadata.

**Acceptance:** No raw secret fixture can be found in DB dump.

### RFX-061 — Implement project claim flow

**Goal:** Claim anonymous/local install into account.

**Acceptance:** Existing local project identity links without losing history.

### RFX-062 — Decision timeline API

**Goal:** Paginated/filterable decision event endpoint.

**Acceptance:** Filters by effect, agent, tool, risk, time.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G11 — Dashboard and activation

### RFX-063 — Build autonomy overview

**Goal:** Show autonomy rate, governed actions, asks, denies, latency.

**Acceptance:** Metrics derived from real events, not placeholder counters.

### RFX-064 — Build decision timeline

**Goal:** Timeline with event detail drawer.

**Acceptance:** Sensitive arguments obey retention/redaction settings.

### RFX-065 — Build first-session activation card

**Goal:** Explain observed autonomy opportunity.

**Acceptance:** Card appears after enough evidence and never claims unmeasured safety.

### RFX-066 — Mode switch UX

**Goal:** Observe → Assist → Autopilot with explicit consequences.

**Acceptance:** Mode changes are audited and immediately reflected in config.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G12 — Feedback and Approval Learning

### RFX-067 — Decision feedback endpoint/UI

**Goal:** Correct/should allow/ask/deny feedback.

**Acceptance:** Feedback is immutable/audited and associated with decision version.

### RFX-068 — Repeated-approval pattern miner

**Goal:** Cluster semantically/deterministically similar approvals.

**Acceptance:** Suggestions include evidence count and scope.

### RFX-069 — Generate inspectable policy suggestions

**Goal:** Convert patterns into candidate deterministic rules.

**Acceptance:** No suggestion changes enforcement before acceptance.

### RFX-070 — Suggestion impact replay

**Goal:** Replay proposed rule over historical decisions.

**Acceptance:** Show changed allow/ask/deny counts and conflicting risky cases.

### RFX-071 — Accept/reject suggestion flow

**Goal:** Human acceptance creates new policy version.

**Acceptance:** Every accepted rule includes provenance to suggestion/evidence.

### RFX-072 — Implement `rfx trust this`

**Goal:** CLI shortcut proposes narrowly scoped current-action trust rule.

**Acceptance:** Command displays exact generated rule before applying.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G13 — MCP proxy

### RFX-073 — Build transparent MCP proxy skeleton

**Goal:** Proxy tools/resources with schema preservation.

**Acceptance:** Known test server works unchanged through proxy.

### RFX-074 — Govern MCP tool calls

**Goal:** Normalize MCP calls and enforce decision.

**Acceptance:** Denied calls never reach upstream server.

### RFX-075 — MCP config discovery/install

**Goal:** Detect and optionally wrap configured servers.

**Acceptance:** Install is reversible and does not expose server secrets.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G14 — SDKs and public API

### RFX-076 — TypeScript `reflex.guard()`

**Goal:** Wrap tool collections with decision enforcement.

**Acceptance:** Existing tool signatures preserved.

### RFX-077 — Python guard SDK

**Goal:** Python equivalent with async support.

**Acceptance:** Parity contract tests pass across TS/Python.

### RFX-078 — API key/project auth

**Goal:** Issue scoped keys for decision API.

**Acceptance:** Keys are hashed at rest and revocable.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G15 — Billing and paid value

### RFX-079 — Governed-action metering

**Goal:** Count billable governed actions idempotently.

**Acceptance:** Retries cannot double bill.

### RFX-080 — Plan/limit enforcement

**Goal:** Developer/Pro/Team/Scale entitlements.

**Acceptance:** Limit behavior never disables safety enforcement silently.

### RFX-081 — ROI/value metrics

**Goal:** Compute approval prompts eliminated and configurable time estimate.

**Acceptance:** Estimated time is visibly labelled and assumption configurable.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G16 — Team foundations

### RFX-082 — Organizations and memberships

**Goal:** Owner/admin/member roles.

**Acceptance:** Tenant isolation tests cover every org-scoped endpoint.

### RFX-083 — Shared project policies

**Goal:** Team policy publishing/versioning.

**Acceptance:** Clients consume immutable signed config snapshot.

### RFX-084 — Environment policies

**Goal:** Distinct staging/production rules.

**Acceptance:** Production policy cannot be weakened by local project policy.

### RFX-085 — Audit log

**Goal:** Record policy/mode/member/security changes.

**Acceptance:** Audit log is append-only at application layer.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.
