# REFLEX Product Brief

## Positioning

**REFLEX**  
**The autonomy control layer for AI agents.**  
**One policy for every agent, auditable.**  
**More autonomy. Less supervision.**

REFLEX applies one policy a team wrote and can read to every agent it runs,
Claude Code and Codex today, MCP and SDKs next: safe actions execute, uncertain
ones go to the human through the host's own prompt, dangerous ones stop before
execution. Every decision is recorded with what the human and the host then
did, and a human can override a block once, on the record.

## Why now, and beside what (ADR-017)

The hosts now ship their own permission classifiers. Claude Code's Auto mode is
the default since August 2026, decides from the transcript with a model, and
its sandbox removes most prompts; Codex copied the hook model. REFLEX does not
compete with that on its own ground and never replaces a sandbox
(`docs/security.md`). It sits beside them and adds what a single host cannot:

- a policy the team wrote, deterministic and explainable, applied before any
  model is asked (ADR-002, ADR-004), the same on every host;
- the record: what was asked, what was decided, why, and what the human and
  the host did next, with the provenance of every label (ADR-016);
- a measured human override (RFX-125) and, later, approval learning that
  proposes rules a human accepts (G12).

The money and the governance category are with teams and organizations
(Gartner, June 2026); the pain is measured with individual developers, who
approve 93 to 97 percent of prompts by reflex. REFLEX enters through the
developer and is bought by the team.

---

## Initial wedge

Teams that run coding agents, entered through one developer.

Why:

- frequent tool calls
- approval fatigue, now measured by the hosts themselves
- high-cost side effects are understandable
- developer-led adoption
- strong viral terminal UX
- zero-rearchitecture integrations are possible
- one policy across hosts is what the hosts will not build
- natural expansion into team governance

Initial supported targets:

1. Claude Code
2. Codex
3. MCP
4. TypeScript SDK
5. Python SDK

---

## Core adoption loop

```text
rfx init
  ↓
Detect agents
  ↓
Install safe adapter/hooks
  ↓
Observe mode
  ↓
Analyze real actions
  ↓
Show autonomy opportunity
  ↓
Enable Assist
  ↓
Subscribe to the team's signed policy (RFX-083)
  ↓
Suggest policies
  ↓
Replay impact
  ↓
Autopilot / team rollout
```

### Time-to-value goals

- install: < 2 minutes
- first governed action: < 5 minutes
- useful insight: same working session
- account required before first value: no, where technically possible

---

## Core value loops

### 1. One policy, every agent

A team publishes one signed policy; every member's daemon applies it to Claude
Code, Codex and, later, MCP and SDKs, and a local policy cannot weaken it
(RFX-083, RFX-084, ADR-004).

### 2. The record

Every decision is kept with the redacted request, the model's evidence, the
effect, the human's response and what the host did (ADR-016). It is the audit
trail, the source of the autonomy and override metrics, and the training data.

### 3. Approval elimination

REFLEX learns repeated safe patterns and proposes explicit policies a human
accepts; nothing changes enforcement on its own (CLAUDE.md principle 8).

### 4. Risk interception

REFLEX surfaces or blocks actions whose risk is contextual rather than
syntax-only.

### 5. Policy replay

Teams can test a policy against historical actions before enforcing it.

---

## Product modes

### Observe

No execution changes.

### Assist

Low-risk safe actions are auto-approved where host capabilities permit. Other actions use native host approval.

### Autopilot

REFLEX applies the complete allow/ask/deny policy.

---

## Open core

Everything that runs on the user's machine is open under Apache-2.0 (ADR-015,
`docs/open-core.md`): the CLI, the hook, the adapters, the policy engine and
the classifier, the decision engine and the local daemon, the redaction
boundary, the provider interface and the reference providers, the evals. A
user can run the deterministic path and a semantic provider of their own,
with their own key, without an account. What the plans below add comes from
the private side: RDM as a hosted provider, approval learning, team and
environment policies, replay, the dashboard, retention and support.

## Pricing hypothesis

### Developer — $0

- 50k governed actions/month
- one user/workspace
- core integrations
- 7-day history
- Observe / Assist / Autopilot

### Pro — $49/month

- 250k governed actions
- multiple projects
- longer history
- approval learning
- policy replay
- webhooks

### Team — $249/month

- 2M governed actions
- shared policies
- environment policies
- team analytics
- 90-day history
- Slack/webhooks

### Scale — $999/month

- 5M governed actions
- service accounts
- higher throughput
- extended retention
- priority support

### Enterprise — from $2,500/month

- SSO/SAML
- SCIM
- SIEM
- custom retention
- private networking
- custom SLA
- private/hybrid gateway options

Meter:
`governed_action`

Users should never be billed in model tokens.

Under review: since ADR-010 most decisions are made on the user's machine and never reach a server, so what a `governed_action` is, and where it is counted, has to be decided before the meter is built (RFX-129, ADR-014). These tiers have not met users yet (RFX-135).

---

## Non-goals

REFLEX is not:

- an agent builder
- an orchestration framework
- generic observability
- prompt moderation
- IAM
- generic workflow software
- a replacement for host sandboxes
- a replacement for a host's own permission classifier: it sits beside it
