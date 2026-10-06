# How a decision is made

Every tool call your agent makes runs REFLEX's hook; the hook asks a local daemon; the daemon answers allow, ask or deny. This page is the order it works in and the rules that bind it. Nothing here is a preference: each step is held by a test in the repository.

## The order

1. **Normalize.** The host's event becomes one canonical action, the same shape for Claude Code and Codex: the tool, its arguments, the working directory, the repository's branch and remote, the environment. A shell command is parsed into its segments; a compound command is judged segment by segment.
2. **Classify.** Each segment gets a side-effect class: a read, a local write, something destructive, external, financial, a credential, a privilege change, a production system, or not understood. A class can be raised by a later step and is never lowered.
3. **Redact, locally.** Fifteen shapes of secret are replaced by fingerprints before anything else reads the arguments. Nothing after this step, in the daemon or anywhere, sees the values.
4. **Evaluate the policy.** Every rule of every source is evaluated (see below). If the policy resolves the action, this is the decision, deterministically, in well under a millisecond on a typical call, and no model is asked.
5. **Only if unresolved, assess.** With a provider turned on and consented to, the daemon sends a minimal, redacted context and gets back a risk assessment. The assessment is evidence; the aggregator owns the decision and the policy's floors still hold. Without a provider, an unresolved action asks.
6. **Record.** The decision, the rules that matched, the set's hash and, later, what the human and the host did about it.

## The verdicts, per mode

The daemon always computes a canonical effect; what reaches the host depends on the project's [mode](./modes.md): Observe answers nothing; Assist turns a deny into the host's own prompt and never blocks; Autopilot enforces. `rfx explain` prints the effect and what each mode would do with it.

## Sources and precedence

A policy set is made of up to five sources, from the most general to the most specific: REFLEX's own rules, the organization's (a team's signed snapshot), the environment's (the part of that snapshot for production or staging), the project's `.reflex/policy.yaml`, and your own `~/.reflex/policy.yaml`.

- **Defaults cascade down.** A more specific source overrides a non-mandatory rule of a more general one, in either direction: the organization states defaults, the project refines them, you refine those.
- **Mandates hold from above.** A rule marked `mandatory` is a floor: the final effect is at least as restrictive as it, whatever any other source says. A mandatory `allow` does not compile.
- **Tightening is always allowed.** A project `deny` beats an organization's `ask`.
- **Untrusted sources only tighten.** A repository's policy is untrusted until you trust that version of it; untrusted, its allow rules are ignored and its deny and ask rules still apply.
- **A production deny is a floor** whether or not it says mandatory, and environment rules apply only to actions resolved to their environment.

Inside one source, rule order never matters: deny beats ask beats allow. So reordering a policy is always safe, and the set's hash depends on what the rules mean and on nothing else.

## When something fails

REFLEX never silently disappears from the path. Each failure has a defined answer, by the project's failure mode: a daemon that cannot be reached, a provider that times out or answers garbage, a policy that does not load.

- `fail-ask` (the default): the host's own prompt.
- `fail-open`: only a known low-risk read runs; everything else asks.
- `fail-closed`: deny.

A policy that does not load leaves the last good one in force and says so in `rfx doctor`; a team snapshot that does not verify is refused and the last good one stays.

## Overriding a deny

A human can let one denied action through once, with `rfx override <decision id>`; the id is in the message the host showed. The grant is for that exact action, is used once, never applies to a mandatory deny from the team's snapshot, and is recorded as the human's. The agent cannot run the command for them: `rfx override`, like `rfx trust` and `rfx mode`, is protected by REFLEX's own rules.

## What is recorded

Each decision is written locally with the matched rules, the policy set's hash, and the provider's assessment when there was one; the host's outcome (did it run, was the human asked, what did they say) is joined to it afterwards. [What is stored, and for how long.](./stored.md)
