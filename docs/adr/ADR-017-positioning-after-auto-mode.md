# ADR-017: Positioning and gate order after the hosts' own permission classifiers

- **Status:** Accepted
- **Date:** 2026-10-03
- **Tickets:** RFX-083, RFX-084, RFX-137, RFX-150
- **Supersedes:** none

## Context

REFLEX was planned in September 2026 around one wedge: a developer with a
coding agent, drowning in approval prompts, installs `rfx init` and gets
prompts removed safely. The plan after G8 ran persistence (G10), dashboard
(G11), approval learning (G12), MCP (G13), SDKs (G14), billing with the
public website (G15) and, last, team foundations (G16).

Facts that changed, checked on 2026-10-03:

- The wedge's pain is measured and real. Anthropic reported that Claude
  Code users approve 93% of permission prompts in March 2026 and 97% in
  August; in a study of 1,053 paid testers, people caught 13.6% of dangerous
  commands and the host's classifier 89%.
- The host is absorbing the single-user solution. Claude Code's Auto mode,
  a two-stage transcript classifier, is the default permission mode since
  2026-08-14 (reported 0.4% false positives, 17% false negatives), and its
  OS sandbox cuts prompts by 84%. Codex shipped hooks that are a near-port
  of Claude Code's. Open-source gates that block `rm -rf` and force-pushes
  from a `PreToolUse` hook exist for both hosts.
- The money sits one level up. Gartner made AI governance platforms a Magic
  Quadrant category in June 2026 and projects guardian agents at 10 to 15%
  of the agentic market by 2030; the ten largest agentic-security startups
  raised $3.6B in the year, mostly in agent identity, permissions and
  runtime governance.
- What REFLEX already has that a host classifier does not: deterministic,
  explainable policy with a precedence model across sources (ADR-004),
  decision records with the provenance of every label and the human's
  outcome (ADR-016), a measured human override (RFX-125), a consent and
  redaction boundary (ADR-006, RFX-123), and two hosts on one canonical
  contract (ADR-001, G7, G8). What it lacks is a way for a team to share
  one policy without an account, and a public door.

If nothing is decided, REFLEX ships, in order, a dashboard and billing for a
single-developer loop that the host will have made redundant, and reaches
teams last.

## Decision

Accepted by the maintainer on 2026-10-03, as proposed the same day.

### 1. The positioning

REFLEX is **one policy for every agent, auditable**. The first thing it is
for is a team that runs more than one agent, Claude Code and Codex today,
MCP and SDKs next, and wants one explainable policy applied everywhere,
every decision recorded with what the human and the host then did, and a
measured way to override. Removing prompts for one developer remains a
loop, not the headline.

### 2. The stance toward the hosts' own controls

REFLEX sits beside a host's permission classifier and sandbox, never in
place of them. Auto mode decides from a transcript with a model; REFLEX
decides from a policy the team wrote and can read, before the model is
asked, across hosts, and keeps the record. Public material names this
plainly and never claims to replace a sandbox (`docs/security.md`).

### 3. The order of gates after G9

A new gate G9.5 goes between G9 and G10, and the MCP proxy moves ahead of
the dashboard:

| Order | Gate | What it buys                                                                                                                                                            |
| ----- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | G9   | a real `rfx init` without an account, `rfx doctor`, `rfx explain`, signed releases, the repo split                                                                      |
| 2     | G9.5 | one signed team policy applied by every member's daemon with no account (RFX-083, RFX-084); public documentation (RFX-137); a public landing and install page (RFX-150) |
| 3     | G10  | persistence, claim flow, retention: the data flywheel                                                                                                                   |
| 4     | G13  | the MCP proxy: "every agent" becomes true beyond two CLIs                                                                                                               |
| 5     | G11  | dashboard and activation, once there are records to show                                                                                                                |
| 6     | G12  | approval learning on real records                                                                                                                                       |
| 7     | G14  | SDKs                                                                                                                                                                    |
| 8     | G15  | billing and the pricing page (RFX-136), once pricing has met users (RFX-135)                                                                                            |
| 9     | G16  | organizations and memberships (RFX-082)                                                                                                                                 |

Ticket IDs do not change. RFX-083 and RFX-084 move from G16 to G9.5 and
RFX-083 is rewritten so that a team can publish a signed policy snapshot to
a URL or a file of their own, which the daemon verifies and compiles as the
`organization` source the engine has had since G2; the hosted control plane
later publishes to the same format. RFX-137 moves from G15 to G9.5. RFX-150
is new: the public landing without pricing. RFX-136 keeps the pricing page.

### 4. What does not change

The architecture: canonical contracts, policy first and a model only for
what policy leaves open, the provider as a plug (ADR-016), open core
(ADR-015), the hot-path budgets. The semantic provider strategy of ADR-016
holds: Jev bootstraps, a frontier model may teach and shadow off the path,
RDM is trained when real decision records exist and not before.

## Consequences

### Positive

- Teams, where budgets and the governance category are, are reached three
  gates earlier, with no control plane to build first.
- The public door opens right after the product is installable, so real
  decision records start accruing, which is what approval learning and RDM
  need.
- The message no longer competes with the host on the host's own ground.

### Negative

- Billing arrives later; the first teams pay nothing for a while.
- A signed snapshot by URL is a second distribution path that the hosted
  control plane must stay compatible with.
- Dashboard and activation (G11) wait; the first user experience is
  terminal and documentation only.

### Follow-ups

- RFX-083, RFX-084, RFX-137, RFX-150 in G9.5; RFX-136 narrowed to pricing.
- `docs/product.md` rewritten to this positioning; `docs/backlog.md`
  reordered; the website brief of RFX-150 carries the "anti-slop" design
  rules: typography-led, real terminal captures, numbers from this
  repository only, no stock gradients, no claim that is not measured.
- Re-check the market facts above before G15; they move monthly.

## Alternatives considered

- **Keep the order.** Rejected: it ships a dashboard and billing for a loop
  the host now covers by default, and reaches teams last.
- **Pivot wholly to enterprise governance now** (SSO, SCIM, SIEM first).
  Rejected: without an installable product and real records REFLEX would
  be a slide; the enterprise items stay in G15 and G16.
- **Drop the semantic provider and be a deterministic gate only.** Rejected:
  the deterministic part is where the open-source gates compete; the
  provider and the records are what make the policy improve. The order of
  ADR-002 already keeps the model out of most decisions.
- **Compete with Auto mode on classification quality.** Rejected: that is
  the host's data and the host's distribution. REFLEX competes on policy,
  reach and record.

## Enforcement

- `docs/backlog.md` carries the order of §3 and the moved tickets with
  their new acceptance; the gate exits say what has to be demonstrably
  true. `tests/adr.test.ts` keeps this ADR indexed with its status.
- RFX-150's acceptance makes the public claims mechanical: every number on
  the page comes from a file in this repository that a test checks.
- RFX-083's acceptance: a local policy cannot weaken a mandatory rule of
  the subscribed snapshot, held by the precedence tests of RFX-014 run
  against a subscribed set.

## References

- `CLAUDE.md`: north-star metric, principle 6 (policy cannot silently weaken).
- ADR-004 (policy precedence), ADR-006 (redaction), ADR-012 (workspace
  trust), ADR-015 (open core), ADR-016 (providers and records).
- The Register, 2026-08-06, humans miss a third of dangerous coding-agent
  requests; 9to5Mac, 2026-08-14, Auto mode becomes the default; Backslash,
  "Auto mode catches a lot, but not everything"; Anthropic Engineering,
  Claude Code sandboxing; Gartner press releases of 2026-04-28 and
  2026-05-26 and the AI governance platforms Magic Quadrant (June 2026);
  Software Strategies Blog, 2026-03-28, agentic AI security funding.
