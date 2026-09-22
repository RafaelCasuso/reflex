# ADR-015: Open core boundary

- **Status:** Proposed
- **Date:** 2026-09-22
- **Tickets:** RFX-139
- **Supersedes:** none

## Context

Nothing in the repository says whether REFLEX is open source: the GitHub
repository is private, there is no `LICENSE`, every `package.json` is
`private: true` and declares no license, and no document mentions a
licence or a community edition. `docs/product.md` describes a hosted
product with a free Developer plan and paid plans metered on governed
actions.

Two facts decide the shape of the answer more than any preference does.

**Almost the whole data plane runs on the user's machine.** Since ADR-010
the CLI, the hook, the adapters, the command classifier, the policy engine,
the decision engine and the daemon are distributed as packages and run
locally. Whatever their licence says, a user can read them. What stays on a
server is the semantic path, approval learning, team policies, the
dashboard and billing.

**The product's trust claims are only credible if the local code is
inspectable.** REFLEX intercepts every tool call an agent makes and
promises that the arguments of an action policy resolves never leave the
machine, that it never disappears silently from the execution path, and
that an untrusted repository cannot loosen a policy. A closed hook in that
position is a hard sell to developers and an impossible one to security
reviewers.

The user has now asked for REFLEX to support Jev, Laya and a proprietary
model, RDM, behind one interface, with observability and a control plane.
Where the model lives, and where the data that trains it is collected, is
the same question as where the boundary is.

## Decision

Proposed; the maintainer decides. The recommendation is **open core**, with
the line drawn by one rule: **everything that runs on the user's machine,
and everything a third party needs to integrate with REFLEX or to write a
provider, is open. Everything that needs an account, and the model itself,
is private.**

### 1. Open, under Apache-2.0

| Package or app                                                | Why it must be open                                                                      |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/contracts`                                          | the wire format; SDKs and providers in other languages depend on it                      |
| `packages/policy-engine`, `command-classifier`                | the rules that decide are the product's safety claim; a rule nobody can read is not one  |
| `packages/core`                                               | the stage order, the fallbacks, the cache: what "REFLEX never disappears silently" means |
| `packages/context-compiler`                                   | the redaction boundary (ADR-006): what leaves the machine has to be auditable            |
| `packages/semantic-provider`                                  | the interface anyone can implement a provider against                                    |
| `packages/provider-jev`, `provider-local`                     | reference providers: a remote one and a local inference server                           |
| `packages/adapter-*`, `packages/cli`, `apps/decision-gateway` | what is installed on the machine                                                         |
| `packages/telemetry`                                          | what is recorded locally, and that nothing else is                                       |
| `packages/evals`                                              | the public benchmark and the corpus; results only mean something if the harness is open  |
| `packages/sdk-*`, `python/reflex-sdk`                         | integration surfaces                                                                     |
| `docs/`                                                       | the ADRs, the policy language, the threat model                                          |

### 2. Private

| Area                                                                                      | Why                                                                                            |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `apps/api`, `apps/dashboard`, `packages/auth`                                             | the control plane: accounts, projects, tenancy                                                 |
| approval learning (G12), team and organization policies (G16), replay service             | the loop that turns observed approvals into policy is the product                              |
| billing and metering (G15)                                                                |                                                                                                |
| the hosted semantic gateway configuration                                                 | keys, capacity, provider routing                                                               |
| `rdm/`: weights, training pipeline, dataset generators, teacher labels, benchmark answers | the model is the moat. Its inference API is the public canonical contract; its weights are not |

### 3. What "open" gives, and what "private" adds

Open REFLEX alone is a deterministic guardrail and a prompt reducer: Observe
mode, a policy that removes prompts for what the user codifies and denies
what the user forbids, workspace trust, one policy across hosts, a local
audit log, and a semantic path through any provider the user configures
with their own key, Jev included. What policy leaves open ends in `ask`.

Private REFLEX adds what grows autonomy without the user writing rules: RDM
as a hosted provider, approval learning, team policies, replay, the
dashboard, and hosted context that a laptop cannot keep.

### 4. Mechanics

- A user's own provider key in the open daemon is allowed (the
  "customer-managed provider" `CLAUDE.md` principle 3 already lists). It is
  the strongest adoption lever and the privacy story; the paid value is the
  loop, not the call.
- Until the repositories are split, the boundary is declared and enforced
  in place: `license` in every open `package.json`, a `LICENSE` at the
  root, `docs/open-core.md` listing both sides, and a boundary test that
  **no open package may depend on a private one** (the reverse is free).
  Splitting into a public `reflex` and a private `reflex-cloud` is a later
  ticket and moves nothing that this rule has not already separated.
- `rdm/` starts private from its first commit, even while it lives in this
  repository, and the CI job that runs it never publishes an artifact.

## Consequences

### Positive

- The trust claims become checkable, which is what a hook in the execution
  path needs.
- Adoption before account creation, as `CLAUDE.md` requires, with nothing
  held back on the local path.
- Providers written by others (a customer's own model, Laya) fit without
  REFLEX's involvement.
- The open benchmark makes RDM's advantage demonstrable rather than claimed.

### Negative

- The engine, the classifier and the policy language can be forked and
  run forever for free. The Developer plan already assumes that; what it
  costs is a competitor who also builds the loop and the model.
- Two repositories eventually, with a published-package boundary between
  them, is more release work than one.
- A user with their own key gets the semantic path without paying. The
  bet is that they pay for learning, team and RDM, not for the call.

### Follow-ups

- RFX-139: decide, add `LICENSE` and `license` fields, `docs/open-core.md`,
  the boundary test.
- The repository split, when the public repository is opened; a ticket in
  G14 next to publishing packages (RFX-076, RFX-077).
- `docs/product.md`: say which plan features come from the private side.

## Alternatives considered

- **Fully proprietary.** Simplest commercially, and the weakest position
  for a security tool that runs on every tool call: the claims cannot be
  audited and installation friction rises.
- **Source-available (BSL or FSL) for everything.** Readable, not reusable
  to compete, and after a term it converts. Protects the engine more and
  costs adoption: many organisations do not allow BSL code in their tree,
  and providers written by others could not be redistributed. Kept as the
  fallback if forking of the engine turns out to matter more than expected.
- **Everything open, including the control plane.** Coherent and easy to
  trust, and it leaves nothing to sell but hosting, which the model and the
  loop were supposed to be.

## Enforcement

- RFX-139: `tests/boundaries.test.ts` gains "open never depends on
  private", driven by a list in `docs/open-core.md` that the test reads, so
  that the document and the rule cannot drift.
- Every open `package.json` declares `"license": "Apache-2.0"`; a test
  holds that the list in the document and the manifests agree.
- `rdm/` is excluded from every publish path by name.

## References

- `CLAUDE.md`: principle 3 (Jev is a provider, not the architecture), "UX
  rules" (first value before account creation)
- `docs/product.md`: pricing hypothesis, non-goals
- ADR-005, ADR-006, ADR-010, ADR-016
- `docs/rdm/gate-0-assessment.md`
