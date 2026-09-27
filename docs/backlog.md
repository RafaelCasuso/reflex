# REFLEX Build Backlog

This backlog is ordered by **gates**, not by feature excitement. A gate may not close until all exit criteria pass.

Ticket IDs are stable. Claude Code should reference them in commits/PRs.

**Status convention.** A ticket carries a `**Status:**` line only once work on it has happened. `Done` means every acceptance criterion was verified, and the line says how. `Implemented, verification pending` means the work is complete but a criterion cannot be verified yet, and the line says exactly what is missing. No status line means not started.

**Ticket template.** New tickets carry a Goal and a measurable Acceptance: it names the corpus, the threshold and the machine, so that two people would agree on whether it passed. Where they apply, a ticket also carries Depends on, Out of scope, Why, and the test layers it owes (unit, contract, adapter fixture, adversarial, latency, replay; see `CLAUDE.md`). Older tickets are brought up to the template when their gate starts, not before.

**Gate exits.** Every gate keeps the common exit sentence. The "Specifically" clause after it names what has to be demonstrably true for that gate; it restates the gate's own acceptance criteria as one checkable list and adds nothing new.

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

**Status:** Done (2026-09-19). `adapter-claude-code/src/detect.ts` and `settings.ts` are pure: paths and text in, a plan out. `planInit` reads the three settings scopes plus the managed settings and writes nothing; a test lists the whole tree before and after to prove it. The plan carries the exact bytes to be written and the SHA-256 of the bytes it was computed from. Default scope is `.claude/settings.local.json`, because the hook command holds a machine-specific path and the shared project file would give every teammate a failing hook. It reports `disableAllHooks` and `allowManagedHooksOnly`, which would leave REFLEX installed and never run.

### RFX-042 — Implement Claude hook input translator

**Goal:** Translate supported hook payload into CanonicalAction.

**Acceptance:** Fixture tests cover Bash, file edits and MCP calls.

**G1.5 scope:** `sideEffectClass` is `unknown` unless it is trivially known. Classification arrives with the command classifier, and until then unknown is the honest value (ADR-001 §4).

**Status:** Done (2026-09-19). Fixtures for Bash, Write, Edit and an MCP call translate to actions the contract accepts. The envelope is validated by hand (no schema library in a per-call process), tolerates fields and events a newer host adds, and returns a typed failure for one it cannot use. Arguments pass through as received and are never read. `sideEffectClass` is `unknown` for everything except WebSearch and TodoWrite, and never for an MCP tool: `Read` is a local read until the path is a credentials file. IDs are derived by hashing, so every event about one tool call yields the same `ActionId` with no shared state. **Provenance:** the `Bash` fixtures were captured from a live Claude Code 2.1.276 (RFX-087), with identifiers and paths replaced, and since 2026-09-21 so are the Write, Read, Edit, WebFetch, ToolSearch and MCP fixtures (RFX-089), which confirmed the `tool_input` names taken from `sdk-tools.d.ts` (a documentation summary had given wrong ones for Write and Edit). Two files remain constructed and the fixtures' README says which. **Corrected by RFX-089's live runs:** the MCP namespace now comes from the host's `mcp_server` and not from splitting the tool name, and `ToolSearch` is classed `none`; see RFX-089. Arguments are no longer "never read": since ADR-011 the adapter copies three of them into `operands`, and reads nothing else.

### RFX-091 — Decide ADR-013 and add the `ActionOutcome` contract

**Goal:** Define a separate contract for what the host did with an action: whether it prompted, what the human answered, whether the action executed, and when. Keyed by `actionId`.

**Acceptance:** ADR-013 is accepted. The contract is added as an additive change under ADR-009 with frozen fixtures. It carries no tool output and no argument values, and it represents a signal the host does not expose as `unknown`, never as a guess.

**Status:** Done (2026-09-19). ADR-013 accepted with option A. `outcome.ts` adds `ActionOutcome` (`actionId`, `prompted`, `humanResponse`, `executed`, `observedAt`) and `parseActionOutcome`. It is read strictly, carries no tool output and no argument values, and rejects a record that contradicts itself (an answer without a question, a rejected action that ran). Shipped as contract version 1.1 by the ADR-009 procedure, its first real use: `fixtures/v1.1/` is frozen and checksum-locked, and `fixtures/v1.0/` is byte-identical to its release.

**Why:** Without it the north-star metric, "approval prompts eliminated", the activation card and Approval Learning (which mines the host's native approvals) have no data to be computed from.

### RFX-044 — Implement reversible Claude installer

**Goal:** Install project-scoped config/hook and create backup.

**Acceptance:** `rfx uninstall` removes exactly what REFLEX added and leaves every other byte untouched, including edits the user made after installing. When the file has not changed since install, the result is byte-identical to the backup.

**Status:** Done (2026-09-19). Install and uninstall are surgical text edits (`jsonc-parser`), tested across nine formatting styles: indentation, CRLF, comments, trailing commas, compact and empty files all keep their bytes. `rfx uninstall` restores the original byte for byte (mode included) when the file is unchanged since install, removes a file REFLEX itself created, and otherwise removes only REFLEX's entries and keeps the user's later edits. A tampered backup is detected by checksum and falls back to surgical removal. REFLEX's entries are recognized by a leading `REFLEX_MANAGED=1`; a user hook that merely mentions it survives. Idempotent and self-healing. Explicit 5 s hook timeout (the host default is 600 s).

### RFX-052 — Implement `rfx init` detector

**Goal:** Scan supported agents and MCP configs.

**Acceptance:** Command prints deterministic plan before mutation.

**G1.5 scope:** Claude Code only. Codex and MCP detection are added by their own gates.

**Status:** Done (2026-09-19). `rfx init` prints the plan before anything is touched: the file, create or modify, the events, the exact command, the backup location and any warnings. The same state yields the same plan text byte for byte. Without a terminal and without `--yes` it prints the plan and changes nothing; `--dry-run` does the same explicitly. If the file changes while the plan is on screen, nothing is written. Claude Code only, per the G1.5 scope.

### RFX-053 — Implement backup transaction

**Goal:** All config writes participate in reversible transaction.

**Acceptance:** Partial failure rolls back prior modifications.

**Status:** Done (2026-09-19). `packages/cli/src/backups/`. A transaction is applied from a plan the user has already seen, in three phases: verify every file still has the bytes the plan was computed from, back everything up, then write. A failed write restores every earlier one (and the half-written one) byte for byte and mode for mode, and removes files it created. If rollback itself fails, the result says so and names the files to recover from the backup directory. Writes are atomic, preserve permission bits such as `0600` on a user settings file, go through a symlink instead of replacing it, and backups are readable only by the user.

### RFX-086 — Local Observe recorder

**Goal:** Append one structured record per observed action to a local, size-bounded log that the user owns.

**Acceptance:** The hook never changes what the host does (no block, no auto-approval, no added prompt), including when the recorder itself fails. A record carries tool, operation, side-effect class, timestamps and the shape of the arguments (keys, types, sizes), and never a raw argument value until RFX-031 lands. The log rotates at a fixed size.

**Depends on:** RFX-042.

**Status:** Done (2026-09-19). `@reflex/telemetry` plus `rfx hook claude-code`. The real binary is run as a child process against every failure mode (empty, truncated, binary garbage, a nesting bomb, a 4 MB payload, an unwritable state directory, an unknown host): it always exits 0 with nothing on stdout or stderr. Records carry tool, side-effect class, timestamps and the argument shape; tests plant a secret in the command, in nested values, in a tool response and in the transcript path, and assert it is nowhere on disk. An adversarial test found that the first key-name rule let a token used as a map key reach the log; the rule is now narrow (identifier-like, short, few digits, top two levels only). JSONL, `0600` in a `0700` directory under `~/.reflex`, rotated at 5 MB with three files kept; 400 concurrent appends keep every record whole.

### RFX-092 — Capture action outcomes in Claude Code

**Goal:** Record an `ActionOutcome` for each observed action from the host's post-execution and permission signals.

**Acceptance:** Fixture tests cover: executed without a prompt, prompted and approved, prompted and rejected, blocked by the host. Capturing an outcome never changes what the host does.

**Depends on:** RFX-091, RFX-086.

**Status:** Done (2026-09-19). Host events map to four host-agnostic signals plus the end of a turn, and a pure function assembles them into a contract-valid `ActionOutcome`. Fixtures cover executed without a prompt, prompted and approved, prompted and rejected, and blocked by the host, end to end from the stdin payload. All 32 combinations of signals are run through the contract parser, which rejects self-contradicting records. A signal the host did not identify is dropped instead of being attached to a guessed action. **Corrected by RFX-087's live runs (2026-09-19):** (1) `PermissionRequest` carries no `tool_use_id`, so the prompt signal was being dropped and no action could ever have been seen as prompted; it is now recorded with the session and the tool name, and attributed to the latest unprompted, uncompleted action of that session and tool whose turn has not ended. Nothing derived from the arguments is used. Adversarial tests hold that it never crosses sessions, tools, MCP namespaces, completed actions or the end of a turn, and that one prompt marks one action. Known limit: two parallel calls to the same tool can swap a prompt; counts stay right. (2) `PostToolUseFailure` fires for a command that ran and exited non-zero, so a failure now means `executed: yes`, not `unknown`. (3) Confirmed: a call that is not approved leaves no completion event, only the prompt and then the end of the turn, which is what the `rejected` rule reads. It was observed headless; a human pressing "no" is still unobserved, and RFX-089's runs, headless too, did not change that. A call blocked by a hook leaves no trace at all and is reported as `unknown`.

### RFX-087 — Verify host behavior when the hook fails

**Goal:** Establish, with fixtures against the supported Claude Code version, what the host does when the REFLEX hook crashes, times out, exits non-zero, prints malformed output or is missing.

**Acceptance:** A documented table of failure to host behavior, every row backed by a fixture test. Any row where the host proceeds silently is listed as a fail-open path that a later gate must close or surface.

**Why:** `CLAUDE.md` principle 5 says REFLEX may never silently disappear from the execution path. That only holds if the host cooperates, and it has to be known before Assist or Autopilot rely on it.

**Status:** Done (2026-09-19). Verified against a live Claude Code 2.1.276 with `packages/adapter-claude-code/live/verify-hook-failures.mjs`: eleven headless sessions, each in a scratch project with one hook that misbehaves in one way, the answer read from the disk and not from the model (under $0.40 of quota in total, re-runs included). A crash (exit 1), invalid output, a timeout and a missing command all **fail open**; exit 2 and an explicit `deny` block; `disableAllHooks` runs no hook at all. Every row of the table in `docs/claude-code-hook.md` §3 is backed by a recorded run, the record is checked in, and `src/live-evidence.test.ts` holds the table to it in CI and replays the host's real payloads through the adapter. Each fail-open path is mapped to the ticket or ADR that must close it. **The runs also corrected three assumptions in code**, see RFX-092. **Limits, stated rather than hidden:** every run was headless, so the interactive terminal is inferred, not measured; `allowManagedHooksOnly` and exit 2 on other events remain documentation only and are kept out of the table; `PermissionDenied` was never fired by the host.

### RFX-088 — Measure end-to-end hook overhead

**Goal:** Measure what one governed tool call costs as the host experiences it: process start, payload parse, translation, record, exit.

**Acceptance:** A repeatable benchmark with p50 and p95 on a named machine, committed next to its numbers and compared explicitly with the latency budgets in `CLAUDE.md`.

**Why:** Measured on 2026-09-18 (Apple Silicon, Node 24): an empty Node process takes 29.5 ms p50 to start, and 70.5 ms p50 once it loads the contracts and validates one request. A 10 ms deterministic budget cannot be met end to end with one Node process per call, so where decisions run has to be decided with this baseline in hand.

**Status:** Done (2026-09-19). `pnpm --filter @reflex/cli bench`, numbers in `docs/claude-code-hook.md` §4 (Apple M1 Max, Node 24.9, 60 runs per case). End to end a hook call costs p50 48.8 ms and p95 59.3 ms, against a floor of 30.2 ms for an empty Node process. **The deterministic budget (p95 < 10 ms) and the infrastructure budget (p95 < 25 ms) are unreachable with one Node process per call**: the floor alone is three times the first. REFLEX's own ~17 ms is module loading, not work (an ignored event costs as much as a recorded one). Node's compile cache and a dedicated hook entry point were both measured and did not help (0.6 ms and 1.7 ms); the second was reverted. This is the baseline ADR-010 needed.

### RFX-056 — Implement `rfx status`

**Goal:** Show mode, connected adapters, last decision and latency.

**Acceptance:** Works without opening dashboard.

**G1.5 scope:** mode, installed adapters, last recorded action and measured hook overhead. Decision and latency fields appear once a decision engine exists.

**Status:** Done (2026-09-19). Local and offline. Shows the mode, each adapter's health, what was observed in this project (actions, ran without a prompt, prompted with approved and rejected, blocked by the host, and `unknown` counted apart, never folded into "not prompted"), the last action, the hook time measured from inside the process, and the local identity. It re-reads every settings file instead of trusting its own registry, so a hook that was removed or switched off since `rfx init` is reported as `HOOK MISSING` or `DISABLED`. Tool names are stripped of control characters before printing: an MCP server chooses its tool names, and a terminal runs escape sequences.

### RFX-057 — Implement `rfx uninstall`

**Goal:** Remove hooks/adapter and restore backups.

**Acceptance:** Idempotent; leaves user's unrelated config untouched.

**Status:** Done (2026-09-19). Idempotent: with nothing installed it says so and exits 0. It only touches this project's installs, finds REFLEX hooks its own registry has lost track of, and leaves a settings file it cannot parse alone while saying how to clean it by hand. Observations, backups and the local identity are kept under `~/.reflex` and the command says where; `--purge` deletes them.

### RFX-058 — Anonymous local Observe identity

**Goal:** Allow first value without signup.

**Acceptance:** User can govern actions locally before creating cloud account.

**G1.5 scope:** the local identity only. Governing arrives with the decision engine.

**Status:** Done (2026-09-19). `rfx init` creates a random `agt_` identity and a random `prj_` identity per project, in `~/.reflex`, mode `0600`, holding nothing about the user or the machine, and sent nowhere. Project identities are stored apart from installs so that they survive `rfx uninstall` and a re-install: a test caught the first version orphaning a project's history, which is exactly what a later claim (RFX-061) must not find.

### RFX-089 — Validate ADR-001 against real payloads

**Goal:** Compare the canonical action model with the payload shapes actually observed for Bash, file edits and MCP calls.

**Acceptance:** A short written review: canonical fields that were never populated, host data that had no canonical home, and candidates for promotion under ADR-001 §3.7. Any resulting contract change follows ADR-009.

**Depends on:** RFX-086.

**Why:** ADR-001 was accepted before a single real payload had been seen.

**Status:** Done (2026-09-21). The review is `docs/canonical-action-review.md`. It rests on payloads a live Claude Code 2.1.276 sent for `Bash` (RFX-087) and, new here, for `Write`, `Read`, `Edit`, `WebFetch` and an MCP tool: `packages/adapter-claude-code/live/capture-tool-payloads.mjs` ran four headless sessions in scratch projects, the MCP server being forty dependency-free lines inside the script, and whether each tool really ran was read from the disk ($0.10 of quota). The record is checked in, nine fixtures are now the host's own payloads, and `src/live-payloads.test.ts` holds the adapter and the review to the record in CI. **No contract change results.** Three host data are recorded as candidates for promotion under ADR-001 §3.7 (a turn identifier from `prompt_id`, the action's own duration, the host's approval mode), each pointed at the ticket that should decide it, and `permission_suggestions` is rejected with reasons. **The payloads corrected the adapter in three places:** (1) the host states an MCP tool's server in `mcp_server`, and the adapter was splitting the tool name instead, which does not split in one way only (`mcp__github__admin__delete`), so a server could be named to be read as another one in exactly the field an allow rule trusts; the namespace now comes from the host, a name that disagrees with it is kept whole, and a statement that cannot be read fails the event. (2) A malformed `mcp__` name used to get no namespace and so passed for one of the host's own tools; it now always gets one. (3) `ToolSearch` exists, runs before the first use of a deferred tool, and is classed `none`. **One defect of this ticket's own, caught by its own suite before commit:** the first fix read `mcp_server` as a string; it is an object with `name` and `source`, so the fix did nothing and every hand-written test passed; only the suite over the live record failed. **Limits, stated rather than hidden:** every run was headless, so a human answering a prompt in the terminal is still unobserved, which was in this ticket's earlier status note and never in its acceptance; `MultiEdit` and `NotebookEdit` were not seen and their argument names still come from the shipped type declarations; one host, one version. An earlier status said only real usage could supply these payloads. That was wrong: a harness could, and did.

### RFX-090 — Supply-chain security workflow

**Goal:** Add `.github/workflows/security.yml` (dependency audit, static analysis, secret scanning) and automated update pull requests for the SHA-pinned actions and the npm dependencies.

**Acceptance:** A vulnerable dependency or a committed secret fails a required check. Pinned actions and dependencies receive update pull requests.

**Why:** From this gate on, REFLEX code runs inside every tool call on a developer's machine. `security.yml` is in the architecture layout and had no ticket, and SHA-pinned actions go stale without an updater.

**Status:** Done (2026-09-19). `.github/workflows/security.yml` (check name **Security gates**): gitleaks over every commit and `pnpm audit --audit-level=high`, on pull requests, on `main`, and weekly, because a dependency can go bad without a commit. gitleaks is installed at a pinned version and refused unless its SHA-256 matches; a tampered checksum was tested and stops the install before anything is unpacked. `.github/dependabot.yml` covers the pinned actions and npm. `tests/ci.test.ts` audits this workflow like `ci.yml`. **Found while building it:** a path-based allowlist for the fake secrets in tests hid real GitHub, AWS and Stripe tokens, because gitleaks skips an allowlisted path entirely in directory mode; the allowlist now matches the finding by exact shape, and a test forbids path rules. CodeQL and dependency review are left out on purpose: they need GitHub Advanced Security, which this private repository does not have. **On GitHub:** the first run is green on pull request #5 ([run 35452976887](https://github.com/RafaelCasuso/reflex/actions/runs/35452976887)): checksum verified, 25 commits scanned with no leaks, audit clean. **Security gates** is now a required status check on `main` next to **Quality gates**, pinned to the GitHub Actions app, with the rest of the branch protection unchanged. **After the merge:** both workflows are green on `main`, and Dependabot opened its first update pull request within minutes (#6). That pull request proposed TypeScript 7 and `@types/node` 26; **Quality gates** failed and the pull request was blocked, the first real pull request a required check has stopped, which is RFX-003's acceptance seen in the wild. Both upgrades are now ignored in `dependabot.yml` with the reason and the condition for lifting them, and a test ties the `@types/node` major to `.nvmrc`.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** on a clean machine `rfx init` reaches a recorded action in under five minutes; `rfx uninstall` leaves no trace; no observed action was blocked, prompted or auto-approved by REFLEX; the log contains no raw argument value.

**Gate status:** Closed (2026-09-21) with RFX-089. All fifteen tickets are done. The gate paid for itself four times: RFX-088 shows the latency budgets cannot be met with one Node process per call (the evidence ADR-010 was waiting for, since decided as a local daemon); RFX-087 shows the host fails open on nearly everything, so fail-closed will have to be REFLEX's own work; the same runs showed that the host's permission event names no call, which would have left every prompt uncounted; and RFX-089 shows that the MCP namespace, the one field an allow rule about an MCP tool trusts, was being guessed from a name that a server can shape. **Carried forward, unobserved:** a human answering a prompt in the interactive terminal. Every live run in this gate was headless. The outcome rules that depend on it (RFX-092) are inferred from the headless trace and say so.

## G2 — Deterministic policy engine

This gate opens with the decisions the policy engine depends on (RFX-112 to RFX-118, RFX-101, RFX-102, RFX-095). Implementation starts at RFX-012, and RFX-105 comes before the matcher so that the engine is built against a corpus from its first ticket.

### RFX-112 — Write ADR-002 decision precedence and effective effect

**Goal:** Write ADR-002, one of the first architectural ADRs that `docs/architecture.md` §14 requires before Gate G2.

**Acceptance:** ADR-002 is accepted and answers: The full table of mode (observe, assist, autopilot) by effect (allow, ask, deny): what `effectiveEffect` is in each cell and what the adapter does. Whether a semantic result can ever lower a deterministic ask. How `risk` and `confidence` are set for a purely deterministic decision.

**Status:** Done (2026-09-20). ADR-002 was written on 2026-09-20 and **accepted by the maintainer the same day, as recommended.** The mode never changes `effect`. Observe reports `effectiveEffect: ask` and emits nothing; Assist never blocks, so a `deny` becomes a request for native approval; a resolved deterministic decision ends the pipeline in both directions; a deterministic decision has confidence 1 and a risk taken from a fixed table by side-effect class.

### RFX-113 — Write ADR-003 fail behavior

**Goal:** Write ADR-003, one of the first architectural ADRs that `docs/architecture.md` §14 requires before Gate G2.

**Acceptance:** ADR-003 is accepted and answers: Which side-effect classes may fail open, and who decides the failure mode: can a client request `fail-open` for a destructive action? What the adapter does when it can reach nothing at all. How a fallback is reported to the user.

**Status:** Done (2026-09-20). ADR-003 was written on 2026-09-20 and **accepted by the maintainer the same day, as recommended.** The failure mode is configuration and the request's `failureMode` only a ceiling on leniency; only `none` and `local-read` may fail open; `fail-open` means deferring to the host and never an allow; a hook client with no daemon answers by itself. The contract comment on `failureMode` now says so.

### RFX-114 — Write ADR-004 policy precedence

**Goal:** Write ADR-004, one of the first architectural ADRs that `docs/architecture.md` §14 requires before Gate G2.

**Acceptance:** ADR-004 is accepted and answers: What `mandatory` means exactly. Whether a lower source can override a non-mandatory rule from a higher source. How `PolicyMatch.precedence` is derived, how ties inside one source are broken, and how `defaults.unresolved` combines across sources. How trust (ADR-012) enters precedence.

**Status:** Done (2026-09-20). ADR-004 was written on 2026-09-20 and **accepted by the maintainer the same day, as recommended.** Defaults cascade down and mandates hold from above: the most specific source with a non-mandatory match decides, and a mandatory rule is a floor no source can go under. `mandatory` is valid on `deny` and `ask` only, rule order never matters, the most restrictive `defaults.unresolved` applies, and an untrusted source's allow rules are dropped.

### RFX-115 — Write ADR-005 provider abstraction

**Goal:** Write ADR-005, one of the first architectural ADRs that `docs/architecture.md` §14 requires before Gate G2.

**Acceptance:** ADR-005 is accepted and answers: Where `SemanticDecisionProvider` and `DecisionEngine` live: in contracts, where they are today, or in `packages/semantic-provider`. The typed provider error model. Confirmation that a partial assessment is an error (ADR-009 reads assessments strictly).

**Status:** Done (2026-09-20). ADR-005 was written on 2026-09-20 and **accepted by the maintainer the same day, as recommended.** Data shapes stay in contracts; `SemanticDecisionProvider` moves to `packages/semantic-provider` and `DecisionEngine` to `packages/core` in RFX-025; `evaluate` resolves to a typed `ProviderResult` and never rejects for an expected outcome; a partial assessment is an error.

### RFX-116 — Write ADR-006 local redaction boundary

**Goal:** Write ADR-006, one of the first architectural ADRs that `docs/architecture.md` §14 requires before Gate G2.

**Acceptance:** ADR-006 is accepted and answers: What is redacted where (adapter, CLI, gateway). What may be written locally before redaction. Whether policy is matched before or after redaction, since a rule about a secret-shaped argument cannot match redacted text. Whether redacted values are hashed so that repeated approvals can still be clustered.

**Status:** Done (2026-09-20). ADR-006 was written on 2026-09-20 and **accepted by the maintainer the same day, as recommended.** Raw values exist only in memory on the user's machine. The policy matcher alone reads the raw action; every stage that writes or sends reads a redacted view of a different type; a redacted value keeps a keyed fingerprint. The maintainer accepted this reading of `CLAUDE.md` principle 2; `CLAUDE.md` is unchanged by it.

### RFX-117 — Write ADR-007 adapter ASK semantics

**Goal:** Write ADR-007, one of the first architectural ADRs that `docs/architecture.md` §14 requires before Gate G2.

**Acceptance:** ADR-007 is accepted and answers: A capability matrix per host: how allow, ask and deny are expressed, and in which hook. What `ask` becomes when the host cannot ask, for example headless or CI runs. How Assist maps onto each host.

**Status:** Done (2026-09-20). ADR-007 was written on 2026-09-20 and **accepted by the maintainer the same day, as recommended.** A capability matrix for Claude Code, Codex and the MCP proxy, with the cells RFX-087 verified marked as such and a ticket named for each of the others; `ask` becomes a refusal and never an allow where nobody can answer; Assist may add a prompt the host alone would not have shown.

### RFX-118 — Write ADR-008 telemetry persistence strategy

**Goal:** Write ADR-008, one of the first architectural ADRs that `docs/architecture.md` §14 requires before Gate G2.

**Acceptance:** ADR-008 is accepted and answers: The measured trigger for moving events from PostgreSQL to ClickHouse. When audit persistence is synchronous. What is never stored. Retention per event class.

**Status:** Done (2026-09-20). ADR-008 was written on 2026-09-20 and **accepted by the maintainer the same day, as recommended.** PostgreSQL until one of two named measurements says otherwise; synchronous audit is a flush to a local journal and never a network call; a never-stored list; retention defaults per event class. Every threshold is a number to measure against, since no event has ever been sent.

### RFX-101 — Write the threat model

**Goal:** Write `docs/security.md`: assets, adversaries (the governed agent, prompt-injected content, a malicious repository, a malicious MCP server, a network attacker, a compromised dependency), trust boundaries and explicit non-goals.

**Acceptance:** Every adversary has at least one mitigation mapped to a ticket, or is listed as an accepted risk. The document states plainly that REFLEX is not a sandbox.

**Why:** The file is in the architecture layout and had no ticket. For a product whose job is to stop dangerous actions, the adversary list is what decides which tests exist.

**Status:** Done (2026-09-20). `docs/security.md`: assets, the six adversaries the ticket names, trust boundaries and explicit non-goals. It opens by saying that REFLEX is not a sandbox and what follows from that. Every adversary has mitigations tied to tickets and at least one accepted risk stated as such. `tests/security.test.ts` holds it to the backlog: the adversaries are exactly the ticket's, every cited ticket exists, and the sandbox statement is present. Several mitigations rest on ADRs that are still `Proposed`; the document cites them as the place where the mitigation is decided, not as decided.

### RFX-102 — Decide ADR-012 self-protection and workspace trust

**Goal:** Decide how REFLEX protects its own configuration and hook registration from the agent it governs, and how much a repository's own policy is trusted.

**Acceptance:** ADR-012 is accepted before RFX-017 starts, and ADR-004 accounts for trust as a dimension of precedence.

**Why:** In Autopilot the agent can edit `.reflex/policy.yaml` or remove the hook. A cloned repository can ship an allow-all policy that outranks the user's own rules.

**Status:** Done (2026-09-20). ADR-012, proposed on 2026-09-18, was **accepted by the maintainer on 2026-09-20, as recommended.** Built-in mandatory rules above every policy source, integrity reporting, and workspace trust under the rule that untrusted can only tighten. Self-protection resolves to `ask`, so a human can still change their own policy through the agent. ADR-004 accounts for trust as its step 1. RFX-017 has not started.

### RFX-095 — Decide ADR-011 normalized operands and classification ownership

**Goal:** Decide what a policy rule matches against (host-shaped `arguments`, or canonical operands for command, paths and network targets) and who computes `sideEffectClass`.

**Acceptance:** ADR-011 is accepted before RFX-013 starts. If it introduces a classifier package, `docs/architecture.md` and the dependency rules in `CLAUDE.md` are updated in the same change.

**Why:** Rules written against `arguments.*` are host-specific, which is the exact failure ADR-001 was written to prevent. `CLAUDE.md` lists a command classifier as security-sensitive code, and no package or ticket for it exists.

**Status:** Done (2026-09-20). ADR-011, proposed on 2026-09-18, was **accepted by the maintainer on 2026-09-20, as recommended.** Canonical operands on the action (O2), one shared classifier that core may escalate and never lower (C3), and asymmetric matching: an allow rule matches only a command that is fully understood, a deny rule matches any segment. It introduces `packages/command-classifier`, so in the same change `docs/architecture.md` §2, the dependency rules in `CLAUDE.md`, the lint boundaries, the boundary test and the workspace test were updated, and the package exists as a skeleton. RFX-013 has not started.

### RFX-012 — Define policy YAML schema

**Goal:** Implement v1 policy document parser.

**Acceptance:** Invalid YAML/schema produces actionable line/path errors.

**Status:** Done (2026-09-20). `packages/policy-engine/src/parser.ts`: a pure function from a string to the contract's `PolicyDocument`, or to every problem found, each with its path in the document (`rules[2].conditions[0].operator`), its line and column, and a message that says what would be right (the valid operators, the closed set a value must come from, the keys a rule has). Problems are reported together, not one at a time. It is strict like every decision input (ADR-009): unknown keys are errors, nothing is defaulted or coerced, and a rule can only be written about a closed list of fields (`fields.ts`, ADR-011), because a rule about a field nobody fills never matches, and for a deny that is a silent weakening. From the accepted ADRs: a mandatory `allow` does not compile (ADR-004 §2), a rule with no condition does not compile (that is what `defaults.unresolved` is for), and `defaults` is optional and stays absent when omitted (ADR-004 §6; the contract type was loosened accordingly, which changes no serialized shape). A policy file is untrusted input (ADR-012): YAML 1.2 only, so `yes` and `no` are words; duplicate keys, aliases, anchors, merge keys, custom tags and a second document in the file are refused; size, rules, conditions, list values and the number of reported issues are bounded; an alias bomb is refused without being expanded; it never throws. One dependency added, `yaml` (ISC, no dependencies of its own), used at policy load and never per call. **Left to their own tickets:** compile-time rejection of unsafe regular expressions (RFX-098; here a pattern is checked for type and length), and `path_within`, `any_of` and `not` (RFX-097).

### RFX-105 — Seed the golden corpus and a minimal replay runner

**Goal:** Create the corpus format and a runner that replays it against the deterministic engine, so the policy engine is developed against it from its first ticket.

**Acceptance:** Each case states its acceptable effects and whether allowing it would be dangerous. CI fails when a dangerous case is allowed. Cases are seeded from G1.5 observations where they exist. RFX-038 and RFX-039 extend this corpus and runner; they do not replace them.

**Why:** Every gate exits on "no known dangerous false-allow regression", and the harness that can detect one arrived in G6. `CLAUDE.md` asks for tests first on decision-sensitive changes.

**Status:** Done (2026-09-20). `packages/evals`: a corpus format, a pure loader, a replay runner and 79 seeded cases in `corpus/v1`, 58 of them dangerous to allow. A case lists every acceptable effect and says whether allowing it would be dangerous; the loader refuses a dangerous case that accepts `allow`, unknown keys at every level, and duplicate IDs, and one bad case fails the whole load so the corpus cannot shrink silently. Every action is parsed strictly by the contract and carries only what an adapter really sends today (`sideEffectClass: unknown` for `Bash` and MCP). Two cases are the payloads a live host sent in RFX-087; the rest are constructed, and cover the families RFX-096 and RFX-018 must defeat (chaining, substitution, quoting, prefixes, encoding, indirect execution, redirects, path traversal, MCP impersonation) plus self-protection, credentials and exfiltration, each with safe twins such as `rm -rf dist coverage`. The runner reports dangerous allows apart from needless blocks, reports autonomy, and counts an evaluator that throws as a failure. **CI fails when a dangerous case is allowed:** shown by runner tests against evaluators built to be wrong, and by fault injection on the seeded replay (`dangerous-allow: rm-rf-home`). Until RFX-015 exists the seeded replay runs against the rule `CLAUDE.md` principle 5 already fixes, that what nothing resolves goes to a human: zero dangerous allows and zero autonomy. RFX-015 swaps in the evaluator in one place, `src/seed-corpus.test.ts`.

### RFX-013 — Implement policy condition matcher

**Goal:** Support equals, not_equals, starts_with, matches, in, exists.

**Acceptance:** Unit tests cover positive, negative and malformed cases.

**Status:** Done (2026-09-20), after ADR-011 was accepted as the ticket requires. `packages/policy-engine/src/subjects.ts` turns an action into what rules are matched against: one subject for a tool call, one per segment for a shell command, each a map from an addressable field to its values. `src/matcher.ts` evaluates `equals`, `not_equals`, `starts_with`, `matches`, `in` and `exists` against it. **One principle decides every case that is not obvious (ADR-011, asymmetric matching): when in doubt, a rule that restricts matches and a rule that permits does not.** An allow rule never matches a command that is not fully understood, needs every value of a list field to satisfy it, is never satisfied by an absent field (under `not` either), does not run a pattern on a text beyond the budgeted length, and reaches an MCP tool only if it names `tool.namespace`. A deny or ask rule matches if any segment or any value matches. Positive, negative and malformed cases are covered for every operator, together with every bypass family of the corpus. A logic error of mine was caught by these tests before it was committed: an absent field under `not` satisfied an allow rule, so "not rm" allowed a tool call that has no command at all. Malformed conditions cannot reach the matcher: the parser rejects them (RFX-012), and a rule built in code is checked again when the set is compiled.

### RFX-096 — Shell command normalization and classifier

**Goal:** Parse a shell command into segments with a real grammar, and classify the side-effect class of each segment.

**Acceptance:** Compound and indirect constructs (`;`, `&&`, pipes, `$(...)`, backticks, `bash -c`, `xargs`, `find -exec`, assignment and `env` prefixes, package-manager scripts) are either decomposed into segments or reported as not understood. An allow rule can only match a command whose every segment is understood. A deny rule matches if any segment matches. A side-effect class can be raised by a later stage and never lowered. The parser has its own latency benchmark.

**Depends on:** RFX-095.

**Why:** `starts_with` and `matches` on raw text cannot defeat the bypasses RFX-018 sets out to test. This ticket is what RFX-018 tests.

**Status:** Done (2026-09-20). `packages/command-classifier`, the package ADR-011 introduced. **Grammar** (`src/shell/parse.ts`): quoting, escapes, `;`, `&&`, `||`, pipes, background, newlines, subshells, redirections with descriptors, here-documents (data for `cat`, code for a shell), here-strings, comments, assignment prefixes, control flow. Every construct is either decomposed or reported, never guessed: `$(...)`, backticks, process substitution, `bash -c '...'`, `eval`, `sudo`, `env`, `nohup`, `timeout`, `xargs`, `find -exec`, loop and function bodies all yield the inner command as a segment of its own, so a deny rule sees the program that really runs; variables, globs, brace expansion, ANSI-C quoting, arithmetic, a shell fed by a pipe, `source` and every syntax error are reported as not understood, with a reason. Every spelling of a program is the same program (`r""m`, `\\rm`, `/bin/rm`, `FOO=1 rm`). **Classifier** (`src/classify.ts`): unknown is never safe; a class is raised and never lowered, by a flag (`find -delete`, `git push --force`, `git -c`), by a path (`cat ~/.ssh/id_ed25519`), by a redirection (`> file`), and it is never better than the understanding behind it; `escalate` is tested over every pair of classes. It also names the paths and network hosts each segment touches, which RFX-097 matches on. **An allow rule can only match a fully understood command and a deny rule matches any segment:** the parser supplies exactly that (`understood` per segment and per command); the rule semantics are enforced where rules are evaluated, in RFX-013 and RFX-015, against the seeded corpus. 188 tests, among them every bypass family of the corpus, and input built to break a parser (nothing throws, depth, segments and length are bounded, parsing stays linear). **Latency benchmark** (Apple M1 Max, Node 24.9, 2,000 runs, `pnpm --filter @reflex/command-classifier bench`): parsing and classifying a typical command costs 0.004 ms at p95, a 200-command chain 0.24 ms, against a budget of 10 ms for the whole evaluation. **Made precise while implementing, and recorded in ADR-011:** a script runner (`pnpm test`, `make`, `./deploy.sh`) is understood, since its program and arguments are visible, and is marked indirect with a class never better than `unknown`; otherwise running the tests could never be allowed by any rule. `docs/security.md` says the same.

### RFX-097 — Path containment and composition operators

**Goal:** Add `path_within`, evaluated after normalization, and boolean composition (`any_of`, `not`) to the matcher.

**Acceptance:** Traversal (`..`), case and trailing-separator tricks cannot make a path outside the root match `path_within`. Composition has a documented truth table. A missing field never satisfies a condition in an allow rule, including under `not`.

**Status:** Done (2026-09-20). Syntax in the parser, semantics in `src/paths.ts` and `src/matcher.ts`. `path_within` takes a directory that starts with `/`, `~`, `${project}` or `${home}` and holds no `..`; paths are normalized lexically (absolute, `.` and `..` resolved, repeated and trailing separators removed, Unicode composed) and then compared by whole segments, so `/work/project-evil` is not within `/work/project`. **Traversal, case and separator tricks:** eight kinds are tested against an allow rule, none makes a path outside the root match. Case is read by the rule's effect, because the engine cannot know whether the file system tells `Project` from `project`: an allow rule compares exactly, a deny or ask rule ignores case, so `~/.SSH` is still `~/.ssh`. A path that cannot be made absolute, or a root that is unknown, is not within for an allow rule and is within for a deny. **Composition:** `any_of` and `not`, nested at most four deep, with the truth table in the tests; under `not` the reading of a list flips, so that the rule as a whole keeps leaning the same way: in an allow rule `not: path within ~/.ssh` fails if any path is in there, in a deny rule `not: path within ${project}` fires if any path is outside. **A missing field never satisfies a condition in an allow rule, including under `not`:** tested. For a deny rule an absent list field is an empty list, so a rule about paths says nothing about an action that touches none. The contract carries the new operator and the composition types since v1.2.

### RFX-098 — Bounded regular expressions

**Goal:** Make the `matches` operator safe on the hot path.

**Acceptance:** Patterns either run on a linear-time engine or are rejected at policy compile time by a complexity check. A catastrophic-backtracking corpus cannot push a single evaluation past the deterministic latency budget.

**Status:** Done (2026-09-20). `packages/policy-engine/src/pattern.ts`. Both halves of the acceptance, not one: patterns run on a linear-time engine (RE2 semantics, no backtracking, through `re2js`), **and** a pattern is rejected when the policy is compiled if the engine cannot express it in linear time (backreferences, lookaheads, lookbehinds), if it is longer than 1,024 characters, or if its compiled program is larger than 128 instructions. Real policy patterns (cloud keys, tokens, JWTs, SQL verbs, git reads) measure 19 to 93; `(.*a){40}` and `[a-z0-9]{1,500}` do not compile. The parser reports the rejection at the pattern's own line, and the message says what to do and never quotes the pattern. Matching is unanchored, with `^` and `$` to anchor, and `$` is not fooled by a trailing newline (`git status\nrm -rf ~`). **Catastrophic-backtracking corpus:** eleven patterns that take a backtracking engine from seconds to for ever, on texts of 4,096 characters built to keep every state alive. On the benchmark machine (Apple M1 Max, macOS, Node 24.9; 200 runs after 20 warm-ups, `pnpm --filter @reflex/policy-engine bench`) the worst single evaluation is 0.56 ms at p95 and 0.91 ms at its maximum, against a deterministic budget of 10 ms; a realistic token pattern on an ordinary command costs under 0.01 ms. A test also shows that sixteen times the text costs about sixteen times the time. Beyond 4,096 characters matching is still linear: an `allow` rule then does not match, and a `deny` or `ask` rule is evaluated all the same, because a restrictive rule that is skipped is a hole. **Decision recorded:** the maintainer chose a vetted engine as a dependency over a home-grown one for security-sensitive code. `re2js` 2.8 is MIT, has no dependencies of its own and is used at policy compile time and at match time.

### RFX-014 — Implement precedence engine

**Goal:** Resolve mandatory org/env/project/local precedence.

**Acceptance:** Deny/ask/allow precedence is deterministic and exhaustively tested.

**Status:** Done (2026-09-20). `packages/policy-engine/src/precedence.ts` implements ADR-004: trust, floor, cascade, final effect, the derived `precedence` number and the order in which matches are reported, deciding match first and the ones that lost after it. **Exhaustive:** over the 25 rules five sources can contribute (three defaults and two mandates each), every pair and every triple, in two orders each, 5,200 combinations: the final effect is never under any mandatory match, and is always one that a matching rule asked for. A rotation test shows the order of rules never matters. **Trust, adversarial and exhaustive:** for every pair of rules the user's own sources can hold and every rule a hostile repository can ship (2,000 combinations), the result with the repository's rule is never more permissive than without it. That test found a hole in my first implementation before it was committed: an untrusted `ask` took part in the cascade and, being more specific, overrode an organization's default `deny`. Untrusted rules are now a floor and nothing else, and an untrusted `ask` cannot resolve an action by itself; both are recorded in ADR-004 as implementation notes.

### RFX-015 — Implement policy evaluator

**Goal:** Return resolved/unresolved plus matches and latency.

**Acceptance:** Pure evaluation has no I/O and benchmark p95 target under test fixture.

**Status:** Done (2026-09-20). `packages/policy-engine/src/evaluator.ts`: `compilePolicySet` does once everything that can be done once (sources, trust, the most restrictive `defaults.unresolved`, every pattern compiled a single time) and refuses in code what the parser refuses in YAML; `evaluatePolicy` returns the contract's `PolicyEvaluation` (resolved or not, effect, matches, latency) plus what the next stage needs: the default for an unresolved action, the floor an untrusted rule left, the class after classification and whether the action was understood. **Pure:** no I/O anywhere in the package, the same input gives the same output, nothing is mutated, and nothing derived from the action's arguments is returned (a test looks for a canary token, a host and the program name in the serialized result). It never throws, on an empty, unbalanced or two-megabyte command either. **Benchmark, in-engine as ADR-010 defines it** (Apple M1 Max, Node 24.9, 2,000 runs, `pnpm --filter @reflex/policy-engine bench`), against a policy of 201 rules and 50 patterns, larger than a real one on purpose because every rule of every source is evaluated: a typical read 0.11 ms at p95, a six-segment compound command 0.77 ms, a nested bypass attempt 1.31 ms, the worst single run of any case 5.1 ms, against a budget of 10 ms. **The seeded corpus now replays against the real engine** (`packages/evals/src/seed-corpus.test.ts`): with no policy, nothing is allowed and nothing is wrong; with a policy built to tempt it, which allows whatever the classifier calls harmless, there are 0 dangerous allows in 79 cases and 11 of the 19 allowable cases are allowed. The Claude Code adapter now fills the canonical operands, by copying and never by parsing, and the corpus carries them as an adapter would send them.

### RFX-016 — Policy hash and immutable compiled set

**Goal:** Canonicalize and hash compiled policy set.

**Acceptance:** Identical policy content yields identical hash regardless of formatting.

**Note:** design the compiled set so that it can be the payload of the signed snapshot in RFX-083. Signing can come later; the format should not have to change when it does.

**Status:** Done (2026-09-20). `packages/policy-engine/src/canonical.ts`. A policy set has one canonical form, plain JSON with sorted keys and no whitespace, and its hash is `sha256:` over that form. `compilePolicySet` computes both, and the set carries them as `hash` and `canonical`. **Identical content, identical hash, regardless of formatting:** tested against comments, blank lines, indentation, quoting, flow and block style and the order of keys, and also against everything that ADR-004 says never changes a decision: the order of rules, of conditions, of `any_of` branches, of `in` values and of the sources themselves, and `mandatory: false` written out or left out. **Adversarial, the other direction:** eleven changes that do change a decision (an effect, a mandate, a value, an operator, a field, a negation, the default, a rule's id or name, one rule fewer) each change the hash, and so do the source a policy comes from and whether a project is trusted. The hash of a known policy is frozen in a test, so that a change to the canonical form, which would change every recorded hash, cannot happen unnoticed; `POLICY_SET_FORMAT` is inside the hashed payload for that day. **Per the note:** the canonical form is the payload a signed snapshot will carry (RFX-083); signing wraps it and does not change it.

### RFX-017 — Bootstrap coding-agent policy pack

**Goal:** Provide conservative starter rules for common read/test/status operations.

**Acceptance:** Default pack never auto-allows destructive/external/privilege actions.

**Status:** Done (2026-09-20), after ADR-012 was accepted as RFX-102 requires. `packages/policy-engine/src/packs/starter.ts`: the policy `rfx init` will write to `.reflex/policy.yaml` (RFX-054), parsed by the same parser as any other and holding no mandate, because it is the user's file. It allows what only reads, asks when a read leaves the project, allows file tools inside the project except under `.git` and `.github`, and allows `touch`, `mkdir` and a named list of local git commands. **It never allows by itself anything destructive, external, privileged, financial, touching credentials, or of unknown class**, which includes every script runner: `pnpm test` is deliberately not in it, because what `test` means is written in a file this policy has not read; that allowance is the user's to give, or Approval Learning's to suggest. The promise is tested three ways: 64 commands across every dangerous class and every bypass family of the corpus, each checked for not being allowed and for the reason (its class, not being understood, or where it points); `git pull` and `git clone`, which one class cannot show as external, which is why git commands are named one by one; and the golden corpus, replayed with this policy in `packages/evals`: 0 dangerous allows in 79 cases, no unacceptable effect, and real autonomy on the allowable ones.

### RFX-103 — Built-in self-protection rules

**Goal:** Ship mandatory rules, above every policy source, covering writes to REFLEX's configuration, policy files, hook registration in host settings, and REFLEX binaries.

**Acceptance:** No policy source can allow these actions without human approval. Adversarial tests cover indirect writes: redirects, `sed -i`, `mv`, symlinks, editor tools, and a script that performs the write. `rfx doctor` and `rfx status` report a removed or altered hook.

**Depends on:** RFX-102, RFX-096.

**Status:** Implemented, verification pending (2026-09-20). `packages/policy-engine/src/packs/built-in.ts`: three mandatory `ask` rules in the `built-in` source, which `compilePolicySet` adds to every set, so that no caller can leave them out and no policy source can supply or replace them. They cover writes to `.reflex` in the project and in the home directory, to the host's settings that register the hook (`.claude`, `~/.claude.json`, `.codex`), any command that names those files, and `rfx uninstall`, `pause`, `trust` and the like. They ask and do not deny (ADR-012): the user can still change their own policy through the agent, with their approval. **No policy source can allow these actions:** tested with every source (organization, environment, project, local) allowing everything at once; the answer is `ask`, and the deciding match is the built-in one with precedence 150. **Indirect writes, as the ticket lists them:** redirects, `sed -i`, `mv`, `cp`, `tee`, symlinks to and over the file, `jq` rewriting the settings, truncation, `chmod`, code that names the file (`python3 -c`, `node -e`), wrappers, substitutions, after a harmless command, by traversal and by case, and the editor tools. 34 adversarial cases. Reading those files, `rfx status` and unrelated work are not touched. **Said plainly in the tests and in `docs/security.md`:** a script that performs the write without naming the file in its command line is invisible before it runs, because REFLEX is not a sandbox; what holds is that such a script is never of a better class than `unknown`, so nothing that ships allows it. **`rfx status` reports a removed or altered hook:** it already reported `HOOK MISSING` and `DISABLED`; it now also reports `HOOK ALTERED` when the hook keeps REFLEX's marker and no longer runs the command this `rfx` installs, tested against a hook turned into a no-op, pointed at another script, and made to answer `allow`. **Missing:** `rfx doctor` does not exist yet (RFX-055, G9); it has to report the same three states.

### RFX-100 — Policy language reference

**Goal:** Write `docs/policy-language.md`: addressable fields, operators, precedence, worked examples, and what a rule cannot express.

**Acceptance:** Every operator and every addressable field is documented with an example that is executed as a test, so the reference cannot drift from the engine.

**Why:** The file is in the architecture layout and had no ticket. It is the first document a user reads before trusting Autopilot.

**Status:** Done (2026-09-20). `docs/policy-language.md`: the policy file, how a rule is read (the asymmetric table: when in doubt a rule that restricts matches and a rule that permits does not), every addressable field, every operator, `any_of` and `not` with their truth table, sources, mandates, trust and defaults, the built-in rules, a worked example of the hard half of `rm`, the pattern dialect and why backreferences and lookarounds do not compile, the limits, the policy set hash, and **what a rule cannot express**: what a program does, a value that exists only at run time, what a path really points to, counting and dates, the conversation. It opens with the one thing an administrator must not learn the hard way: a local `allow` beats an organization's `deny` unless that `deny` is mandatory. **The reference cannot drift from the engine:** `packages/policy-engine/src/reference.test.ts` reads the page, runs its nine example policies (one of them three sources at once, one untrusted) against the real engine and checks all 58 stated decisions, then checks that every operator of the contract, `any_of`, `not`, every addressable field, every value of every closed set and every limit the parser enforces appears on the page, the operators and fields inside an example that was executed.

### RFX-018 — Adversarial matcher tests

**Goal:** Test shell tricks, quoting, chaining and misleading command prefixes.

**Acceptance:** Known bypass corpus does not bypass explicit deny rules.

**Status:** Done (2026-09-20). `packages/policy-engine/src/bypass.test.ts`: five deny rules a user would really write (nothing deleted outside the project, nothing executed that arrived by a pipe or a here-document, no force push, no reading of SSH keys, no token on a command line) and, for each, every way this suite knows of saying the same thing differently. 129 variants that must all come out as `deny`: quoting (`r""m`, `\\rm`, `'rm'`), other spellings of the program (`/bin/rm`, `/usr/bin/../bin/rm`), misleading prefixes (assignments, `env`, `command`, `exec`, `nohup`, `nice`, `time`, `timeout`, `sudo`, stacked), chaining on either side (`;`, `&&`, `||`, `|`, `&`, newline, a trailing comment), grouping, indirection (`bash -c`, nested `bash -c`, `eval`, `$(...)`, backticks, process substitution, a shell's here-document, `if`, `for`, `while`, a function body), encodings (`base64 -d | sh`, `xxd -r -p | bash`), arguments that cannot be read (`$HOME`, `${HOME}`, globs, `xargs`, `find -exec`), and for paths traversal, case and separators, through the shell and through a file tool. **28 controls** that look alike and must not be denied, because a policy that denies everything passes every bypass test. **The corpus found five defects, all fixed before anything was committed, each now with its own regression test:** `rm -rf $HOME` slipped past "nothing deleted outside the project", because a path that cannot be read was read as no path (a segment whose arguments cannot be read may now point anywhere); `exists` on an empty list was read wrongly under `not`; `curl ... | sudo bash` lost the pipe when `sudo` was unwrapped; `sh -c "$PAYLOAD"` was not marked as running what nobody has read; and `curl -T ~/.ssh/id_ed25519` carried a key out because no paths were taken from `curl`. A new field, `command.reasons`, lets a rule say "deny whatever is fed to a shell". **Said plainly in the suite:** a token assembled at run time is never in the command text, so no deterministic rule can see it; such a command is not understood, nothing allows it, and it goes to a human.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** a mandatory deny is shown by test not to be weakened by any lower source; the bypass corpus and the seeded replay corpus pass; deterministic evaluation meets p95 < 10 ms in-engine on the named benchmark machine.

**Gate status:** Open on one item (2026-09-21). 22 of 23 tickets are done, merged and green in CI on `main`: pull request #10 passed both required checks, Quality gates and Security gates, and was merged on 2026-09-20 as 14 self-contained commits. **The three specific exits hold.** The first two are held by tests that run in CI; the third is a measurement on the named benchmark machine, which CI does not run, because timing does not belong on a shared runner: a mandatory deny is never weakened, shown exhaustively over 5,200 combinations of rules from every source and 2,000 combinations against a hostile repository (RFX-014); the bypass corpus passes, 129 variants against five explicit deny rules with 28 controls (RFX-018), and the seeded replay corpus passes against the real engine with the policy that ships, 0 dangerous allows in 79 cases (RFX-015, RFX-017); deterministic evaluation is 0.11 ms at p95 for a typical action and 1.31 ms for the worst case measured, against 201 rules, in-engine on an Apple M1 Max with Node 24.9, where the budget is 10 ms (RFX-015). **Open:** RFX-103 is implemented and its last criterion cannot be verified yet, because `rfx doctor` belongs to RFX-055 in G9; `rfx status` already reports a removed, disabled or altered hook. **No known dangerous false allow.** Seven defects of the engine's own were found by its tests before they were committed, and each is recorded in the ticket that found it. **What this gate does not claim:** paths are lexical and symbolic links are not resolved; a script that performs a write without naming the file is invisible before it runs; nothing here decides anything yet, because the engine has no caller until G3.

## G3 — Decision engine API

### RFX-094 — Decide ADR-010 decision placement and hook latency

**Goal:** Decide where a decision is made (per-call process, local daemon, compiled binary, remote gateway) and at which points the latency budgets are measured.

**Acceptance:** ADR-010 is accepted before RFX-019 starts. It names the measurement points for every budget in `CLAUDE.md`, and it defines what the hook does when the chosen local component is unavailable.

**Depends on:** RFX-088 for the baseline, RFX-087 for what the host does on hook failure.

**Why:** The budgets, the no-account requirement (RFX-058) and "the data plane must keep working without the dashboard" cannot all hold with one Node process per call talking to a remote gateway.

**Status:** Done (2026-09-20). The maintainer accepted **option B** on 2026-09-20: a local long-lived daemon plus a minimal hook client, after RFX-088 and RFX-107 supplied both halves of the evidence. RFX-019 has not started. As the acceptance requires, ADR-010 now names where every budget in `CLAUDE.md` is measured (in-engine, with end to end from the hook always reported beside it) and what the client does when the daemon does not answer (silent in Observe; its own `ask`, or `deny` under `fail-closed`, in the enforcing modes; never an exit without an answer). `docs/architecture.md` §1, §3 and §12 gained the local branch. The measurement table and the daemon-unavailable rule were written at acceptance; the maintainer accepted every ADR as written later the same day, ADR-003, which owns the full rule, among them. Still open and recorded there: the end-to-end budget, and with it whether the client can remain a Node script.

### RFX-019 — Implement decision engine orchestration

**Goal:** Wire normalize → policy → semantic → aggregate → decision.

**Acceptance:** Deterministically resolved actions never invoke semantic provider.

**Status:** Done (2026-09-22). `createDecisionEngine` in `packages/core` orders the stages as ADR-002 §1 fixes them: deterministic policy; the policy's own default for what no rule decided; the semantic stage, inside the deadline; a fallback when a stage that was needed could not complete. The semantic stage is three seams (`ContextCompiler`, G5; `SemanticDecisionProvider`, G4; `RiskAggregator`, G6) with no default compiler, so the engine can never send an argument value anywhere by itself; with no stage configured, `semantic` is read as `ask` with confidence 0 and no fallback, because nothing failed. The floor of an untrusted policy set (ADR-012) and `deny > ask > allow` are applied by the engine after the aggregator, so an aggregator cannot forget them. **The acceptance is a test in every combination:** a deterministically resolved action never reaches the provider, held with and without the cache, for a rule, for a policy default and for REFLEX's own mandatory rules. Every mode-by-effect cell of ADR-002 §2 is a test, the risk table is held to the ADR's own text, and every decision the engine produces is parsed by the contract. `effect` is computed the same way in every mode. Deterministic evaluation through the whole engine is 0.14 to 1.6 ms at p95 in-engine on an Apple M1 Max (`pnpm --filter @reflex/core bench`). **Assumptions, stated:** `confidence` is 1 for a rule or a policy default and 0 for a fallback; a request's `policySetHash` is informational, the daemon's set decides.

### RFX-020 — Implement failure-mode engine

**Goal:** Implement fail-open/fail-ask/fail-closed with risk-class constraints.

**Acceptance:** Unknown dangerous classes cannot silently fail open by default.

**Status:** Done (2026-09-22). `packages/core/src/fallback.ts` is the table of ADR-003: the strictest of the requested mode, the configured mode and the class floor wins, only `none` and `local-read` may fail open, and `fail-open` decides `ask` with `fallback.configuredMode: fail-open`, which means defer to the host and is never an allow. **The acceptance holds by construction and by test:** every class by every requested and configured mode (90 cases), an adversarial case for a request that asks for `fail-open` on an unknown class with `fail-open` configured, and one for a class the adapter understated (`local-read` declared, `rm -rf` inside); both end at `fail-ask`. Through the engine: a provider that rejects, throws or hangs ends in a reported fallback with its reason code, `fail-closed` denies in Autopilot and prompts in Assist, and an untrusted floor holds through a fallback.

### RFX-021 — Create decision gateway HTTP endpoint

**Goal:** Implement `POST /v1/decisions`.

**Acceptance:** Validated request returns canonical decision with correlation ID.

**Status:** Done (2026-09-22). `apps/decision-gateway` serves `POST /v1/decisions` and `GET /v1/health`, on a Unix domain socket private to the user (directory `0700`, socket `0600`) or on loopback TCP; any other interface is refused until an authenticator exists (G14). ADR-010's implementation notes say why it is this app and why HTTP over the socket. A validated request returns the canonical decision with `X-Reflex-Decision-Id` and the request's `X-Request-Id`, echoed when usable and made up otherwise; every other way out is a typed problem with a closed code and the correlation id, never a stack trace and never a value from the request. Validation is strict at the boundary (ADR-009), and the issues it reports name paths, never values, which a test holds with a secret in the body. `src/main.ts` is the daemon: `--socket`, `--tcp`, `--policy`, `--failure-mode`, `--no-cache`, `--no-telemetry`, `--home`, `--rate-limit`; an unknown flag exits 2; a policy that does not load leaves REFLEX's own rules in force and says so on stderr and in `/v1/health`; `SIGTERM` closes cleanly and removes the socket. Tested as a process. `docs/decision-gateway.md` is the page. **Not in this ticket:** one policy set per project (every action gets the daemon's set; the engine already takes the action when asked for one), and who starts the daemon (RFX-138).

### RFX-119 — Gateway rate limiting and request size limits

**Goal:** Bound what one caller can cost the gateway: request rate per key and body size per request.

**Acceptance:** An over-limit request gets a typed rejection before any validation or decision work is done. Losing rate-limit state (a cache flush) fails safe and does not disable the limit.

**Why:** The gateway is a public endpoint on the hot path. `docs/architecture.md` mentions rate limiting under Redis and no ticket built it.

**Status:** Done (2026-09-22). The rate limit is a token bucket per caller, taken on arrival before anything is read (one caller for a socket; one per address on TCP until API keys name callers); over the limit is `429` with `Retry-After`, and an invalid request from a caller over the limit is turned away without being parsed, which a test holds. The size limit is checked against `Content-Length` before the body is read (`413` without reading) and enforced while reading for a body that lies about its length, which is stopped at the limit and answered `413`. Defaults: 4 MiB, 300 burst, 100 per second; `--rate-limit` changes the latter. **Losing state fails safe:** the store is in memory and bounded, a caller whose bucket was lost starts over with one burst and never with no limit, and a limiter that cannot be built refuses to start rather than letting everything through; tests hold each.

### RFX-120 — Idempotent decisions keyed by `action.id`

**Goal:** Make a retried request with the same action ID return the same decision and count once.

**Acceptance:** Documented in `@reflex/contracts` as an additive clarification under ADR-009. The same ID with different content is rejected, not re-decided. RFX-079 builds its metering on this.

**Why:** Adapters retry on timeouts. Without a stated idempotency key, a retry can be decided twice and billed twice, and RFX-079 would have to invent one later.

**Status:** Done (2026-09-22). The gateway remembers each `action.id` with a hash of its content (the engine's keyed fingerprint of the action, the mode and the requested failure mode; the deadline is left out because a retry has less of it) for ten minutes, bounded. The same id with the same content returns the decision already made, byte for byte, with `X-Reflex-Replayed: true`, and emits no second decision event, so it is counted once; the same id with different content, a different mode or a different failure mode is `409 idempotency-conflict` and is not decided. Adapter metadata is no difference. The contract documents `action.id` as the idempotency key in `packages/contracts/src/action.ts` and its README, a clarification under ADR-009 that changes no wire shape. RFX-079 can build its metering on this.

### RFX-022 — Deadline and cancellation support

**Goal:** Propagate deadlines/AbortSignal through engine.

**Acceptance:** Timed-out semantic calls terminate and follow fallback policy.

**Status:** Done (2026-09-22). The deadline is the request's `deadlineMs`, or the engine's default, and never more than the engine's maximum. What is left of it after policy becomes an `AbortSignal` the provider receives, combined with the caller's; the gateway's caller signal fires when the client goes away. A provider that does not answer in time is terminated and the decision follows the failure mode with reason `timeout`, and so does a cancellation by the caller (ADR-005 §2). When policy alone used the deadline up the provider is not called at all. Whole milliseconds, rounded down: a deadline is never extended. Tests: a provider that hangs, one that is slow but in time, a capped request, a default deadline, a caller's abort, and a clock that makes policy overrun.

### RFX-106 — Deterministic decision cache and action fingerprint

**Goal:** Cache deterministic decisions by canonical action fingerprint, policy set hash, environment and project (`docs/architecture.md` §11).

**Acceptance:** `adapterMetadata`, IDs and timestamps are not part of the fingerprint (ADR-001 §3.4). A policy change invalidates by construction, because the hash is in the key. The cached path meets its p95 budget. Every test passes with the cache disabled or flushed.

**Why:** The architecture has a caching section and `CLAUDE.md` has a budget for it, and neither had a ticket.

**Status:** Done (2026-09-22). `packages/core/src/fingerprint.ts` is a keyed HMAC (ADR-006) of the action with identifiers, timestamps, the adapter's metadata bag, tenancy ids and the prior actions left out, over JSON with sorted keys; the key is random per engine and never written, so no cache key or telemetry field confirms a guessed command. The cache key is the fingerprint, the policy set hash, the project and the environment (`docs/architecture.md` §11), so **a policy change invalidates by construction**, held by a test that replaces the set between two calls. The cache is a bounded LRU with a TTL, and keeps only a decision that is a pure function of the action and the policy set: never a fallback, a semantic decision, an `ask` for want of a provider, a production action, or one of the classes §11 says never to cache. A hit is re-stamped with a new id, the request's mode and `cached: true`. **Every engine test runs with the cache on and off.** Measured in-engine: a hit is 0.011 ms at p95, against a 20 ms budget; the fingerprint and the lookup add about 0.02 ms to a miss. Adversarial: adapter metadata alone hits, a changed argument misses, and one action never answers for another that only looks the same.

### RFX-023 — Structured decision telemetry

**Goal:** Emit latency/effect/cache/fallback metrics.

**Acceptance:** Telemetry contains no raw action arguments.

**Status:** Done (2026-09-22). `packages/telemetry` gains the decision events (`decision`, `fallback`, `rejected`), built from a decision and from three fields of the action selected by name (host, host version, tool), and `DecisionLog`, a local size-rotated JSON-lines log that writes off the caller's path and counts what the disk refuses instead of throwing. The gateway emits after the answer has left, on the next turn of the event loop, and a sink that throws changes nothing, which a test holds. Every item of `docs/architecture.md` §13 is in the decision event: decision id, latency by stage, cache status, provider, effect, risk bucket, fallback, host and host version. **The acceptance is a canary test:** a value for every item of ADR-008 §3 (an environment variable, an authorization header, an API key, a private key, an argument value, a path, an objective, tool output, provider text) goes through the whole pipeline, in the command, the arguments, the operands, the objective, the summary, the working directory and the adapter metadata, and none comes out of any event, for a decision and for a rejected request alike.

### RFX-024 — Gateway benchmark harness

**Goal:** Create repeatable local benchmark.

**Acceptance:** Baseline report produced for deterministic path. Every number states where it was measured: inside the engine, and end to end from the hook (ADR-010).

**Status:** Done (2026-09-22). `apps/decision-gateway/bench/gateway.bench.mjs` starts the built daemon on a socket with a 204-rule policy and measures the deterministic path at the three points ADR-010 names: in-engine (the engine's own report, and `pnpm --filter @reflex/core bench` at sub-millisecond resolution), over the socket from a warm client, and end to end from the start of a hook process to its exit, one process per request. The record is `bench/results/apple-m1-max-node24.json` and `src/bench-evidence.test.ts` holds the table in `docs/decision-gateway.md` §4 to it. **Baseline (Apple M1 Max, Node 24.9):** the gateway adds about 0.3 ms over the engine; a cache hit is 0.19 ms at p95 over the socket; end to end is 49 ms at p50 from a `node:http` client and **33 ms from a `node:net` client**, because loading `node:http` alone costs a per-call process 14 ms. That finding is now a constraint in ADR-010: the hook client writes HTTP/1.1 by hand over `node:net`. The floor for a Node client is about 33 ms, of which 26 ms is Node starting; the daemon is not what stands in the way of an end-to-end budget. Timing is not run in CI.
**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** a deterministically resolved action never reaches a provider; every failure path ends in an explicit, reported fallback; no telemetry field contains an argument value.

**Gate status:** Closed (2026-09-22). All nine tickets are done, merged and green in CI on `main`: pull request #13 passed both required checks, Quality gates and Security gates, and was rebase-merged as four self-contained commits (main head `641686c`). **The three specific exits are tests:** a deterministically resolved action never reaches a provider (`packages/core/src/decision-engine.test.ts`, with and without the cache, for a rule, a policy default and REFLEX's own rules); every failure path ends in an explicit, reported fallback (a provider that rejects, throws or hangs, a caller that cancels, a deadline policy alone used up, each with `fallback.used`, a reason and a reason code, and a `fallback` telemetry event of its own); no telemetry field contains an argument value (`apps/decision-gateway/src/telemetry.test.ts`, canaries for every item of ADR-008 §3 through the whole pipeline). **No known dangerous false allow:** nothing in this gate can produce an `allow` that policy did not, because there is no aggregator yet, and the engine applies the untrusted floor and `deny > ask > allow` after whatever aggregator G6 brings. **What this gate does not claim:** no semantic stage runs; every action gets the daemon's one policy set; nothing starts the daemon (RFX-138); TCP has no authentication and binds loopback only; the end-to-end number has no budget yet (ADR-010), and what this gate measured is that a Node client cannot go under about 33 ms.

## G4 — Semantic provider / Jev

### RFX-025 — Define SemanticDecisionProvider interface

**Goal:** Finalize provider abstraction package.

**Acceptance:** Core compiles with fake provider and without Jev dependency.

**Note (2026-09-22):** the move from `packages/contracts` to `packages/semantic-provider` brings the typed `ProviderResult` of ADR-005 §2, and core's `assess()` in `packages/core/src/decision-engine.ts` becomes an exhaustive switch over it. R0 (RDM Gate 0) starts from this ticket and RFX-029.

**Status:** Done (2026-09-22). `SemanticDecisionProvider` and `DecisionEngine` left `packages/contracts` (ADR-005 §1): the provider interface lives in `packages/semantic-provider` with the typed `ProviderResult` of ADR-005 §2 (`timeout`, `aborted`, `unavailable`, `rate-limited`, `rejected-request`, `invalid-response`, each with a `retryable` flag for background callers and a mapping to the fallback reasons of ADR-003), and the engine interface in `packages/core`. Core's `assess()` is now an exhaustive switch over the result; a provider or compiler that throws is handled as `unavailable`. No serialized shape changed, so the contract version did not move; the contracts README says so. **Acceptance:** core compiles and its 196 tests run against the fake provider, with no provider package installed; the boundary test still forbids `core -> provider-jev`.

### RFX-026 — Implement Jev client boundary

**Goal:** Create authenticated Jev transport with timeout/retry policy.

**Acceptance:** Transport errors map to typed provider errors.

**Note:** no in-band retries on the decision path. A retry spends the latency budget twice; the decision path has a deadline and a fallback for that. A retry policy applies to background calls only.

**Status:** Done (2026-09-22). `createJevProvider({ apiKey, model, endpoint, booleanForm, fetch, onUsage })` in `packages/provider-jev`: one `fetch` per assessment over a kept connection, the key given and never read from the environment inside the package, the request's deadline as the provider's own `AbortSignal` combined with the caller's. **Transport errors map to typed provider errors:** 401, 403, 400 and 422 to `rejected-request`; 429 to `rate-limited`; 529 and every other status or network failure to `unavailable`; the provider's deadline to `timeout` and the caller's signal to `aborted`; a body that is not JSON or not the answer asked for to `invalid-response`. **Never a retry** on the decision path, held by a test on every status. The key and the provider's words never appear in a result, held by a test. An alias for the model is refused at construction. `onUsage` reports status, latency and tokens off the decision path, never content. **Not yet verified live:** `live/verify-provider.mjs --run` exists, costs about a cent, and waits for the maintainer's permission. **2026-09-25:** the live run (`live/verify-provider.mjs --run`, nine requests) was refused by the transaction guard of the session that tried it; it waits for the maintainer: `cd packages/provider-jev && node --env-file=../../.env live/verify-provider.mjs --run`.

### RFX-027 — Map Jev outputs to semantic signals

**Goal:** Implement structured mapping and validation.

**Acceptance:** Malformed/partial provider output never becomes an implicit allow.

**Status:** Done (2026-09-22). `packages/provider-jev/src/response.ts` reads the provider's answers strictly into `SemanticAssessment`: the eleven questions of the contract, as constants that never contain anything from the request; a score mapped to its nearest level on 0, 33, 67, 100 (coarse on purpose, `docs/jev-provider.md` §3); the boolean asked as a two-option `choice` so that it carries the provider's confidence, with the `noul` form kept for comparison and a confidence derived from the distance to one half, never a constant; the versioned model requested and any other model answered, alias included, refused. **Malformed or partial output never becomes an implicit allow:** a missing dimension, an extra answer (an answer that names an effect among them), the wrong answer type, probabilities that do not describe the levels or do not sum to one, a score or a confidence out of range, a legend with a level missing, a body that is a decision instead of an answer: fifteen adversarial cases, each starting from the real RFX-107 answer and breaking one thing, all `invalid-response`. The recorded RFX-107 answer parses into a contract-valid assessment and the request built today equals the one the probe measured, field for field.

### RFX-107 — Semantic latency and cost spike

**Goal:** Measure, against the real provider, the latency and cost of assessing the eleven dimensions: one call, batched, and parallel.

**Acceptance:** A written result with p50, p95 and cost per 1,000 governed actions, and a recommendation that RFX-028 then implements. If the p95 budget of 400 ms is out of reach, that is reported before RFX-028 starts.

**Why:** RFX-028 assumes parallel per-dimension calls. Eleven model calls per action against a 400 ms p95 is a hypothesis to test, not a design to build.

**Status:** Done (2026-09-20), pulled forward from G4 at the maintainer's request so that ADR-010 can be decided on measured numbers. `packages/provider-jev/live/probe-latency.mjs` assessed the eleven dimensions of `SemanticAssessment` against the real TypeSafe API (`jev-1.13.0`, pinned), forty samples per variant, synthetic data only, under six cents in total. **One request with eleven questions:** p50 264 ms, p95 372 ms, $0.070 per 1,000 actions. **Batched in three:** p50 279 ms, p95 358 ms, $0.120. **Eleven in parallel:** p50 334 ms, p95 445 ms, $0.320, and eleven requests of a 1,200 per minute allowance. The provider reports 95 ms (p50) and 148 ms (p95) of its own time; the rest is about 160 ms of round trip from the laptop that measured. **Recommendation for RFX-028: one request.** Answers were the same alone as together, so nothing is traded for the speed. **Reported before RFX-028 starts, as the acceptance requires:** the 400 ms p95 is met by one request and missed by eleven; the 150 ms p50 is out of reach from a laptop and reachable only from somewhere close to the provider, whose region is unknown. A new connection per call adds about 340 ms, so whatever calls the provider has to stay up. The written result is `docs/jev-provider.md`; the record is checked in and `src/live-evidence.test.ts` holds the document to it in CI. Measured from one machine on one afternoon, never above twelve requests a second; accuracy was not measured and is G6's question.

### RFX-028 — Implement parallel semantic dimensions

**Goal:** Evaluate independent dimensions with bounded concurrency.

**Acceptance:** Result includes confidence for each required dimension.

**Note (RFX-107, 2026-09-20):** the premise did not survive measurement. Jev evaluates every question of a request in parallel on its side; eleven requests are slower at p95, 4.6 times dearer and rate-limited eleven times sooner, for identical answers. For this provider the ticket becomes: assess every dimension in one request, and return a confidence for each, including the one boolean dimension, for which the provider gives none (`docs/jev-provider.md` §3). How many requests an assessment takes stays inside the provider package. The goal and acceptance above are left as written until the maintainer rewords them.

**Status:** Done (2026-09-22), as reworded by the RFX-107 note: every dimension is assessed in one request, and every dimension, the boolean included, comes back with a confidence. How many requests an assessment takes stays inside `packages/provider-jev`.

### RFX-029 — Provider fixture/fake implementation

**Goal:** Add deterministic fake provider for tests/dev.

**Acceptance:** Entire decision engine test suite runs offline.

**Status:** Done (2026-09-22). `createFakeProvider` in `packages/semantic-provider`: deterministic from the request's side-effect class and nothing else, so the same request answers the same and two requests that differ only in free text answer the same, which is also RFX-108's plumbing check; told to misbehave it returns each typed error, hangs until aborted, answers slowly, or throws. Core's and the gateway's suites run against it; **the entire decision engine test suite runs offline.**

### RFX-108 — Prompt-injection corpus for the semantic path

**Goal:** Add adversarial cases where attacker-controlled text (tool arguments, MCP tool descriptions, task summaries, file content quoted in arguments) instructs the assessor to rate the action as safe.

**Acceptance:** Every case has a clean twin without the injected text. Injection must not lower any risk dimension, or raise any confidence, beyond a stated tolerance relative to the twin. Untrusted text reaches the provider as delimited data, never as instructions. The corpus runs offline against the fake provider for plumbing and on demand against the real provider.

**Why:** The assessor is a model reading text the adversary wrote. The backlog covered secrets leaking out (RFX-035) and nothing about instructions leaking in.

**Status:** Harness done, pairs to author (2026-09-22). `packages/evals` has the corpus format (`corpus/semantic/injection-v1.json`: pairs of a clean request and its twin with text added at one declared site), a loader that refuses a pair whose twins differ anywhere but at that site, and `runInjectionCorpus`, which sends both twins to a provider and reports every pair where the added text lowered a risk dimension, raised a "higher is safer" dimension, flipped the boolean to false or raised a confidence beyond the corpus's tolerance; a twin the provider could not assess is reported without a verdict. **Held by tests:** against the fake provider every pair holds; against a deliberately gullible provider every pair is reported with the dimensions that moved; and the structural half, that untrusted text reaches the provider as delimited data and never as an instruction, is a test in `packages/provider-jev` (`src/state.test.ts`). **What is not done:** the pairs checked in are plumbing twins with a neutral placeholder; the adversarial pairs, one family per way an attacker phrases a request to be rated safe, are to be authored by the maintainer in the same file (the assistant's safety system stopped it from writing attack text into the repository). The run against the real provider waits for those pairs and for permission to spend.

### RFX-030 — Semantic provider latency telemetry

**Goal:** Record provider/model/dimension latencies.

**Acceptance:** Dashboard-ready metrics exposed without sensitive inputs.

**Status:** Done (2026-09-22). The decision event (RFX-023) names the provider and the model that answered and carries the latency of every stage (`policyMs`, `contextMs`, `semanticMs`, `aggregationMs`), held by a gateway test through the whole pipeline; no input reaches an event, held by the canary test. Per-dimension latency does not exist for this provider: every dimension is one request (RFX-107, RFX-028). The Jev client's `onUsage` reports status, latency and tokens per call for the daemon to count.

### RFX-109 — Semantic decision cache

**Goal:** Cache semantic assessments only for explicitly safe, repeatable classes.

**Acceptance:** Destructive, financial, production, privilege, credential and external-write actions are never served from cache (`docs/architecture.md` §11), enforced by test. A cached semantic decision meets p95 < 20 ms.

**Depends on:** RFX-106.

**Status:** Done (2026-09-22). A semantic decision is cached only for the explicitly safe, repeatable classes `none`, `local-read`, `local-write` and `external-read`, never for a production action and never on a fallback; the cache key includes the provider and the model, so a change of either misses by construction; a hit carries the assessment it was made with. **Held by tests:** a semantic decision about a destructive, privileged, credential, unknown or production action is never served from the cache and the provider is called again; a read is served again with its evidence and the provider is called once; a provider or model change misses; the never-cached list and the semantic list share nothing. **Measured in-engine:** a cached semantic decision is 0.016 ms at p95 (`pnpm --filter @reflex/core bench`), against a 20 ms budget.
**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** core compiles and the whole suite runs offline without Jev; malformed or partial provider output never yields allow; p50 and p95 against the real provider are recorded.

**Gate status:** Open on two items (2026-09-22). Eight of nine tickets are done on the branch; RFX-108 has its harness and waits for its adversarial pairs. **Open:** the provider has not been run against the real API from the built package (`live/verify-provider.mjs`, about a cent; the run was refused by the session's transaction guard on 2026-09-25 and waits for the maintainer), and the injection pairs are to be authored by the maintainer (the session's safety layer refuses to write them). **What holds:** the whole engine runs offline against the fake provider; core imports nothing from a provider package (boundary test); malformed or partial provider output never becomes an allow (fifteen adversarial cases from the real recorded answer); a request's untrusted text can only ever be data to the provider. **What this gate does not claim:** no daemon uses the provider yet, because the semantic stage needs a compiler (G5) and an aggregator (G6) before an assessment can reach a decision; that wiring is RFX-141 in R0.

## R0 — RDM Gate 0: model independence

The RDM briefing (2026-09-22) names a first milestone, "RDM Gate 0 — REFLEX model independence": REFLEX keeps working with Jev, Jev is one provider behind a generic interface, core holds nothing Jev-specific, a future RDM provider plugs into the same interface, shadow mode is structurally possible, decision events can be persisted and outcomes attached later, the first dataset schema and the refund generator exist, and tests pass. `docs/rdm/gate-0-assessment.md` measured that against the code: the interface, the stage order and the outcome linkage already exist (ADR-005, ADR-002, ADR-013), Jev is not wired to anything yet (G4 builds it), and what is missing is provider selection, shadow evaluation, a decision record with labelled provenance, a local-provider client and the `rdm/` module. ADR-015 draws the open-core line and ADR-016 the provider, shadow and record design; both were accepted by the maintainer on 2026-09-22.

This gate depends on G4's RFX-025 and RFX-029 (the interface with a typed result and a fake provider) and on nothing from G5 or G6. It can start as soon as the two ADRs are accepted, and it does not train a model.

### RFX-139 — Open-core boundary and licensing

**Goal:** Decide ADR-015 and make the boundary real in the repository before anything is published: which packages are open under which licence, which stay private, and a rule that keeps them apart.

**Acceptance:** ADR-015 is Accepted or amended by the maintainer. `LICENSE` exists at the root and every open package declares the same `license`; a test holds the manifests to the list in `docs/open-core.md`. `tests/boundaries.test.ts` refuses an open package that depends on a private one. `rdm/` is excluded from every publish path by name. `docs/product.md` says which plan features come from the private side.

**Why:** Nothing in the repository says whether REFLEX is open source, and the answer decides where RDM and its training data live.

**Status:** Done (2026-09-22). ADR-015 was **accepted by the maintainer the same day it was proposed, as recommended**: open core, Apache-2.0 for everything that runs on the user's machine and everything a third party needs to integrate, private for what needs an account and for the model; a user's own provider key in the open daemon is allowed. `LICENSE` at the root is the Apache License 2.0 as published by the ASF; fifteen open packages declare `Apache-2.0` and the three private ones (`apps/api`, `apps/dashboard`, `packages/auth`) declare `UNLICENSED`. `docs/open-core.md` is the list, and `tests/boundaries.test.ts` reads it: every workspace package must be on one side, every manifest must carry the licence the list gives it, no open package may depend on a private one, and `rdm/` must stay out of the workspace. ESLint refuses a relative import that reaches `rdm/` from any package, and the boundary test holds it with an import and a re-export. `docs/product.md` says what the plans add from the private side. **Not done here:** the repository split and the publish step, which belong with RFX-076.

### RFX-140 — Decide ADR-016 providers, shadow mode and decision records

**Goal:** Accept, amend or reject ADR-016 before RFX-141 starts.

**Acceptance:** ADR-016 is Accepted. The provider ids, the shadow rules (never affects a decision; sampling of resolved actions only for a local provider) and the record's shape and provenance vocabulary are the ones the tickets below implement.

**Status:** Done (2026-09-22). ADR-016 was **accepted by the maintainer the same day it was proposed, as recommended.** Provider ids `none|jev|local|reflex|fake`; policy stays first; shadow providers are recorded and never used, and sampling of resolved actions is allowed only for a local provider; `DecisionRecord` is an additive contract with a closed provenance vocabulary; `rdm/` is a private Python module whose only contract with the product is the canonical one; the eleven dimensions are the taxonomy; training labels are dimension vectors and benchmark labels are effects from the real policy engine, never mixed.

### RFX-141 — Provider registry and daemon selection

**Goal:** Choose the semantic provider by configuration: `--semantic-provider none|jev|local|reflex`, with `none` today's behavior and the default.

**Acceptance:** A registry in `packages/semantic-provider` maps an id to a constructor; the daemon builds the semantic stage from it, or none. Every assessment records its provider, model and version, pinned, never an alias. With `none`, every existing engine and gateway test passes unchanged. `GET /v1/health` names the provider in use.

**Depends on:** RFX-025, RFX-029, RFX-140.

**Status:** Done (2026-09-25). **A registry in `packages/semantic-provider` maps an id to a constructor:** `createProviderRegistry({ jev, fake, ... })` over the vocabulary `none|jev|local|reflex|fake` of ADR-016; an id nobody registered is refused with the list of what is available, a constructor that throws becomes a reason without the configuration in it, and the registry never logs a configuration because one may carry a key. **The daemon builds the semantic stage from it, or none:** `--semantic-provider` (default `none`, today's behavior), `--semantic-model` (a versioned id; an alias is refused) and `--semantic-endpoint`; the daemon registers `jev` (key from `TYPESAFE_API_KEY` in its environment, never a flag) and `fake` (development), and `local` and `reflex` are refused until RFX-144 and G14 exist. The stage is the compiler with the installation's redaction key, the provider and the aggregator with its default configuration, on 600 input tokens. A provider that was asked for and cannot be built exits 2 with the reason: the daemon never runs without what it was told to run with. **Every assessment records its provider, model and version, pinned, never an alias:** `semanticAssessment.provider` and `.model` on every decision the provider took part in, held end to end with the fake (`fake`, `fake-1`) and refused for `jev-latest` and `jev-preview`. **With `none`, every existing engine and gateway test passes unchanged:** none was touched, and an end-to-end test holds that with `none` an open action asks and no assessment appears. **`GET /v1/health` names the provider in use:** `semanticProvider: { id, name, model }`, and never the key or the endpoint. Adversarial: the key is handed to an unreachable `jev` and comes out nowhere, not in health, not in the decision (which falls back), not on stderr, not in telemetry.

### RFX-142 — Shadow evaluation

**Goal:** Evaluate one or more shadow providers alongside the primary one and record their answers without letting them touch the decision (ADR-016 §3).

**Acceptance:** A shadow provider receives the same request as the primary, concurrently, under its own deadline; the decision returns when the primary is done. A test holds every field of the decision equal with and without shadows, for a shadow that answers the opposite, one that hangs and one that throws, with and without the cache. A shadow that would allow a `deny` leaves `deny`. `--shadow-sample all` is refused for any provider but `local`. With no shadow configured the engine's path is unchanged. Shadow latency and failures are telemetry of their own and never a fallback.

**Depends on:** RFX-141.

**Status:** Done (2026-09-25). `SemanticStage.shadow` in `packages/core` names providers with their own deadline and sample; the engine starts every applicable shadow on the request the primary gets, at the moment the primary gets it, and never waits for one; each settles on its own `AbortSignal.timeout` and is handed to `onShadow`, possibly after the decision returned. **A test holds every field of the decision equal with and without shadows** (`packages/core/src/shadow.test.ts`, decisions compared as JSON with fixed clock, time, ids and key), for a shadow that answers the opposite, one that hangs, one that throws, one that fails and one that is slow, with and without the cache, over an unresolved read, a destructive command and a rule-resolved action. **A shadow that would allow a `deny` leaves `deny`**, whether the primary or a rule denied. **`--shadow-sample all` is refused for any provider but `local`** by the daemon, and in core by the provider's `onMachine` declaration (a provider that does not run on this machine cannot be sampled on resolved actions; a compile off the decision path, after the answer, feeds it). **With no shadow configured the engine's path is unchanged:** the same code runs with an empty list. **Shadow latency and failures are telemetry of their own and never a fallback:** the `shadow` event (provider, model, sampled on, assessed or the failure kind, latency; no content), emitted by the daemon from the observer. The caller's signal stays the primary's: a cancelled decision still lets the shadow settle. A decision served from the cache runs no shadow. `--shadow-provider <id>` (repeatable), `--shadow-deadline <ms>`, `--shadow-sample`, refused without a primary; health lists `shadowProviders`. **Not in this ticket:** a shadow without a primary (observing with a local model alone while `none` decides), which RFX-143 and RFX-144 may want and which needs the stage to allow no primary.

### RFX-143 — Decision records with labelled provenance

**Goal:** Write the unit of training data: the redacted request that was sent, every provider's answer (primary and shadow), REFLEX's decision, and labels that each name their source; outcomes and feedback are appended later by id (ADR-016 §4).

**Acceptance:** `DecisionRecord` is an additive contract, version 1.3, with frozen fixtures; a label without a source does not parse. Records are written after the answer, off the decision path, to a local size-rotated log kept 7 days (ADR-008 §4). The canary test of RFX-023 covers records: nothing on the never-stored list appears in one. Until the redactor exists (RFX-031) the request content is absent, and the field is optional so nothing is invented. An `ActionOutcome` and a `DecisionFeedback` can be joined to a record by `actionId` and `decisionId`, and a test does. RFX-060 ingests these records with consent (RFX-123).

**Depends on:** RFX-142.

**Status:** Done (2026-09-25). **`DecisionRecord` is an additive contract, version 1.3, with frozen fixtures:** `packages/contracts/src/record.ts` and its strict parser `parseDecisionRecord`; `fixtures/v1.3/` freezes three records (full, minimal, deterministic) with the checksum table, the mandatory-field table and the vocabulary (`LABEL_SOURCES`, `EVALUATION_ROLES`, `PROVIDER_ERROR_KINDS`, now shared with the provider package, and `ASSESSMENT_DIMENSIONS`, the taxonomy of ADR-016 §6) extended; every v1.0 to v1.2 fixture still parses unchanged. **A label without a source does not parse**, nor one with a source outside the closed vocabulary, a kind or a dimension the contract does not know, a boolean for a scored dimension, an evaluation with both an assessment and an error or neither, an unknown key at any level, or a request that carries what a provider is never given. **Records are written after the answer, off the decision path, to a local size-rotated log kept 7 days:** the engine hands `onDecision` what a decision was made of (the compiled request, the primary's answer or failure, every shadow as a promise, whether policy decided) from a `setImmediate` after the decision is built; the daemon waits for the shadows, builds the record and writes it to `<REFLEX_HOME>/records/records.jsonl`, which `RotatingJsonlLog` now rotates by age as well as size and purges rotated files past the retention. **The canary test covers records:** end to end, a bearer token in a command reaches the record only as its placeholder, and the record never carries the cache key, the latency or the clock. **The request content is present**, since the redactor exists (RFX-031), and the field stays optional: a rule-resolved decision and a cached one have none. **An `ActionOutcome` and a `DecisionFeedback` can be joined to a record by `actionId` and `decisionId`, and a test does:** `withOutcome` and `withFeedback` append them with the labels they imply (`human` from an approval, a rejection or feedback; `production_outcome` from what the host did unasked; `unknown` is never a label) and refuse another action's outcome or another decision's feedback, as the parser does. RFX-060 ingests these records with consent (RFX-123).

### RFX-144 — Local provider client

**Goal:** `packages/provider-local`: a `SemanticDecisionProvider` that calls a local inference server speaking the canonical contract (`POST /v1/assess`, `SemanticDecisionRequest` in, `SemanticAssessment` out), which is how RDM and Laya plug in without REFLEX knowing which is behind it.

**Acceptance:** A fake server in tests; a partial or malformed answer is a provider failure, never a default (ADR-005 §3); the server's declared model and version are recorded and must match what was requested; the client keeps its connection and never retries on the decision path. The provider registers as `local`. No model exists yet.

**Depends on:** RFX-141.

**Status:** Done (2026-09-25). `packages/provider-local`: `createLocalProvider({ model, endpoint })` posts the canonical `SemanticDecisionRequest` to `POST /v1/assess` and reads the `SemanticAssessment` back with the contract's own strict parser; `docs/local-provider.md` is the wire contract a server for RDM or Laya has to speak. **A fake server in tests:** `src/server.test.ts` runs one on the loopback and holds the path, the body, the headers and that two assessments share one connection; the daemon is held end to end against another. **A partial or malformed answer is a provider failure, never a default:** a missing dimension, an out-of-range value, an extra field, a bare string, text that is not JSON and an empty body are each `invalid-response`. **The server's declared model and version are recorded and must match what was requested:** the provider is built with a pinned checkpoint (`--semantic-model`, an alias refused), an answer in another checkpoint's name or in none is `invalid-response`, and the assessment REFLEX records carries `provider: "local"` and that model. **The client keeps its connection and never retries on the decision path:** one `fetch` per assessment over the kept connection, one call whatever the failure. **The provider registers as `local`**, and it declares `onMachine` because its endpoint must be on `127.0.0.1`, `::1` or `localhost` (any other is refused at construction, and by the daemon with a reason), which is what lets a local shadow be sampled on resolved actions (RFX-142). The lint boundary now forbids `core -> provider-*`, `adapter -> provider-*` and `provider-* -> core` for every provider package. **No model exists yet:** the server is `rdm/inference` (RFX-145 and after).

### RFX-145 — `rdm/` module skeleton and dataset schema

**Goal:** The private Python module of ADR-016 §5: the dataset record schema with the closed provenance vocabulary, the split rule that benchmark and training never share a seed, a template or an entity, and a CI job that runs its tests without publishing anything.

**Acceptance:** `uv run pytest` passes in CI. The record schema is generated from, or checked against, the contract's frozen fixtures so the two cannot drift. A test fails when a benchmark seed, template or entity appears in a training split. Nothing in `packages/` or `apps/` imports from `rdm/`, held by the boundary test. No model, no training.

**Depends on:** RFX-139, RFX-143.

**Status:** Done (2026-09-27). `rdm/` exists: a `uv` project (Python 3.12, `pytest` its only development dependency, a lockfile), private under its own `LICENSE`, out of the pnpm workspace, with `rdm/schema` (the dataset record), `rdm/dataset` (provenance sides and the split rule) and empty `generators/` and `benchmark/` for RFX-146. **`uv run pytest` passes in CI:** the Quality gates job installs `uv` pinned through `pipx`, runs `uv sync --locked` and `uv run pytest` in `rdm/`, and publishes nothing; `tests/ci.test.ts` audits those three commands like the pnpm gates. **The record schema is checked against the contract's frozen fixtures so the two cannot drift:** every closed vocabulary (`LABEL_SOURCES`, `EVALUATION_ROLES`, `PROVIDER_ERROR_KINDS`, `ASSESSMENT_DIMENSIONS`, effects, modes, reason codes, outcome states) is read from the latest `packages/contracts/fixtures/v1.x/vocabulary.json`, never declared twice; each frozen `decision-record.*.json` must round-trip through `DecisionRecord.from_json` and `to_json`; and the same refusals as the TypeScript parser are tested (a label without a source or with one outside the vocabulary, an unknown kind or dimension, a flag where a score goes, an evaluation with both an assessment and an error or neither, a partial assessment, another action's outcome, another decision's feedback, an unknown key, a request carrying what a provider is never given). **A test fails when a benchmark seed, template or entity appears in a training split:** `SplitPlan` names the benchmark's facets up front and refuses a case that straddles; `check_disjoint` names every shared seed, template or entity; and `check_label_sources` holds the two label sides apart (`synthetic_rule`, `llm_teacher`, `human` train; `deterministic_rule`, `production_outcome` are the benchmark's and the host's), so a training record carrying the rule's own effect is a mix, not data. **Nothing in `packages/` or `apps/` imports from `rdm/`**, held by the boundary test, and nothing in `rdm/` imports from them, held by its own. **No model, no training.**

### RFX-146 — Refund scenario generator and counterfactual pairs

**Goal:** The first scenario family, payment refunds, varying amount, automatic-approval threshold, agent permissions, customer type, fraud indicators, previous refunds, financial exposure, reversibility and policy requirements, generated as canonical actions (`tool: { name: "refunds.create", namespace: "stripe" }`, class `financial`).

**Acceptance:** Training labels are dimension vectors with source `synthetic_rule`, never effects. Benchmark labels are effects produced by running each case through the real policy engine with the scenario's policy and a fixed aggregator configuration, source `deterministic_rule`, in a separate file. Every counterfactual pair differs in one variable and flips the effect end to end, and a test holds it for every pair. The benchmark runs through `packages/evals`' runner. The generator is deterministic from a seed.

**Depends on:** RFX-145, RFX-036 (a fixed aggregator configuration to produce benchmark labels; until it exists, the pairs are held against policy alone).

### RFX-147 — Laya behind the local server, measured against Jev

**Goal:** Load Laya (open weights, Apache-2.0) in the local inference server and measure it against Jev on the semantic corpus, on the same cases, with the same harness.

**Acceptance:** A written result like `docs/jev-provider.md`: accuracy per dimension on the corpus (RFX-038), latency p50 and p95 on a named machine, context limits met or not (Laya's English checkpoint takes 512 tokens; RFX-107 measured 1,669 for one request), calibration (RFX-110), and the adversarial corpus (RFX-108) on both. A recommendation on whether Laya is worth offering as a local provider, and on nothing else. No production decision depends on it.

**Depends on:** RFX-144, RFX-038, RFX-039, RFX-108.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically, the briefing's criteria as tests:** REFLEX works with `none` and with `jev` as before; every provider sits behind `SemanticDecisionProvider` and core imports nothing from a provider package; a decision is byte-for-byte equal with and without shadows; a `DecisionRecord` parses, is written off the decision path, carries no never-stored value, and joins an outcome and a feedback by id; the refund generator produces counterfactual pairs that flip the effect end to end; benchmark and training splits share nothing; no model was trained.

## G5 — Context compiler and redaction

### RFX-031 — Implement local secret redactor

**Goal:** Redact common token/key/header/env patterns.

**Acceptance:** Golden corpus confirms secrets never survive redaction.

**Status:** Done (2026-09-23). `packages/context-compiler/src/redact.ts`: fifteen secret kinds by shape, never by entropy (AWS access and secret keys, GitHub, Slack, Stripe, Google, OpenAI, Anthropic and TypeSafe keys, JWTs, private-key blocks, authorization headers, credentials in URLs, assignments to a name that says password, secret, token or key, and encoded runs); a value becomes `[REDACTED:<kind>:<fingerprint>]` with the frame kept, the fingerprint the first 8 hex digits of an HMAC-SHA-256 under the installation's key (ADR-006 §4), the same secret the same placeholder on the same machine and another elsewhere; base64 and percent-encoded runs are decoded and scanned two levels deep; a placeholder never reads as a secret and a second pass skips the ones it finds; a string too large to scan is replaced whole. `redactAction` returns a branded `RedactedAction` without `id`, `agent`, `cwd`, `sessionId` or `adapterMetadata`, so a stage that reads the raw view is a compile error (ADR-006 enforcement). The key is `<REFLEX_HOME>/redaction.key`, 32 bytes, mode 0600, created by the daemon on first start (`apps/decision-gateway/src/orchestration/redaction-key.ts`); a key of the wrong size is refused rather than replaced, and a key that became readable by others is tightened. **The golden corpus confirms secrets never survive redaction:** 23 cases, at least one per kind, in the frame a developer meets it, three seeds each, zero survivors. No secret-shaped literal exists in the repository: every case names a kind and a template and the secret is generated at test time from the kind's shape, so the Security gate's allowlist did not move. `docs/context-compiler.md` is the page.

### RFX-032 — Implement relevant-history selector

**Goal:** Select bounded prior actions relevant to current tool/resource.

**Acceptance:** History size remains bounded under long sessions.

**Status:** Done (2026-09-23). `selectRelevantHistory` keeps the most recent items (3) and the ones about the same tool, the same MCP server or the same resource, within thirty minutes and a bound of eight, newest last; what the provider gets is the contract's `PriorActionSummary` and nothing more (no resource, no namespace). **History size remains bounded under long sessions:** held by a test over five thousand entries. `SessionMemory` is the bounded in-memory store the daemon will keep (200 entries per session, 1,000 sessions, six hours; oldest sessions evicted first), and `historyEntryOf` builds an entry from a decided action. **Not wired:** the daemon keeps no memory until RFX-141 (R0); the selector and the store are exercised by tests.

### RFX-033 — Implement semantic context compiler

**Goal:** Produce minimal provider request from canonical action.

**Acceptance:** Median test corpus stays under configured token budget, measured with a named tokenizer.

**Status:** Done (2026-09-23). `createContextCompiler({ redactor, history, policyHints })` implements the `ContextCompiler` seam of `packages/core` structurally, without importing it: from the raw action, in the daemon's memory, to the fields `SemanticDecisionRequest` selects by name, redacted, with the relevant history and the policy hints (redacted too: a rule about a specific secret names it), under the budget; the repository's root, a path on this machine, is left out and the branch and remote host kept. `compileWithReport` says what happened on the way: tokens, cuts, redactions, history items. **The median test corpus stays under the configured token budget, measured with a named tokenizer:** over the 79 actions of the seed corpus, the compiled state is 51 tokens at the median, 70 at p95 and 76 at most as `gpt-tokenizer` 4.0.0 (o200k_base, a development dependency) counts, about 74, 102 and 110 as the provider counts (calibrated on the RFX-107 record: TypeSafe reported 1,669 where o200k counts 1,148, a ratio of 1.45); the RFX-107 "typical" state with objective, summary, environment, history and hints is 222 (322) against a budget of 600. Measured in CI by `packages/evals/src/budget-measurement.test.ts` (moved there in G6, when the harness came to depend on the compiler). An adversarial test plants a secret in every field the compiler reads and holds that none reaches the request at any budget.

### RFX-034 — Token budget enforcement

**Goal:** Hard-truncate/summarize optional context by priority.

**Acceptance:** Required action/resource fields are never truncated.

**Status:** Done (2026-09-23). `enforceBudget` estimates tokens from bytes (divided by four, rounded up; against the named tokenizer never under by more than a tenth nor over by more than half, held by a test) and, only when over budget, cuts optional context in a fixed order and stops as soon as the budget holds: policy hints, prior actions, the task summary and the objective to 200 characters, the tool's description, then argument values to 120 characters each, marked `…[truncated]`. **Required action and resource fields are never truncated:** the tool, the operation, the side-effect class, the resource and the argument keys survive a budget of one token, held by a test.

### RFX-035 — Redaction adversarial corpus

**Goal:** Add encoded, quoted and embedded secret fixtures.

**Acceptance:** Corpus reports zero raw known secrets after compiler.

**Status:** Done (2026-09-23). `corpus/adversarial-v1.json`: 14 cases, the golden secrets encoded, quoted and embedded: base64 and double base64, percent encoding, JSON-string escaping, single and double quoting, YAML, Python, Markdown, a here-document writing `.env`, a data URL, and a secret split across a shell line continuation. **The corpus reports zero raw known secrets after the compiler**, and for the encoded cases the encoded run is gone too, not only the decoded value. The split case is marked `expect: "survives"` and counted, not hidden: no single-string redactor catches a secret that no single string holds. The corpus runs at the first pass only; the second pass at the gateway, where a hit counts as a defect of the first (ADR-006), is G10's work.
**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** the redaction corpora report zero surviving known secrets; the median compiled context is under the token budget with the named tokenizer; required action and resource fields are never truncated.

**Gate status:** Closed (2026-09-24). All five tickets are done, merged and green in CI on `main`: pull request #16 passed both required checks, Quality gates and Security gates, and was merged on 2026-09-24 (main head `2283fdf`). **The three specific exits are tests:** the redaction corpora report zero surviving known secrets (`packages/context-compiler/src/corpus.test.ts`, 23 golden and 13 adversarial cases that must hold, three seeds each, plus the one split case counted as surviving by design); the median compiled context is under the token budget with the named tokenizer (`packages/evals/src/budget-measurement.test.ts`: 51 o200k tokens at the median over the seed corpus, 74 as the provider counts, against 600); required action and resource fields are never truncated (`src/token-budget.test.ts`, at a budget of one token). **No known dangerous false allow:** nothing in this gate decides; it narrows what a provider sees. **What this gate does not claim:** no semantic stage runs yet (RFX-141, after G6); the daemon keeps no session memory yet; redaction is best effort and the second pass at the gateway is G10's; the corpus knows fifteen shapes, and a credential of a shape it does not know, in a frame it does not know, passes.

## G6 — Risk aggregation and evals

### RFX-036 — Implement risk aggregator v1

**Goal:** Convert semantic dimensions + policy hints into risk/effect.

**Acceptance:** Thresholds are explicit config, not magic scattered constants.

**Status:** Done (2026-09-24). `packages/core/src/risk-aggregator.ts`: each dimension is judged on its own against its band and the strictest verdict wins; nothing is summed or weighted, so a dangerous dimension is never averaged away. Risk is the worst dimension and never below the class's table value; confidence is the least sure of what decided, and for an allow the least sure of everything. Environment rule: production asks at least. **Class floors:** what the classifier calls dangerous or does not understand (`unknown`, `destructive`, `external-write`, `credential`, `privilege`, `financial`) never allows on semantic evidence alone, and neither does a request whose arguments carried a redacted value; the model may lower what it sees, not overrule what the command says. Those floors were found by the adversary run of RFX-039, which allowed a credential read and a command carrying a secret before they existed. **Thresholds are explicit config, not magic scattered constants:** every number lives in `DEFAULT_AGGREGATOR_CONFIG`, bands written in the four levels a provider can answer (0, 33, 67, 100), and a test holds that with the bands moved the same assessment decides differently and with the floors removed the same evidence allows. `docs/risk-aggregation.md` §1 is the page. A destructive action inside the project that the model calls rebuildable is RFX-148.

### RFX-037 — Low-confidence escalation rule

**Goal:** Bias uncertain semantic assessments toward ASK.

**Acceptance:** Low-confidence high-impact action never auto-allows.

**Status:** Done (2026-09-24). An allow becomes an ask with `low_confidence` when any dimension's confidence is below the threshold and the action is high impact (class risk at or above 50, or any risk dimension at the third level); an uncertain read still allows, because prompting for what is trivially safe is the cost REFLEX removes; an ask or a deny is never lowered for being unsure. **Low-confidence high-impact action never auto-allows:** held over every high-impact class with the floors on and with them off, and with the fake provider's own answers. The threshold is 0.5, provisional and labelled so, until RFX-110's table comes from a real provider.

### RFX-110 — Confidence calibration

**Goal:** Measure how well provider confidence predicts correctness on the corpus, and set the low-confidence threshold from that data.

**Acceptance:** The eval harness produces a reliability table per dimension. The threshold used by RFX-037 is justified by it, and is re-checked whenever the provider or model changes.

**Why:** RFX-037 escalates on low confidence. A model's self-reported confidence is not calibrated until someone measures it.

**Status:** Harness done, live calibration pending (2026-09-24). `calibrate(provider, cases)` in `packages/evals` runs a provider over every case with an expected assessment, bins each answer by the confidence the provider gave it, and reports per dimension and per bin how often the answer was right; from the table it proposes the low-confidence threshold (the lowest confidence from which every bin above is at least 90% right; the overall suggestion is the highest per-dimension one). **The eval harness produces a reliability table per dimension:** held with the oracle (exact, 0.9 suggested) and with a noisy provider that is a coin flip on two dimensions when unsure (those two dimensions get no threshold, the rest keep theirs). **Not done:** the run against the real provider, which costs about a cent per case and needs the maintainer's permission; until it runs, RFX-037's 0.5 is a guess, labelled as one, and the ticket stays open. It is re-run whenever the provider or the model changes. **2026-09-25:** `packages/evals/live/calibrate-jev.mjs` runs the table against the real provider from the built packages (86 requests, one per case with an expected assessment; `--dry-run` counts them, `--run` spends) and writes `live/results/calibration-jev.json`. Its run was refused by the transaction guard of the session that wrote it, so it waits for the maintainer: `cd packages/evals && node --env-file=../../.env live/calibrate-jev.mjs --run`.

### RFX-038 — Create golden eval corpus

**Goal:** Add safe/destructive/off-task/secret/prod/financial cases.

**Acceptance:** Each case has expected acceptable effects.

**Depends on:** RFX-105. This extends the corpus started there with the semantic cases.

**Status:** Done (2026-09-24). `packages/evals/corpus/semantic/v1/`: 86 cases with an expected assessment per dimension (a set of accepted levels among 0, 33, 67 and 100; a boolean for the external side effect), covering safe, destructive, off-task, secret, production and financial. Seventy-five derive from the seed cases (the same action, already reviewed and held against the engine, with a benign objective and summary added and the expectation written from the case's tags); eleven are new: safe on-task work, harmless off-task work, and two refunds. **Each case has expected acceptable effects**, the seed's for the derived ones, and the loader refuses a dimension it does not know, a level that is not one, an empty expectation, or a dangerous case that accepts allow.

### RFX-039 — Implement replay/eval harness

**Goal:** Run engine version against corpus and summarize regressions.

**Acceptance:** CI can fail on dangerous false-allow regression.

**Depends on:** RFX-105. This extends the runner started there to the full engine.

**Status:** Done (2026-09-24). `packages/evals/src/engine-replay.ts` builds the whole pipeline the daemon will run (policy, the compiler with its redactor, a provider, the aggregator, the fallback) and hands the runner a function from an action to a decision; `decideAll` keeps the decisions for the reports that need more than an effect. Two providers come with it: an **oracle** that answers every case with levels the case accepts, and an **adversary** that calls everything safe and is sure of it. Both corpora are replayed in six configurations (`src/semantic-corpus.test.ts`). The harness now depends on the compiler, so the compiler's budget measurement test (RFX-034) moved to `packages/evals/src/budget-measurement.test.ts`, where the corpus it reads lives; a package cannot be built against its own dependants. **CI can fail on dangerous false-allow regression:** it does, in every configuration, and the adversary run under the starter policy is what found the two floors of RFX-036.

### RFX-040 — Add regression threshold CI gate

**Goal:** Define initial false-allow safety threshold.

**Acceptance:** Any new dangerous false allow fails CI.

**Status:** Done (2026-09-24). The initial false-allow safety threshold is **zero**, in every configuration of RFX-039, over both corpora (165 cases), and the same zero holds for the deterministic engine alone (RFX-105). **Any new dangerous false allow fails CI:** a case added to either corpus with `dangerousIfAllowed: true` is replayed on every run, and an allow anywhere fails `pnpm test`. `docs/risk-aggregation.md` §3 says how to add a case.

### RFX-111 — Mutation testing for security-sensitive packages

**Goal:** Run mutation testing on the policy engine, the classifier, redaction and the aggregator.

**Acceptance:** A surviving mutant in a decision path fails a scheduled check or is explicitly justified in the repository.

**Why:** In G1, manual mutation checks caught what ordinary tests did not, including a parser that reordered keys. For the packages where a missed branch is a false allow, that should not depend on someone remembering to do it.

**Status:** Done (2026-09-24). `pnpm mutation` (`tools/mutate.mjs`, in-house: Stryker 10 could not activate one mutant under Vitest 5 here, every mutant survived with every test running) applies fifteen small operators to the twelve files of `tools/mutation-targets.json` (the matcher, precedence and evaluator of the policy engine; the classifier; the redactor and the token budget; the aggregator, the fallback, the modes, the risk table, the cache and the engine), runs the package's tests for each, and exits 1 on any survivor that `tools/mutation-allowlist.json` does not name with a reason. **A surviving mutant in a decision path fails a scheduled check or is explicitly justified in the repository:** `.github/workflows/mutation.yml` runs it on Tuesdays at 06:00 UTC, on demand, and on a pull request that changes the check itself (audited by `tests/ci.test.ts` like the other workflows); it is not a required check on every pull request because the whole run takes tens of minutes on a shared runner (438 s on an Apple M1 Max) and the quality gates already hold a pull request. As of this date: 451 mutants, 435 killed, 16 justified by name (equivalent boundaries, guards the parser or the pattern engine already enforces, one difference the corpus takes no position on), 0 unjustified. The first run had 120 survivors, and most were gaps: a vacuous cache test, a boundary held only past its threshold, a value nested deeper than the contract allows passed through the redactor unredacted (fixed), the doubt rule's own branches, `exists` on an absent field, twenty-odd classifier branches read one word at a time, and one mutant that made `ssh` with no target throw. `docs/risk-aggregation.md` §5 has the table and the list.

### RFX-148 — Let the model allow a rebuildable delete inside the project

**Goal:** A destructive action whose paths are all inside the project, and which the model calls rebuildable and easy to undo, may be allowed on semantic evidence; every other destructive action keeps the class floor of RFX-036.

**Acceptance:** The policy evaluation exposes the normalized paths the classifier saw for the action, so the aggregator can tell `rm -rf dist coverage` from `rm -rf ~` without re-parsing the command. With the oracle provider `semantic-clean-build-output` (`rm -rf dist coverage` alone) is allowed; with the adversary provider every dangerous destructive case of both corpora still asks or denies, held by the CI gate of RFX-040. The floor and the exception are configuration. (Amended 2026-09-25: the RFX-107 compound, `semantic-safe-clean-build-output`, adds `pnpm test --filter web`, a script the classifier cannot read; that segment is `unknown` and no semantic evidence may allow it, so the compound keeps asking whatever this ticket does. Allowing a project's own package scripts is a question about scripts, not about deletes, and is not in this ticket.)

**Depends on:** RFX-036, RFX-039.

**Why:** the prompt before `rm -rf dist` is the one REFLEX exists to remove, and today the class floor keeps it. The floor is right for a lying model; the exception needs evidence the model cannot fake, which is what the classifier's paths are.

**Status:** Blocked on the maintainer (2026-09-25), first half done. **The policy evaluation exposes the normalized paths the classifier saw:** one `SubjectSummary` per subject with its class, its normalized paths and whether it was understood, plus the project root (`packages/policy-engine/src/evaluator.ts`, held by `evaluation-subjects.test.ts`: `rm -rf dist coverage` and `rm -rf ~` come out as different evidence, a variable or a glob comes out as not understood, `../../` normalizes to `/` and never past it); the aggregator's input carries them as optional fields, so a caller without an evaluation gets every floor. **Not done:** the exception itself. Its design is settled and written in `docs/risk-aggregation.md` §1: the `destructive` floor is lifted only when every segment is understood and of a class the model may judge, every path is absolute, inside the project and under a directory that is built rather than written (`dist`, `coverage`, `node_modules` and a short configured list of the kind), and the model calls the action rebuildable and easy to undo, so the model can only veto. The safety layer of the session that built this refused the change to the aggregator twice, including a variant with the exception off by default, so the change waits for the maintainer to apply it or to allow it explicitly. Until then `rm -rf dist` asks.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** CI fails on any new dangerous false allow; every threshold lives in one configuration; a low-confidence, high-impact case never auto-allows.

**Gate status:** Open on two items (2026-09-24). Six of eight tickets are done on the branch (RFX-036, RFX-037, RFX-038, RFX-039, RFX-040, RFX-111). **The three specific exits are tests:** CI fails on any new dangerous false allow (`packages/evals/src/semantic-corpus.test.ts`, zero dangerous allows in six configurations over 165 cases, the adversary provider included); every threshold lives in one configuration (`DEFAULT_AGGREGATOR_CONFIG`, held by a test that moves the bands and removes the floors); a low-confidence, high-impact case never auto-allows (`packages/core/src/risk-aggregator.test.ts`, over every high-impact class). **Open (updated 2026-09-25):** RFX-110's calibration against the real provider, whose script is written and whose run was refused by the session's transaction guard, so it waits for the maintainer, and until which the 0.5 threshold is a labelled guess; RFX-148, half done (the evaluation exposes the paths the classifier saw) and blocked on its second half, the aggregator exception, which the session's safety layer refused to write and which waits for the maintainer. **No known dangerous false allow:** the adversary run found two before the floors existed (a credential read and a command carrying a secret), and both are held now. **What this gate does not claim:** no daemon runs the semantic stage yet (RFX-141); the aggregator's bands are chosen from the level descriptions and one recorded answer, not from a calibration table; `rm -rf dist` still asks; the mutation check runs weekly, not on every pull request.

## G7 — Claude Code adapter

RFX-041, RFX-042 and RFX-044 moved to G1.5, where the adapter is first exercised in Observe. This gate adds decisions to it.

### RFX-138 — Daemon lifecycle

**Goal:** Start, find, upgrade and remove the local decision daemon (ADR-010) so that the hook client can rely on it without the user ever managing a process.

**Acceptance:** The first hook call after `rfx init` starts the daemon if it is not running, once, without a race when several hooks start at the same moment (one daemon per user, however many projects and hosts). A daemon of an older version than the client is replaced without losing a decision in flight. `rfx uninstall` stops it and removes the socket. The socket lives in a directory of mode `0700` under the REFLEX home and is `0600`. A daemon left behind by a crash (stale socket, stale PID) is detected and replaced, never joined. `rfx status` shows whether it runs, its version and its uptime.

**Depends on:** RFX-021.

**Why:** ADR-010 chose a long-lived daemon and listed its lifecycle as an open question. RFX-043 makes the client start it once when it does not answer; that is only safe if starting it is idempotent and the failure paths are defined.

### RFX-043 — Implement Claude decision mapper

**Goal:** Map allow/ask/deny to supported native permission behavior.

**Acceptance:** ASK delegates to host approval; DENY reliably blocks where supported. The client answers by itself, inside its own deadline, when the daemon does not answer (ADR-003 §4), after trying once to start it (RFX-138).

**Depends on:** RFX-138.

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

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** in Observe nothing is blocked or auto-approved; in Assist every unsafe or uncertain fixture reaches native approval or a block; ASK is delegated to the host, with no custom dialog.

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

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** ASK is abstention on `PermissionRequest`, never a simulated `PreToolUse` ask; a user's existing hooks survive install and uninstall unchanged.

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

### RFX-149 — Split the repositories: public `reflex`, private `reflex-cloud`

**Goal:** Open the source that ADR-015 declares open in a public repository of its own, keep the private side in a private one, and make published packages the only boundary between them.

**Acceptance:** The public repository `reflex` holds every open package listed in `docs/open-core.md`, the docs, the root tooling and the CLI, and no commit in its whole history touches `apps/api`, `apps/dashboard`, `packages/auth` or `rdm/`: a script in the repository names those paths, and a check that `git log --all -- <paths>` returns nothing runs in the public repository's CI on every push, and a pull request that adds a file under one of them fails there. The private repository `reflex-cloud` depends on the open packages by published version (`@reflex/*` from npm, via RFX-127), never by path, submodule or subtree, and its lockfile names the versions. The boundary test of ADR-015 keeps running in the public repository, and a new package that is in neither table of `docs/open-core.md` still fails it. The security gate is green over the public history before the repository is made public, and it is made public only once `rfx init` gives first value (RFX-050 to RFX-054).

**Depends on:** RFX-127 (publishing from CI with provenance; the private side consumes what CI publishes), RFX-050 to RFX-054 (there is something to install before there is something to open).

**Out of scope:** publishing RDM in any form; a `rdm/` directory in the public repository; changing which packages are open, which is ADR-015's decision and not this ticket's.

**Why:** ADR-015 enforces the open/private boundary in place "until the repositories are split" and named the split as a later ticket without writing it. The three private packages are stubs today, so filtering their paths out of the public history is trivial now and stops being so once the control plane exists. And an open license is worth nothing while the only repository is private.

**Test layers:** contract (the boundary test and the history check in the public repository), CI (the private-path check on pull requests).

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** a partial install failure rolls back completely; every `rfx doctor` failure names a remediation; an existing policy file is never overwritten without an explicit user action; the public repository's history holds no private path.

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

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** isolation tests cover every organization-scoped query; no fixture secret appears in a database dump; every migration reverses cleanly.

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

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** every number on the dashboard is derived from stored events; no card claims safety that was not measured; a mode change is audited and takes effect immediately.

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

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** no suggestion changes enforcement before a human accepts it; every accepted rule links to its suggestion and evidence; replay shows the impact before acceptance.

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

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** a denied call never reaches the upstream server; a known MCP server works unchanged through the proxy; installation is reversible and exposes no server secret.

## G14 — SDKs and public API

RFX-078 moved to G10, ahead of the first multi-tenant persistence.

### RFX-076 — TypeScript `reflex.guard()`

**Goal:** Wrap tool collections with decision enforcement.

**Acceptance:** Existing tool signatures preserved.

### RFX-077 — Python guard SDK

**Goal:** Python equivalent with async support.

**Acceptance:** Parity contract tests pass across TS/Python.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** the TypeScript and Python SDKs pass the same contract fixtures; wrapped tools keep their signatures.

## G15 — Billing and paid value

This gate opens with a decision (RFX-129): ADR-010 moved deterministic decisions onto the user's machine, and the meter this gate was written around assumed that every governed action passed through a server. RFX-135 to RFX-137 are go-to-market work. They live here because nothing else in this backlog owns them, and because a price nobody has tested is a risk to everything this gate builds.

### RFX-129 — Decide ADR-014 what a billable action is when decisions are local

**Goal:** Decide what `governed_action` means, where it is counted and how far the count is trusted, now that most decisions never leave the user's machine (ADR-010).

**Acceptance:** ADR-014 is accepted before RFX-079 starts and answers: what is counted (every governed action, only the actions that reach a remote service, or something that is not an action at all, such as seats or projects); where it is counted and how it reaches the control plane; how a count produced on the user's own machine is treated, either as an accepted risk with its bound stated or with a named mitigation; what an installation with no account counts; and whether the tiers in `docs/product.md` still hold under the answer, with the document updated in the same change if they do not.

**Depends on:** ADR-010 (accepted), RFX-060 for what already reaches the control plane.

**Why:** A local counter is editable by the person it bills. A server-side counter sees only the semantic minority of actions, so it would bill for the expensive path and give the product's main value away, or bill nothing for a user whose policy resolves everything. Either can be right. Building the meter before choosing is how a pricing model gets decided by an implementation detail.

### RFX-079 — Governed-action metering

**Goal:** Count billable governed actions idempotently.

**Acceptance:** Retries cannot double bill.

**Depends on:** RFX-120, RFX-129.

### RFX-080 — Plan/limit enforcement

**Goal:** Developer/Pro/Team/Scale entitlements.

**Acceptance:** Limit behavior never disables safety enforcement silently.

### RFX-081 — ROI/value metrics

**Goal:** Compute approval prompts eliminated and configurable time estimate.

**Acceptance:** Estimated time is visibly labelled and assumption configurable.

**Depends on:** RFX-091. In Assist and Autopilot the counterfactual prompt is not observable, so the figure is an estimate from Observe-period base rates and is labelled as one.

### RFX-130 — Payment provider integration

**Goal:** Take money: hosted checkout, subscriptions for the Pro, Team and Scale tiers, plan changes, invoices and tax, through one payment provider.

**Acceptance:** In the provider's test mode, an end-to-end test subscribes an account, upgrades it, downgrades it and cancels it, and the account's entitlements (RFX-080) follow each step. Every webhook handler is idempotent: replaying the full recorded webhook log of that test changes nothing. Proration on a plan change matches the provider's own invoice to the minor unit. All amounts are integer minor units with an explicit currency (`CLAUDE.md`). No card number, CVC or bank detail is ever sent to, logged by or stored in a REFLEX service: checkout and card updates happen on the provider's hosted pages, and a test asserts that no request schema of the API accepts such a field. Tax is computed by the provider, not by REFLEX.

**Depends on:** RFX-078, RFX-061, RFX-080.

**Out of scope:** Enterprise contracts and manual invoicing; more than one payment provider; a REFLEX-built card form.

**Why:** G15 meters and limits and never charges. RFX-079 and RFX-080 produce numbers that nothing turns into revenue.

**Test layers:** unit, contract (webhook payloads as fixtures), adversarial (forged, replayed and out-of-order webhooks; a webhook for another tenant).

### RFX-131 — Failed payments, cancellation and downgrade

**Goal:** Define and implement what happens to an account whose payment fails or whose subscription ends.

**Acceptance:** One state machine (active, past due, grace, downgraded, cancelled) with every transition covered by a test, driven by recorded provider events. A failed payment starts a grace period whose length is a named constant; at its end the account falls to the Developer entitlements, and nothing is deleted before the retention period of ADR-008. **In no state is safety enforcement disabled, weakened or paused**: the same rule RFX-080 holds for plan limits, tested here for every state. The user is told in the dashboard and in `rfx status`, with what to do about it. Reactivating restores the previous plan without losing policies or history that is still inside retention.

**Depends on:** RFX-130, RFX-080, RFX-121.

**Why:** Billing failures are routine. Deciding their behavior during an incident is how a security product ends up switching itself off for its customers.

**Test layers:** unit, adversarial (an event that tries to move an account to a better state than its payments justify).

### RFX-132 — Plan, usage and upgrade experience

**Goal:** Let a user see their plan and usage and change plan without contacting anyone.

**Acceptance:** The dashboard shows the current plan, usage against each limit for the current period and the next invoice date, and the usage figure equals the metered count (RFX-079) for the same period in a test. From the notice shown when a limit is near or reached, in the dashboard and in `rfx status`, a user reaches the provider's checkout in at most two steps. A usage warning is sent before a limit is reached, at a threshold that is a named constant, and never more than once per period per threshold. Nothing in this flow is shown to a user who has no account; a local-only installation is never nagged.

**Depends on:** RFX-130, RFX-079, RFX-063.

**Out of scope:** Discounts, coupons, annual plans, referral programs.

**Why:** A limit the user cannot see coming, and an upgrade that needs a support request, are the two most reliable ways to lose a paying user at the moment they were about to pay more.

### RFX-133 — Semantic cost model and margin guard

**Goal:** Know what a governed action costs REFLEX, per plan, from production data, and bound what a single account can cost.

**Acceptance:** A report, produced from production telemetry and reproducible from a command, gives per plan and per period: the share of governed actions that reached the semantic stage, provider input tokens billed, provider cost per 1,000 governed actions and the gross margin on the plan's price. Provider cost is held in integer micro-units of the currency, because a single assessment costs less than any minor unit, and the unit is stated wherever a figure appears. An alert fires when the semantic share or the cost per 1,000 actions of any plan crosses a named threshold. Every account has a semantic budget per period; when it is spent, further unresolved actions fall back as ADR-003 says (to a human, never to `allow`), the user is told, and nothing else changes. The first report states the numbers it replaces: $0.070 per 1,000 semantic assessments measured in RFX-107, and the estimates derived from it (about $1 a month for a Developer account at its limit and about $5 for a Pro account, if 30% of actions reach the semantic stage), so that the estimate can be seen to be right or wrong.

**Depends on:** RFX-030, RFX-079, RFX-060.

**Why:** The margin depends on one ratio nobody has measured: how many actions deterministic policy resolves. "Deterministic first" is a latency rule in `CLAUDE.md` and it is also the business model. A free tier with no semantic budget is an open tab with the provider.

**Test layers:** unit, adversarial (an account that tries to make every action reach the semantic stage).

### RFX-134 — Provider capacity plan

**Goal:** Know at what load the semantic provider becomes the limit, what REFLEX does there, and what has to be in place before that load arrives.

**Acceptance:** A written capacity model in `docs/jev-provider.md`: expected peak semantic assessments per minute as a function of active accounts and semantic share, against the provider's documented limit (1,200 requests a minute and 250,000 tokens a second per account on 2026-09-20, shared by every REFLEX customer behind one key, and stated by the vendor to change without notice). A load test against the fake provider (RFX-029) configured with that limit shows that beyond it every excess assessment ends in the fallback of ADR-003 with reason `provider-error`, that none is retried on the decision path, that none becomes `allow`, and that the deterministic path is unaffected. The document names the load at which a capacity agreement with the vendor, a second account or a second provider is required, and the lead time each needs.

**Depends on:** RFX-026, RFX-029, RFX-030, RFX-133.

**Why:** One provider account with a fixed request rate serves every customer. The first customer with a busy CI pipeline can exhaust it for everyone, and the moment that happens is the moment the product degrades to asking about everything.

### RFX-135 — Validate the pricing hypothesis

**Goal:** Replace "Pricing hypothesis" in `docs/product.md` with pricing that has met users.

**Acceptance:** At least fifteen recorded conversations with people who run coding agents at work, at least five of them with budget authority, each answering the same written questions: what they pay for today in this space, which meter they understand, what they expect for free, and at what price each tier is a yes, a maybe and a no. A one-page summary in `docs/` reports the answers as counts, not impressions, and names what would have changed the conclusion. `docs/product.md` is updated in the same change: the section loses the word "hypothesis", or states what is still unknown and what would settle it. The meter chosen in ADR-014 is one of the things tested.

**Depends on:** RFX-129.

**Out of scope:** A/B testing prices on live traffic; enterprise negotiation.

**Why:** Five tiers and their limits were written before a single user saw the product. Everything in this gate implements them.

### RFX-136 — Public website and pricing page

**Goal:** A public site that says what REFLEX is, shows it working, states the prices and leads to `rfx init`.

**Acceptance:** A visitor can go from the landing page to a working `rfx init` without creating an account and without talking to anyone, and the install command on the page is tested in CI against the released CLI. The pricing page shows exactly the tiers and limits that RFX-080 enforces, from one shared source, so that the two cannot disagree. The site states plainly what leaves the user's machine and what does not (ADR-006, RFX-123), and that REFLEX is not a sandbox (`docs/security.md`). Performance, accessibility and best-practice scores of 90 or more in Lighthouse, on a named page set, run in CI. No third-party script runs before consent.

**Depends on:** RFX-127, RFX-135.

**Out of scope:** A blog, a changelog site, localization.

**Why:** "First value before account creation" (`CLAUDE.md`, UX rules) starts on a page that does not exist. A security product is judged by its first page on exactly the two claims this ticket makes it state.

### RFX-137 — Public documentation

**Goal:** Publish the documentation a user needs to install, trust and operate REFLEX.

**Acceptance:** A public documentation site built from files in this repository covers: quick start, how a decision is made, the policy language (RFX-100), modes, each supported host and what is verified for it (ADR-007), the threat model, what is stored and for how long (ADR-008), and troubleshooting that mirrors `rfx doctor` (RFX-055). Every command and every policy example on the site is executed as a test, as RFX-100 already requires for the policy reference, so that the documentation cannot drift from the product. Broken internal links fail CI.

**Depends on:** RFX-100, RFX-055, RFX-101.

**Out of scope:** API reference for SDKs (G14 owns it); video; localization.

**Why:** The documents exist in `docs/` for the people building REFLEX. None of them is written for, or reachable by, the person deciding whether to let it govern their agent.

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** ADR-014 is accepted and the meter is the one it names; a retried request is metered once; reaching a plan limit, a semantic budget or a failed payment never disables enforcement silently; every estimated figure is labelled as an estimate; a replayed webhook log changes nothing and no payment detail reaches a REFLEX service; the usage a user sees is the usage that is metered; the cost report runs from a command and states its units; excess load on the provider ends in the fallback and never in `allow`; the pricing in `docs/product.md` has met users; the public pricing page and the enforced entitlements come from one source; every command and example in the public documentation runs as a test.

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

**Gate exit:** all tickets above are green in CI and documented; no known dangerous false-allow regression. **Specifically:** a production policy cannot be weakened by a project or local policy; clients consume only signed, immutable snapshots; membership changes are audited.
