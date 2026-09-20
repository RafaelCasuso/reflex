# REFLEX Product Brief

## Positioning

**REFLEX**  
**The autonomy control layer for AI agents.**  
**More autonomy. Less supervision.**

REFLEX lets AI agents automatically execute safe actions, defer uncertain decisions to humans, and stop dangerous actions before execution.

---

## Initial wedge

Coding agents.

Why:

- frequent tool calls
- approval fatigue
- high-cost side effects are understandable
- developer-led adoption
- strong viral terminal UX
- zero-rearchitecture integrations are possible
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

### 1. Approval elimination

REFLEX learns repeated safe patterns and proposes explicit policies.

### 2. Risk interception

REFLEX surfaces/block actions whose risk is contextual rather than syntax-only.

### 3. Team standardization

The policies that make one engineer's agents productive become versioned team policy.

### 4. Policy replay

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
