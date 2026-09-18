# ADR-012: Self-protection and workspace trust

- **Status:** Proposed
- **Date:** 2026-09-18
- **Tickets:** RFX-101, RFX-102, RFX-103, RFX-104
- **Supersedes:** none

## Context

REFLEX governs an agent that runs as the same user, on the same machine, with
write access to the same files as REFLEX itself. Two direct attacks follow, and
the backlog has no ticket for either.

**The governed agent can switch REFLEX off.** In Assist or Autopilot, nothing
stops an agent (or a prompt injection steering it) from editing
`.reflex/policy.yaml`, removing the hook from the host's settings file, killing
a local daemon, or shadowing the `rfx` binary on `PATH`. Each of those is an
ordinary file write or shell command. If policy allows file writes inside the
repository, it allows rewriting the policy.

**A repository can bring its own permissive policy.** `docs/architecture.md`
§8 ranks project policy above user policy. `.reflex/policy.yaml` lives in the
repository. Clone a hostile repository, and its allow-all policy outranks the
user's own rules. "Policy cannot silently weaken" (`CLAUDE.md` principle 6) is
violated by `git clone`.

There is also an honest limit to state. `docs/product.md` says REFLEX is not a
replacement for host sandboxes. A same-user process that is determined and
unconstrained can always defeat a same-user control. The goal here is narrower
and achievable: an agent that is well-behaved but mistaken, or one that has
been prompt-injected, must not be able to disable REFLEX through the very
actions REFLEX governs, and any tampering must be visible.

## Options

1. **Leave it to user-written policy.** Users add their own deny rules.
2. **Built-in mandatory rules**, above every policy source and not overridable,
   covering writes to REFLEX's configuration, policy files, hook registration
   in host settings, and REFLEX binaries.
3. **Integrity verification.** Record what was installed; `rfx status` and
   `rfx doctor` report a removed or altered hook or policy.
4. **Workspace trust.** A project policy is untrusted until the user trusts it.
   Trust is bound to the policy content and asked again when it changes.

## Decision

Not decided.

Recommendation (not binding): **2, 3 and 4 together**, with one rule that makes
workspace trust safe by default.

- Option 1 is rejected: the default install would be trivially bypassable, and
  the people most exposed are the ones who never edit a policy.
- **Untrusted can only tighten.** Until a project policy is trusted, its deny
  and ask rules apply and its allow rules are ignored. A hostile repository can
  make REFLEX stricter, never looser. This keeps the zero-friction promise:
  cloning a repository never needs a decision from the user to stay safe.
- Self-protection rules resolve to `ask`, not `deny`, for the human: the user
  must remain able to edit their own policy through the agent if they approve
  it. What is forbidden is doing it without a human.

## Consequences

If the recommendation is accepted:

### Positive

- The default install resists the most obvious attack on it.
- `git clone` cannot weaken a user's safety.
- Tampering becomes visible in `rfx status` instead of silent.

### Negative

- Self-protection depends on recognizing indirect writes (redirects, `sed -i`,
  `mv`, symlinks, a script that does it). It is only as good as the command
  classifier (ADR-011), and it needs its own adversarial corpus.
- One more prompt in the life of a repository (trusting its policy), and again
  whenever that policy changes.
- Policy precedence gains a dimension: source, mandatory flag, and now trust.
  ADR-004 has to account for it.
- It must be stated plainly to users that this is not a sandbox.

## Open questions

- Where is trust stored, and is it per user, per machine or per clone path?
- Does an organization policy distributed by the control plane (signed,
  RFX-083) bypass workspace trust? Probably yes; that is its purpose.
- Which host settings files count as "hook registration" for each host, across
  project, user and managed scopes?
- Can the agent trust a workspace on the user's behalf? It must not: the trust
  prompt itself has to be outside what the agent can answer.

## References

- `CLAUDE.md`: principle 5 (fail explicitly), principle 6 (policy cannot
  silently weaken)
- `docs/architecture.md`: §7 host integration, §8 policy architecture
- `docs/product.md`: non-goals ("a replacement for host sandboxes")
- ADR-011 (classification), ADR-004 (policy precedence, planned)
- `docs/backlog.md`: RFX-054, RFX-055, RFX-101 to RFX-104
