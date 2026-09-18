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

## G1.5 — Observe walking skeleton

The adoption loop in `docs/product.md` starts with `rfx init` and Observe. This gate delivers that loop end to end, locally, before any decision logic exists. Observe never affects execution, so it is safe to ship without a policy engine, a gateway or a semantic provider. The gate exists to put real host payloads in front of the canonical model before G2 builds on it, to seed the eval corpus with real actions, and to measure what a hook actually costs.

Scope rules for the whole gate: nothing leaves the machine, no decision is made, and no raw argument value is written to disk until the redactor (RFX-031) exists.

Tickets RFX-041, RFX-042, RFX-044, RFX-052, RFX-053, RFX-056, RFX-057 and RFX-058 were moved here from G7 and G9. Their IDs are unchanged.

### RFX-041 — Detect Claude Code installation/config scope

**Goal:** Detect project/user config safely.

**Acceptance:** Detection is read-only and returns exact mutation plan.

### RFX-042 — Implement Claude hook input translator

**Goal:** Translate supported hook payload into CanonicalAction.

**Acceptance:** Fixture tests cover Bash, file edits and MCP calls.

**G1.5 scope:** `sideEffectClass` is `unknown` unless it is trivially known. Classification arrives with the command classifier, and until then unknown is the honest value (ADR-001 §4).

### RFX-091 — Decide ADR-013 and add the `ActionOutcome` contract

**Goal:** Define a separate contract for what the host did with an action: whether it prompted, what the human answered, whether the action executed, and when. Keyed by `actionId`.

**Acceptance:** ADR-013 is accepted. The contract is added as an additive change under ADR-009 with frozen fixtures. It carries no tool output and no argument values, and it represents a signal the host does not expose as `unknown`, never as a guess.

**Why:** Without it the north-star metric, "approval prompts eliminated", the activation card and Approval Learning (which mines the host's native approvals) have no data to be computed from.

### RFX-044 — Implement reversible Claude installer

**Goal:** Install project-scoped config/hook and create backup.

**Acceptance:** `rfx uninstall` removes exactly what REFLEX added and leaves every other byte untouched, including edits the user made after installing. When the file has not changed since install, the result is byte-identical to the backup.

### RFX-052 — Implement `rfx init` detector

**Goal:** Scan supported agents and MCP configs.

**Acceptance:** Command prints deterministic plan before mutation.

**G1.5 scope:** Claude Code only. Codex and MCP detection are added by their own gates.

### RFX-053 — Implement backup transaction

**Goal:** All config writes participate in reversible transaction.

**Acceptance:** Partial failure rolls back prior modifications.

### RFX-086 — Local Observe recorder

**Goal:** Append one structured record per observed action to a local, size-bounded log that the user owns.

**Acceptance:** The hook never changes what the host does (no block, no auto-approval, no added prompt), including when the recorder itself fails. A record carries tool, operation, side-effect class, timestamps and the shape of the arguments (keys, types, sizes), and never a raw argument value until RFX-031 lands. The log rotates at a fixed size.

**Depends on:** RFX-042.

### RFX-092 — Capture action outcomes in Claude Code

**Goal:** Record an `ActionOutcome` for each observed action from the host's post-execution and permission signals.

**Acceptance:** Fixture tests cover: executed without a prompt, prompted and approved, prompted and rejected, blocked by the host. Capturing an outcome never changes what the host does.

**Depends on:** RFX-091, RFX-086.

### RFX-087 — Verify host behavior when the hook fails

**Goal:** Establish, with fixtures against the supported Claude Code version, what the host does when the REFLEX hook crashes, times out, exits non-zero, prints malformed output or is missing.

**Acceptance:** A documented table of failure to host behavior, every row backed by a fixture test. Any row where the host proceeds silently is listed as a fail-open path that a later gate must close or surface.

**Why:** `CLAUDE.md` principle 5 says REFLEX may never silently disappear from the execution path. That only holds if the host cooperates, and it has to be known before Assist or Autopilot rely on it.

### RFX-088 — Measure end-to-end hook overhead

**Goal:** Measure what one governed tool call costs as the host experiences it: process start, payload parse, translation, record, exit.

**Acceptance:** A repeatable benchmark with p50 and p95 on a named machine, committed next to its numbers and compared explicitly with the latency budgets in `CLAUDE.md`.

**Why:** Measured on 2026-09-18 (Apple Silicon, Node 24): an empty Node process takes 29.5 ms p50 to start, and 70.5 ms p50 once it loads the contracts and validates one request. A 10 ms deterministic budget cannot be met end to end with one Node process per call, so where decisions run has to be decided with this baseline in hand.

### RFX-056 — Implement `rfx status`

**Goal:** Show mode, connected adapters, last decision and latency.

**Acceptance:** Works without opening dashboard.

**G1.5 scope:** mode, installed adapters, last recorded action and measured hook overhead. Decision and latency fields appear once a decision engine exists.

### RFX-057 — Implement `rfx uninstall`

**Goal:** Remove hooks/adapter and restore backups.

**Acceptance:** Idempotent; leaves user's unrelated config untouched.

### RFX-058 — Anonymous local Observe identity

**Goal:** Allow first value without signup.

**Acceptance:** User can govern actions locally before creating cloud account.

**G1.5 scope:** the local identity only. Governing arrives with the decision engine.

### RFX-089 — Validate ADR-001 against real payloads

**Goal:** Compare the canonical action model with the payload shapes actually observed for Bash, file edits and MCP calls.

**Acceptance:** A short written review: canonical fields that were never populated, host data that had no canonical home, and candidates for promotion under ADR-001 §3.7. Any resulting contract change follows ADR-009.

**Depends on:** RFX-086.

**Why:** ADR-001 was accepted before a single real payload had been seen.

### RFX-090 — Supply-chain security workflow

**Goal:** Add `.github/workflows/security.yml` (dependency audit, static analysis, secret scanning) and automated update pull requests for the SHA-pinned actions and the npm dependencies.

**Acceptance:** A vulnerable dependency or a committed secret fails a required check. Pinned actions and dependencies receive update pull requests.

**Why:** From this gate on, REFLEX code runs inside every tool call on a developer's machine. `security.yml` is in the architecture layout and had no ticket, and SHA-pinned actions go stale without an updater.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** on a clean machine `rfx init` reaches a recorded action in under five minutes; `rfx uninstall` leaves no trace; no observed action was blocked, prompted or auto-approved by REFLEX; the log contains no raw argument value.

## G2 — Deterministic policy engine

### RFX-112 — Write ADR-002 decision precedence and effective effect

**Goal:** Write ADR-002, one of the first architectural ADRs that `docs/architecture.md` §14 requires before Gate G2.

**Acceptance:** ADR-002 is accepted and answers: The full table of mode (observe, assist, autopilot) by effect (allow, ask, deny): what `effectiveEffect` is in each cell and what the adapter does. Whether a semantic result can ever lower a deterministic ask. How `risk` and `confidence` are set for a purely deterministic decision.

### RFX-113 — Write ADR-003 fail behavior

**Goal:** Write ADR-003, one of the first architectural ADRs that `docs/architecture.md` §14 requires before Gate G2.

**Acceptance:** ADR-003 is accepted and answers: Which side-effect classes may fail open, and who decides the failure mode: can a client request `fail-open` for a destructive action? What the adapter does when it can reach nothing at all. How a fallback is reported to the user.

### RFX-114 — Write ADR-004 policy precedence

**Goal:** Write ADR-004, one of the first architectural ADRs that `docs/architecture.md` §14 requires before Gate G2.

**Acceptance:** ADR-004 is accepted and answers: What `mandatory` means exactly. Whether a lower source can override a non-mandatory rule from a higher source. How `PolicyMatch.precedence` is derived, how ties inside one source are broken, and how `defaults.unresolved` combines across sources. How trust (ADR-012) enters precedence.

### RFX-115 — Write ADR-005 provider abstraction

**Goal:** Write ADR-005, one of the first architectural ADRs that `docs/architecture.md` §14 requires before Gate G2.

**Acceptance:** ADR-005 is accepted and answers: Where `SemanticDecisionProvider` and `DecisionEngine` live: in contracts, where they are today, or in `packages/semantic-provider`. The typed provider error model. Confirmation that a partial assessment is an error (ADR-009 reads assessments strictly).

### RFX-116 — Write ADR-006 local redaction boundary

**Goal:** Write ADR-006, one of the first architectural ADRs that `docs/architecture.md` §14 requires before Gate G2.

**Acceptance:** ADR-006 is accepted and answers: What is redacted where (adapter, CLI, gateway). What may be written locally before redaction. Whether policy is matched before or after redaction, since a rule about a secret-shaped argument cannot match redacted text. Whether redacted values are hashed so that repeated approvals can still be clustered.

### RFX-117 — Write ADR-007 adapter ASK semantics

**Goal:** Write ADR-007, one of the first architectural ADRs that `docs/architecture.md` §14 requires before Gate G2.

**Acceptance:** ADR-007 is accepted and answers: A capability matrix per host: how allow, ask and deny are expressed, and in which hook. What `ask` becomes when the host cannot ask, for example headless or CI runs. How Assist maps onto each host.

### RFX-118 — Write ADR-008 telemetry persistence strategy

**Goal:** Write ADR-008, one of the first architectural ADRs that `docs/architecture.md` §14 requires before Gate G2.

**Acceptance:** ADR-008 is accepted and answers: The measured trigger for moving events from PostgreSQL to ClickHouse. When audit persistence is synchronous. What is never stored. Retention per event class.

### RFX-101 — Write the threat model

**Goal:** Write `docs/security.md`: assets, adversaries (the governed agent, prompt-injected content, a malicious repository, a malicious MCP server, a network attacker, a compromised dependency), trust boundaries and explicit non-goals.

**Acceptance:** Every adversary has at least one mitigation mapped to a ticket, or is listed as an accepted risk. The document states plainly that REFLEX is not a sandbox.

**Why:** The file is in the architecture layout and had no ticket. For a product whose job is to stop dangerous actions, the adversary list is what decides which tests exist.

### RFX-102 — Decide ADR-012 self-protection and workspace trust

**Goal:** Decide how REFLEX protects its own configuration and hook registration from the agent it governs, and how much a repository's own policy is trusted.

**Acceptance:** ADR-012 is accepted before RFX-017 starts, and ADR-004 accounts for trust as a dimension of precedence.

**Why:** In Autopilot the agent can edit `.reflex/policy.yaml` or remove the hook. A cloned repository can ship an allow-all policy that outranks the user's own rules.

### RFX-095 — Decide ADR-011 normalized operands and classification ownership

**Goal:** Decide what a policy rule matches against (host-shaped `arguments`, or canonical operands for command, paths and network targets) and who computes `sideEffectClass`.

**Acceptance:** ADR-011 is accepted before RFX-013 starts. If it introduces a classifier package, `docs/architecture.md` and the dependency rules in `CLAUDE.md` are updated in the same change.

**Why:** Rules written against `arguments.*` are host-specific, which is the exact failure ADR-001 was written to prevent. `CLAUDE.md` lists a command classifier as security-sensitive code, and no package or ticket for it exists.

### RFX-012 — Define policy YAML schema

**Goal:** Implement v1 policy document parser.

**Acceptance:** Invalid YAML/schema produces actionable line/path errors.

### RFX-105 — Seed the golden corpus and a minimal replay runner

**Goal:** Create the corpus format and a runner that replays it against the deterministic engine, so the policy engine is developed against it from its first ticket.

**Acceptance:** Each case states its acceptable effects and whether allowing it would be dangerous. CI fails when a dangerous case is allowed. Cases are seeded from G1.5 observations where they exist. RFX-038 and RFX-039 extend this corpus and runner; they do not replace them.

**Why:** Every gate exits on "no known dangerous false-allow regression", and the harness that can detect one arrived in G6. `CLAUDE.md` asks for tests first on decision-sensitive changes.

### RFX-013 — Implement policy condition matcher

**Goal:** Support equals, not_equals, starts_with, matches, in, exists.

**Acceptance:** Unit tests cover positive, negative and malformed cases.

### RFX-096 — Shell command normalization and classifier

**Goal:** Parse a shell command into segments with a real grammar, and classify the side-effect class of each segment.

**Acceptance:** Compound and indirect constructs (`;`, `&&`, pipes, `$(...)`, backticks, `bash -c`, `xargs`, `find -exec`, assignment and `env` prefixes, package-manager scripts) are either decomposed into segments or reported as not understood. An allow rule can only match a command whose every segment is understood. A deny rule matches if any segment matches. A side-effect class can be raised by a later stage and never lowered. The parser has its own latency benchmark.

**Depends on:** RFX-095.

**Why:** `starts_with` and `matches` on raw text cannot defeat the bypasses RFX-018 sets out to test. This ticket is what RFX-018 tests.

### RFX-097 — Path containment and composition operators

**Goal:** Add `path_within`, evaluated after normalization, and boolean composition (`any_of`, `not`) to the matcher.

**Acceptance:** Traversal (`..`), case and trailing-separator tricks cannot make a path outside the root match `path_within`. Composition has a documented truth table. A missing field never satisfies a condition in an allow rule, including under `not`.

### RFX-098 — Bounded regular expressions

**Goal:** Make the `matches` operator safe on the hot path.

**Acceptance:** Patterns either run on a linear-time engine or are rejected at policy compile time by a complexity check. A catastrophic-backtracking corpus cannot push a single evaluation past the deterministic latency budget.

### RFX-014 — Implement precedence engine

**Goal:** Resolve mandatory org/env/project/local precedence.

**Acceptance:** Deny/ask/allow precedence is deterministic and exhaustively tested.

### RFX-015 — Implement policy evaluator

**Goal:** Return resolved/unresolved plus matches and latency.

**Acceptance:** Pure evaluation has no I/O and benchmark p95 target under test fixture.

### RFX-016 — Policy hash and immutable compiled set

**Goal:** Canonicalize and hash compiled policy set.

**Acceptance:** Identical policy content yields identical hash regardless of formatting.

**Note:** design the compiled set so that it can be the payload of the signed snapshot in RFX-083. Signing can come later; the format should not have to change when it does.

### RFX-017 — Bootstrap coding-agent policy pack

**Goal:** Provide conservative starter rules for common read/test/status operations.

**Acceptance:** Default pack never auto-allows destructive/external/privilege actions.

### RFX-103 — Built-in self-protection rules

**Goal:** Ship mandatory rules, above every policy source, covering writes to REFLEX's configuration, policy files, hook registration in host settings, and REFLEX binaries.

**Acceptance:** No policy source can allow these actions without human approval. Adversarial tests cover indirect writes: redirects, `sed -i`, `mv`, symlinks, editor tools, and a script that performs the write. `rfx doctor` and `rfx status` report a removed or altered hook.

**Depends on:** RFX-102, RFX-096.

### RFX-100 — Policy language reference

**Goal:** Write `docs/policy-language.md`: addressable fields, operators, precedence, worked examples, and what a rule cannot express.

**Acceptance:** Every operator and every addressable field is documented with an example that is executed as a test, so the reference cannot drift from the engine.

**Why:** The file is in the architecture layout and had no ticket. It is the first document a user reads before trusting Autopilot.

### RFX-018 — Adversarial matcher tests

**Goal:** Test shell tricks, quoting, chaining and misleading command prefixes.

**Acceptance:** Known bypass corpus does not bypass explicit deny rules.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G3 — Decision engine API

### RFX-094 — Decide ADR-010 decision placement and hook latency

**Goal:** Decide where a decision is made (per-call process, local daemon, compiled binary, remote gateway) and at which points the latency budgets are measured.

**Acceptance:** ADR-010 is accepted before RFX-019 starts. It names the measurement points for every budget in `CLAUDE.md`, and it defines what the hook does when the chosen local component is unavailable.

**Depends on:** RFX-088 for the baseline, RFX-087 for what the host does on hook failure.

**Why:** The budgets, the no-account requirement (RFX-058) and "the data plane must keep working without the dashboard" cannot all hold with one Node process per call talking to a remote gateway.

### RFX-019 — Implement decision engine orchestration

**Goal:** Wire normalize → policy → semantic → aggregate → decision.

**Acceptance:** Deterministically resolved actions never invoke semantic provider.

### RFX-020 — Implement failure-mode engine

**Goal:** Implement fail-open/fail-ask/fail-closed with risk-class constraints.

**Acceptance:** Unknown dangerous classes cannot silently fail open by default.

### RFX-021 — Create decision gateway HTTP endpoint

**Goal:** Implement `POST /v1/decisions`.

**Acceptance:** Validated request returns canonical decision with correlation ID.

### RFX-119 — Gateway rate limiting and request size limits

**Goal:** Bound what one caller can cost the gateway: request rate per key and body size per request.

**Acceptance:** An over-limit request gets a typed rejection before any validation or decision work is done. Losing rate-limit state (a cache flush) fails safe and does not disable the limit.

**Why:** The gateway is a public endpoint on the hot path. `docs/architecture.md` mentions rate limiting under Redis and no ticket built it.

### RFX-120 — Idempotent decisions keyed by `action.id`

**Goal:** Make a retried request with the same action ID return the same decision and count once.

**Acceptance:** Documented in `@reflex/contracts` as an additive clarification under ADR-009. The same ID with different content is rejected, not re-decided. RFX-079 builds its metering on this.

**Why:** Adapters retry on timeouts. Without a stated idempotency key, a retry can be decided twice and billed twice, and RFX-079 would have to invent one later.

### RFX-022 — Deadline and cancellation support

**Goal:** Propagate deadlines/AbortSignal through engine.

**Acceptance:** Timed-out semantic calls terminate and follow fallback policy.

### RFX-106 — Deterministic decision cache and action fingerprint

**Goal:** Cache deterministic decisions by canonical action fingerprint, policy set hash, environment and project (`docs/architecture.md` §11).

**Acceptance:** `adapterMetadata`, IDs and timestamps are not part of the fingerprint (ADR-001 §3.4). A policy change invalidates by construction, because the hash is in the key. The cached path meets its p95 budget. Every test passes with the cache disabled or flushed.

**Why:** The architecture has a caching section and `CLAUDE.md` has a budget for it, and neither had a ticket.

### RFX-023 — Structured decision telemetry

**Goal:** Emit latency/effect/cache/fallback metrics.

**Acceptance:** Telemetry contains no raw action arguments.

### RFX-024 — Gateway benchmark harness

**Goal:** Create repeatable local benchmark.

**Acceptance:** Baseline report produced for deterministic path. Every number states where it was measured: inside the engine, and end to end from the hook (ADR-010).

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G4 — Semantic provider / Jev

### RFX-025 — Define SemanticDecisionProvider interface

**Goal:** Finalize provider abstraction package.

**Acceptance:** Core compiles with fake provider and without Jev dependency.

### RFX-026 — Implement Jev client boundary

**Goal:** Create authenticated Jev transport with timeout/retry policy.

**Acceptance:** Transport errors map to typed provider errors.

**Note:** no in-band retries on the decision path. A retry spends the latency budget twice; the decision path has a deadline and a fallback for that. A retry policy applies to background calls only.

### RFX-027 — Map Jev outputs to semantic signals

**Goal:** Implement structured mapping and validation.

**Acceptance:** Malformed/partial provider output never becomes an implicit allow.

### RFX-107 — Semantic latency and cost spike

**Goal:** Measure, against the real provider, the latency and cost of assessing the eleven dimensions: one call, batched, and parallel.

**Acceptance:** A written result with p50, p95 and cost per 1,000 governed actions, and a recommendation that RFX-028 then implements. If the p95 budget of 400 ms is out of reach, that is reported before RFX-028 starts.

**Why:** RFX-028 assumes parallel per-dimension calls. Eleven model calls per action against a 400 ms p95 is a hypothesis to test, not a design to build.

### RFX-028 — Implement parallel semantic dimensions

**Goal:** Evaluate independent dimensions with bounded concurrency.

**Acceptance:** Result includes confidence for each required dimension.

### RFX-029 — Provider fixture/fake implementation

**Goal:** Add deterministic fake provider for tests/dev.

**Acceptance:** Entire decision engine test suite runs offline.

### RFX-108 — Prompt-injection corpus for the semantic path

**Goal:** Add adversarial cases where attacker-controlled text (tool arguments, MCP tool descriptions, task summaries, file content quoted in arguments) instructs the assessor to rate the action as safe.

**Acceptance:** Every case has a clean twin without the injected text. Injection must not lower any risk dimension, or raise any confidence, beyond a stated tolerance relative to the twin. Untrusted text reaches the provider as delimited data, never as instructions. The corpus runs offline against the fake provider for plumbing and on demand against the real provider.

**Why:** The assessor is a model reading text the adversary wrote. The backlog covered secrets leaking out (RFX-035) and nothing about instructions leaking in.

### RFX-030 — Semantic provider latency telemetry

**Goal:** Record provider/model/dimension latencies.

**Acceptance:** Dashboard-ready metrics exposed without sensitive inputs.

### RFX-109 — Semantic decision cache

**Goal:** Cache semantic assessments only for explicitly safe, repeatable classes.

**Acceptance:** Destructive, financial, production, privilege, credential and external-write actions are never served from cache (`docs/architecture.md` §11), enforced by test. A cached semantic decision meets p95 < 20 ms.

**Depends on:** RFX-106.

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

**Acceptance:** Median test corpus stays under configured token budget, measured with a named tokenizer.

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

### RFX-110 — Confidence calibration

**Goal:** Measure how well provider confidence predicts correctness on the corpus, and set the low-confidence threshold from that data.

**Acceptance:** The eval harness produces a reliability table per dimension. The threshold used by RFX-037 is justified by it, and is re-checked whenever the provider or model changes.

**Why:** RFX-037 escalates on low confidence. A model's self-reported confidence is not calibrated until someone measures it.

### RFX-038 — Create golden eval corpus

**Goal:** Add safe/destructive/off-task/secret/prod/financial cases.

**Acceptance:** Each case has expected acceptable effects.

**Depends on:** RFX-105. This extends the corpus started there with the semantic cases.

### RFX-039 — Implement replay/eval harness

**Goal:** Run engine version against corpus and summarize regressions.

**Acceptance:** CI can fail on dangerous false-allow regression.

**Depends on:** RFX-105. This extends the runner started there to the full engine.

### RFX-040 — Add regression threshold CI gate

**Goal:** Define initial false-allow safety threshold.

**Acceptance:** Any new dangerous false allow fails CI.

### RFX-111 — Mutation testing for security-sensitive packages

**Goal:** Run mutation testing on the policy engine, the classifier, redaction and the aggregator.

**Acceptance:** A surviving mutant in a decision path fails a scheduled check or is explicitly justified in the repository.

**Why:** In G1, manual mutation checks caught what ordinary tests did not, including a parser that reordered keys. For the packages where a missed branch is a false allow, that should not depend on someone remembering to do it.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G7 — Claude Code adapter

RFX-041, RFX-042 and RFX-044 moved to G1.5, where the adapter is first exercised in Observe. This gate adds decisions to it.

### RFX-043 — Implement Claude decision mapper

**Goal:** Map allow/ask/deny to supported native permission behavior.

**Acceptance:** ASK delegates to host approval; DENY reliably blocks where supported.

### RFX-123 — Consent before action content leaves the machine

**Goal:** Ask once, clearly, before the first time tool arguments are sent to a remote gateway or semantic provider.

**Acceptance:** Nothing is uploaded before consent. The prompt states what is sent, what is redacted first and where it goes. Declining keeps the local deterministic path fully working.

**Why:** A developer's commands and file paths leaving the machine is the moment trust is won or lost, and it happens for the first time in this gate.

### RFX-045 — Claude Observe mode

**Goal:** Evaluate/record without changing execution.

**Acceptance:** No observed action is blocked or auto-approved in Observe.

### RFX-046 — Claude Assist mode

**Goal:** Auto-resolve safe supported actions and delegate others.

**Acceptance:** Unsafe/uncertain fixture always reaches native approval or block.

### RFX-124 — Host hook schema canary

**Goal:** Detect when a new host version changes the hook payload or the output contract the adapter relies on.

**Acceptance:** A scheduled job runs the adapter fixtures against the latest host release and fails on drift. At runtime, a payload the adapter does not recognize is a typed failure that follows the fail-behavior rules, never a guess.

**Why:** Host hook schemas change outside REFLEX's release cycle. `docs/integrations.md` requires fixture tests against the currently supported schema; nothing noticed when "currently" moved.

### RFX-125 — Override path for a DENY in Autopilot

**Goal:** Give the human a deliberate, audited way to proceed after REFLEX denies an action in Autopilot.

**Acceptance:** The override is performed by the human outside the agent's reach, is recorded with the decision it overrides, and feeds the human override rate. A mandatory deny is not overridable this way.

**Why:** Human override rate is a product metric and there was no mechanism to override anything. A deny with no exit gets REFLEX uninstalled.

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

### RFX-093 — Capture action outcomes in Codex

**Goal:** Record an `ActionOutcome` for each governed Codex action, using the signals that `PreToolUse` and `PermissionRequest` expose.

**Acceptance:** Fixture tests cover the same four cases as RFX-092. Where Codex exposes no signal, the outcome says `unknown`.

**Depends on:** RFX-091.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G9 — CLI and zero-friction onboarding

RFX-052, RFX-053, RFX-056, RFX-057 and RFX-058 moved to G1.5. This gate completes the CLI once policies and decisions exist.

### RFX-054 — Generate starter `.reflex/policy.yaml`

**Goal:** Create readable conservative starter policy.

**Acceptance:** Existing file never overwritten without explicit user action.

### RFX-055 — Implement `rfx doctor`

**Goal:** Diagnose adapters, gateway, policy, auth and host config.

**Acceptance:** Each failure includes concrete remediation.

### RFX-126 — Implement `rfx pause`

**Goal:** Let the user suspend enforcement for a bounded time when REFLEX misbehaves, without uninstalling it.

**Acceptance:** The pause has a mandatory duration, is visible in `rfx status`, ends automatically, and is audited. While paused REFLEX keeps observing. The agent cannot invoke it.

**Why:** The alternative to a break-glass is `rfx uninstall`, and an uninstalled REFLEX protects nothing.

### RFX-127 — Signed releases

**Goal:** Publish the CLI and SDK with build provenance, from `.github/workflows/release.yml`.

**Acceptance:** A published artifact can be verified against the commit and workflow that built it. Publishing is only possible from CI.

**Why:** `rfx` installs itself into every tool call. `release.yml` is in the architecture layout and had no ticket.

### RFX-099 — Implement `rfx explain`

**Goal:** Show why an action would be allowed, asked or denied: matched rules, precedence and final effect.

**Acceptance:** The output comes from the same evaluation the engine performs, not from a re-implementation. It works offline against the local policy.

**Depends on:** RFX-015.

**Why:** `CLAUDE.md` principle 6 requires every policy resolution to be explainable through matched rules, precedence and final effect. Nothing exposed that to the user.

### RFX-104 — Workspace trust for project policies

**Goal:** Treat a repository's `.reflex/policy.yaml` as untrusted until the user trusts it.

**Acceptance:** An untrusted project policy can tighten (its deny and ask rules apply) and cannot loosen (its allow rules are ignored). Trust is bound to the policy content hash and asked again when the content changes. The prompt shows what the policy would allow. The agent cannot answer the prompt.

**Depends on:** RFX-102, RFX-016.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G10 — Persistence and Observe product

### RFX-078 — API key/project auth

**Goal:** Issue scoped keys for decision API.

**Acceptance:** Keys are hashed at rest and revocable.

**G10 scope:** moved here from G14. Multi-tenant persistence needs an authenticated principal before the first row is written, or "tenant IDs mandatory" (RFX-059) has nothing to be checked against.

### RFX-085 — Audit log

**Goal:** Record policy/mode/member/security changes.

**Acceptance:** Audit log is append-only at application layer.

**G10 scope:** moved here from G16, because RFX-066 (G11) requires mode changes to be audited. Policy, mode and security events start here. Member events join in G16 with RFX-082.

### RFX-059 — Create control-plane DB schema

**Goal:** Organizations/projects/agents/policy versions/decisions/feedback.

**Acceptance:** Migrations are reversible and tenant IDs mandatory.

### RFX-122 — Tenant isolation defence in depth

**Goal:** Enforce tenant isolation in the database as well as in the application, with row-level security keyed on the authenticated organization.

**Acceptance:** A query issued without a tenant context returns no rows. A test attempts cross-tenant reads and writes through every repository function and fails to get any.

**Depends on:** RFX-078, RFX-059.

**Why:** Application-level checks fail open when one query forgets its filter. `CLAUDE.md` lists tenant isolation as security-sensitive code.

### RFX-060 — Persist redacted decision events

**Goal:** Store canonical redacted event plus decision metadata.

**Acceptance:** No raw secret fixture can be found in DB dump.

### RFX-061 — Implement project claim flow

**Goal:** Claim anonymous/local install into account.

**Acceptance:** Existing local project identity links without losing history.

### RFX-062 — Decision timeline API

**Goal:** Paginated/filterable decision event endpoint.

**Acceptance:** Filters by effect, agent, tool, risk, time.

### RFX-121 — Data retention and deletion

**Goal:** Apply per-organization retention to events and arguments, and delete an organization's or a project's data on request.

**Acceptance:** Expired events are removed by a scheduled job with a test that proves it. A deletion request removes decisions, outcomes and feedback, and leaves an audit entry that contains no deleted content.

**Why:** `docs/architecture.md` §10 promises per-organization retention and nothing implemented it. Developers' commands and file paths are personal data in most jurisdictions.

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

**Depends on:** RFX-091. The opportunity it reports is measured from observed outcomes, and any estimated figure is labelled as an estimate.

### RFX-066 — Mode switch UX

**Goal:** Observe → Assist → Autopilot with explicit consequences.

**Acceptance:** Mode changes are audited and immediately reflected in config.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G12 — Feedback and Approval Learning

### RFX-067 — Decision feedback endpoint/UI

**Goal:** Correct/should allow/ask/deny feedback.

**Acceptance:** Feedback is immutable/audited and associated with decision version.

### RFX-068 — Repeated-approval pattern miner

**Goal:** Cluster deterministically similar approvals: same tool, same normalized command or path pattern, same resource class. Semantic similarity is RFX-128.

**Acceptance:** Suggestions include evidence count and scope.

**Depends on:** RFX-091. The approvals being mined are the host's native approvals, which only `ActionOutcome` records.

### RFX-128 — Semantic similarity clustering for approvals

**Goal:** Group approvals that are similar in meaning but differ textually, on top of the deterministic clusters from RFX-068.

**Acceptance:** A suggestion produced from a semantic cluster shows every member action as evidence, and a replay (RFX-070) over history shows no newly allowed dangerous case.

**Depends on:** RFX-068, RFX-070.

**Why:** RFX-068 bundled a tractable problem with a research problem. Splitting them lets the deterministic miner ship and be trusted first.

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

RFX-078 moved to G10, ahead of the first multi-tenant persistence.

### RFX-076 — TypeScript `reflex.guard()`

**Goal:** Wrap tool collections with decision enforcement.

**Acceptance:** Existing tool signatures preserved.

### RFX-077 — Python guard SDK

**Goal:** Python equivalent with async support.

**Acceptance:** Parity contract tests pass across TS/Python.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G15 — Billing and paid value

### RFX-079 — Governed-action metering

**Goal:** Count billable governed actions idempotently.

**Acceptance:** Retries cannot double bill.

**Depends on:** RFX-120.

### RFX-080 — Plan/limit enforcement

**Goal:** Developer/Pro/Team/Scale entitlements.

**Acceptance:** Limit behavior never disables safety enforcement silently.

### RFX-081 — ROI/value metrics

**Goal:** Compute approval prompts eliminated and configurable time estimate.

**Acceptance:** Estimated time is visibly labelled and assumption configurable.

**Depends on:** RFX-091. In Assist and Autopilot the counterfactual prompt is not observable, so the figure is an estimate from Observe-period base rates and is labelled as one.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.

## G16 — Team foundations

RFX-085 moved to G10, ahead of the audited mode switch in G11.

### RFX-082 — Organizations and memberships

**Goal:** Owner/admin/member roles.

**Acceptance:** Tenant isolation tests cover every org-scoped endpoint.

### RFX-083 — Shared project policies

**Goal:** Team policy publishing/versioning.

**Acceptance:** Clients consume immutable signed config snapshot.

### RFX-084 — Environment policies

**Goal:** Distinct staging/production rules.

**Acceptance:** Production policy cannot be weakened by local project policy.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression.
