# ADR-013: Action outcome observation

- **Status:** Accepted
- **Date:** 2026-09-19
- **Tickets:** RFX-091, RFX-092, RFX-093
- **Supersedes:** none

## Context

REFLEX records what an agent intended to do (`CanonicalAction`) and what REFLEX
decided (`ReflexDecision`). Nothing records what the **host** then did: whether
it prompted the human, whether the human approved or rejected, whether the
action executed.

ADR-001 §2 excludes execution results from the action, correctly: REFLEX
decides before the side effect. But without that information somewhere, several
things the product promises cannot be computed at all:

- **`safe_autonomous_actions`**, the north-star metric. "Autonomous" means the
  human was not interrupted. "Safe" needs ground truth, and the cheapest ground
  truth is what the human did when asked.
- **"Approval prompts eliminated"** (RFX-081). This is a counterfactual: how
  many prompts would the host have shown without REFLEX.
- **The first-session activation card** (RFX-065), which has to state an
  observed autonomy opportunity and "never claims unmeasured safety".
- **Approval Learning** (RFX-068). The approvals it mines are the host's native
  approvals. REFLEX does not currently see them.
- **Human override rate**, a supporting metric in `CLAUDE.md`.

There is a subtlety that makes this worth an ADR and not just a field. In
Observe, the host behaves natively, so its prompts and the human's answers are
observable. In Assist and Autopilot, REFLEX suppresses prompts, so the
counterfactual ("would the host have asked?") is no longer observable for the
actions REFLEX allowed. "Prompts eliminated" in those modes is an estimate built
on Observe-period base rates, and it must be labelled as one.

## Options

**A. A separate `ActionOutcome` contract, keyed by `actionId`.** Written by the
adapter after the fact. Carries: whether the host prompted, the human's answer
if any, whether the action executed, timestamps, and `unknown` wherever the host
exposes no signal.

**B. Extend `ReflexDecision` with host outcome fields.** One record per action.

**C. Put outcome data in `adapterMetadata`.**

## Decision

**Option A**, accepted by the maintainer on 2026-09-19: REFLEX records what the
host did in a separate `ActionOutcome` contract, keyed by `actionId`.

It was proposed on 2026-09-18 with the reasoning below, which stands as the
rationale.

- B is rejected because a decision is written before the outcome exists, by a
  different writer (gateway, not adapter). Mutating a decision after the fact
  breaks its immutability and everything that hashes or replays it.
- C is rejected because `adapterMetadata` is opaque by ADR-001 §3, and product
  metrics are a form of influence. It would also make the most important
  product numbers depend on an untyped bag.

The contract is an additive change (ADR-009, shipped as contract version 1.1).
It is an **input** to metrics and learning and is therefore read strictly. It
carries no tool output and no argument values.

Three rules complete the decision:

- **`unknown` is a value.** Where the host exposes no signal the field says
  `unknown`. A consumer must never read `unknown` as `no`.
- **A record may not contradict itself.** No answer without a question, no
  known answer to an unknown question, no rejected action that ran. Such a
  record is rejected, never reconciled, because it would let one action count
  as both interrupted and autonomous.
- **Assembly is the adapter's job.** Host signals arrive as separate events. The
  adapter correlates them and emits one outcome per action; correlation
  identifiers stay in the adapter and do not enter the contract.

## Consequences

### Positive

- The north-star metric, override rate and ROI figures become computable from
  typed, versioned data.
- Approval Learning gets the signal it is defined on.
- Observe delivers insight without any decision engine, which is what makes the
  G1.5 walking skeleton useful on its own.

### Negative

- A second event per action to transport, store and retain.
- Host signal coverage is uneven. Some outcomes will be `unknown`, and every
  metric has to say how it treats them.
- Correlating the post-execution signal with the right action depends on a
  host-provided identifier, which lives in `adapterMetadata`. That is
  correlation, not influence, and stays within ADR-001 §3.

## Open questions

These remain open after acceptance. None of them changes the contract.

- Which signals does each supported host actually expose, and in which modes?
  (RFX-092 and RFX-093 answer this with fixtures.)
- Do `unknown` outcomes count toward the autonomy rate, against it, or neither?
- How are estimated figures (Assist and Autopilot counterfactuals) labelled in
  the dashboard and in `rfx status`?
- Retention: outcomes reveal human behavior. Same retention class as decisions,
  or shorter?

## References

- `CLAUDE.md`: "North-star metric", principle 8
- ADR-001 §2 and §3, ADR-009 §2 and §3
- `docs/backlog.md`: RFX-065, RFX-068, RFX-081, RFX-086
