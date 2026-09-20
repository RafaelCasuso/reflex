# ADR-002: Decision precedence and effective effect

- **Status:** Proposed
- **Date:** 2026-09-20
- **Tickets:** RFX-112, RFX-014, RFX-019, RFX-043
- **Supersedes:** none

## Context

`ReflexDecision` carries two effects: `effect`, "the canonical REFLEX decision",
and `effectiveEffect`, "what the adapter enforces under `mode`". Nothing says
what `effectiveEffect` is in each mode, and both fields are closed and never
coerced (ADR-009), so whatever is chosen is frozen into the wire format.

Three more things are undefined and the engine cannot be built without them:
the order in which the stages of a decision win, whether a semantic result can
change a deterministic one, and what `risk` and `confidence` mean when no model
was involved. The contract requires both on every decision.

`CLAUDE.md` fixes the frame: `deny > ask > allow`; never call a model if
deterministic policy can resolve the action; a deterministic explicit deny
cannot be overridden by semantic inference; `ask` means the host's native
approval flow; Observe never affects execution, Assist allows what is
sufficiently safe and leaves the rest to native approval, Autopilot enforces
all three effects.

## Decision

Not decided.

Recommendation (not binding):

### 1. Stages, in order

1. **Deterministic policy** (ADR-004). If it resolves, that is the decision and
   no later stage runs. A semantic result can therefore never lower a
   deterministic `ask` or `deny`, and never raise a deterministic `allow`: the
   provider is not called at all.
2. **`defaults.unresolved`** when policy does not resolve: `ask` and `deny` are
   final; `semantic` continues. With no provider configured, `semantic` is
   read as `ask`.
3. **Semantic aggregation** (G6). The aggregator owns the effect; the
   assessment is evidence.
4. **Fallback** (ADR-003), when a stage that was needed could not complete.

`effect` is computed the same way in every mode. The mode never changes what
REFLEX thinks, only what it does about it.

### 2. Mode by effect

`ask` has one meaning everywhere: **the host's native approval flow decides.**

| Mode      | `effect` | `effectiveEffect` | The adapter                                                                                         |
| --------- | -------- | ----------------- | --------------------------------------------------------------------------------------------------- |
| observe   | any      | `ask`             | emits nothing at all. The host behaves exactly as it would without REFLEX. The decision is recorded |
| assist    | `allow`  | `allow`           | tells the host to proceed without its prompt                                                        |
| assist    | `ask`    | `ask`             | requests the host's native approval                                                                 |
| assist    | `deny`   | `ask`             | requests the host's native approval, with REFLEX's reason where the host can show one               |
| autopilot | `allow`  | `allow`           | tells the host to proceed without its prompt                                                        |
| autopilot | `ask`    | `ask`             | requests the host's native approval                                                                 |
| autopilot | `deny`   | `deny`            | blocks, with the reason                                                                             |

- **Observe is `ask`, and silent.** In Observe the host's own flow decides
  everything, which is what `ask` means. The adapter expresses it by emitting
  nothing, because a requested prompt would already change what the host does.
  The other two candidates are worse: `allow` would make a consumer that
  ignores `mode` wave everything through, weakening the host's own protection;
  copying `effect` would make it block in a mode that promised not to
  interfere. With `ask`, the worst a careless consumer can do is prompt.
- **Assist never blocks.** A `deny` becomes a request for native approval. A
  human who approves it is not semantic inference overriding a deny; it is the
  human the mode keeps in the loop. How `ask` is expressed per host, and what
  it becomes where nobody can answer, is ADR-007.
- **A mandatory deny blocks only in Autopilot.** An organization that needs a
  deny to hold has to fix the mode as well. That belongs to team policy
  (RFX-083, RFX-084) and is stated here so it is not discovered later.

### 3. `risk` and `confidence` without a model

- `confidence` is `1`. A rule matched or it did not; nothing was inferred.
- `risk` comes from a fixed table keyed by the action's side-effect class, owned
  by `packages/core`. It describes the action, not the verdict: an allowed
  `destructive` action is still risky, and a denied read is not.

| `sideEffectClass` | `risk` |
| ----------------- | ------ |
| `none`            | 0      |
| `local-read`      | 5      |
| `external-read`   | 15     |
| `local-write`     | 25     |
| `unknown`         | 50     |
| `external-write`  | 60     |
| `privilege`       | 80     |
| `credential`      | 85     |
| `destructive`     | 90     |
| `financial`       | 90     |

`unknown` sits in the middle on purpose: unknown is never safe, and it is not
known to be dangerous either.

## Consequences

### Positive

- One rule explains every cell: the mode changes what REFLEX does, never what
  it concludes. Replay and metrics read `effect`; enforcement reads
  `effectiveEffect`.
- "Prompts REFLEX would have removed" can be computed in Observe from `effect`
  and the observed outcome (ADR-013), before the user trusts REFLEX with
  anything.
- No contract change. Both fields keep their closed vocabulary.

### Negative

- An allow rule is trusted completely: once it matches, nothing looks at the
  action again. That is only acceptable because an allow rule matches nothing
  it does not fully understand (ADR-011) and an untrusted source cannot allow
  (ADR-012). It makes those two ADRs load-bearing.
- In Observe, `effectiveEffect` says `ask` for an action the host let through
  without asking. A consumer has to read `mode`, which is already required and
  closed.
- Assist lets a human approve what policy denies, mandatory or not.
- The risk table is a judgment frozen into numbers. It will be wrong somewhere.

### Follow-ups

- RFX-014 and RFX-015 implement stage 1; RFX-019 the order of stages.
- RFX-043 implements the table for Claude Code, RFX-049 for Codex.
- `CLAUDE.md` says durations are integer milliseconds, so a deterministic
  decision reports `policyMs: 0`. Whether sub-millisecond latency needs its own
  field is open and is the maintainer's call; it does not block G2.

## Alternatives considered

- **Observe as `allow`.** Rejected: fails dangerously in a consumer that does
  not check `mode`.
- **Observe copies `effect`.** Rejected: redundant with `effect`, and fails by
  interfering.
- **A fourth value (`none`).** Rejected: a breaking change to a closed field
  (ADR-009) for information `mode` already carries.
- **Assist enforces a mandatory deny.** Simpler for an organization, but it
  makes Assist a mode that blocks, against `CLAUDE.md`'s definition.
- **Let semantics raise a deterministic allow.** Rejected: it puts a model call
  on every allowed action, which is most actions, against "never call a model
  if deterministic policy can resolve the action".
- **`risk` from the effect** (allow 0, ask 50, deny 100). Rejected: it restates
  the verdict and says nothing about the action.

## Enforcement

- RFX-019: a table-driven test with all nine mode-by-effect cells, and a test
  that the provider is never called when policy resolves (the G3 gate exit
  already requires it).
- RFX-043: an adapter fixture test per cell; the Observe row is already held by
  `packages/cli/src/bin.e2e.test.ts`.
- RFX-105: the replay corpus asserts on `effect`, so a mode can never hide a
  wrong decision.

## References

- `CLAUDE.md`: "Decision semantics", "Product modes", principle 2, principle 4
- `docs/architecture.md`: §5
- ADR-004, ADR-007, ADR-009, ADR-011, ADR-012, ADR-013
- `packages/contracts/src/decision.ts`
