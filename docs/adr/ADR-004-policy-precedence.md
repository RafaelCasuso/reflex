# ADR-004: Policy precedence

- **Status:** Proposed
- **Date:** 2026-09-20
- **Tickets:** RFX-114, RFX-012, RFX-014, RFX-015, RFX-016
- **Supersedes:** none

## Context

`CLAUDE.md` principle 6: local, organization and managed policies have an
explicit precedence model; a lower-precedence policy must never weaken a
mandatory higher-precedence deny; every resolution is explainable through
matched rules, precedence and final effect.

`docs/architecture.md` §8 lists the sources, highest first: mandatory
organization, environment, project, user or local. The contract has
`PolicyRule.mandatory`, `PolicyMatch.precedence` and one
`defaults.unresolved` per document. None of them has a defined meaning yet:

- If a higher source always wins, `mandatory` means nothing. If it does not,
  what may a lower source do?
- How is `precedence` computed, and what breaks a tie?
- Several documents each carry a `defaults.unresolved`. Which one applies?
- A project policy comes from whoever wrote the repository (ADR-012).

## Decision

Not decided.

Recommendation (not binding): **defaults cascade down, mandates hold from
above.**

### 1. Sources

From the most general to the most specific: `built-in`, `organization`,
`environment`, `project`, `local`. `built-in` holds REFLEX's own rules
(RFX-103) and ships with the binary. Learned suggestions that nobody accepted
are not a source and have no effect.

### 2. What `mandatory` means

A mandatory rule sets a **floor**: when it matches, the final effect is at
least as restrictive as its own, whatever any other rule says, from any source.
"Restrictive" is `deny > ask > allow`.

- `mandatory` is valid on `deny` and `ask`. A mandatory `allow` is rejected at
  compile time: a floor of `allow` is no floor, and its only use would be to
  force something through.
- Any source may mark a rule mandatory, and the floor then holds for every
  source. On a `local` rule it changes nothing: the most specific source
  already decides the cascade, and inside one source the most restrictive
  effect already wins.

### 3. What a lower source may do

**Yes, a more specific source overrides a non-mandatory rule from a more
general one**, in either direction. That is the whole difference between a
default and a mandate: an organization states its defaults, a project refines
them, a user refines those. What must hold is marked `mandatory`.

Tightening is always possible, even against a mandate: a project `deny` beats
an organization's mandatory `ask`.

### 4. Resolution

Given the rules whose conditions all hold:

1. **Trust.** Drop every `allow` rule from a source that is not trusted
   (ADR-012). Its `deny` and `ask` rules stay: untrusted can only tighten.
2. **Floor.** The most restrictive effect among the mandatory matches, if any.
3. **Cascade.** Take the most specific source that has a non-mandatory match.
   Within it, the most restrictive effect among its matches. More general
   sources' non-mandatory matches are overridden and are still reported.
4. **Final effect:** the more restrictive of floor and cascade. With neither,
   the action is unresolved.

Inside one source there is no ordering by position: `deny > ask > allow`. Rule
order in a file never changes a decision, so reordering a policy is always
safe.

### 5. `PolicyMatch.precedence`

An integer that orders the matches for explanation; a larger number is
stronger. It is derived, never written by hand:

| Source         | Non-mandatory | Mandatory |
| -------------- | ------------- | --------- |
| `built-in`     | 10            | 150       |
| `organization` | 20            | 140       |
| `environment`  | 30            | 130       |
| `project`      | 40            | 120       |
| `local`        | 50            | 110       |

Every mandatory match outranks every non-mandatory one; among mandates the
more general source is stronger; among defaults the more specific one is. The
**deciding match** is the one with the final effect and the highest precedence,
and with equal precedence the smallest rule ID in code-point order. It is
listed first. Every other match is listed after it, by precedence, including
the ones that lost: a user has to be able to see the organization default that
their local rule overrode.

### 6. `defaults.unresolved`

The most restrictive value declared by any source applies:
`deny > ask > semantic`. A default has no `mandatory` flag, so it cannot be
loosened from below at all. With no source declaring one, it is `ask`.
`semantic` with no provider configured is read as `ask` (ADR-002).

### 7. Trust

Trust is a property of a source instance, not of a rule: a project policy is
untrusted until the user trusts that content (RFX-104). Trust enters precedence
in exactly one place, step 1 above. `built-in`, `organization`, `environment`
and `local` are trusted by construction; how the first three are authenticated
when they arrive over the network is RFX-083.

## Consequences

### Positive

- `mandatory` has a precise, testable meaning, and `CLAUDE.md` principle 6
  becomes a theorem of step 4: no rule can bring the final effect under the
  floor.
- A hostile repository can make REFLEX stricter and never looser, with no
  decision asked of the user.
- Decisions do not depend on rule order or file formatting, which is what
  makes the policy hash (RFX-016) meaningful.
- Every decision is explainable from its matches alone.

### Negative

- A local `allow` silently beats a non-mandatory organization `deny`. That is
  the design, and it will surprise an administrator who did not write
  `mandatory`. `rfx explain` (RFX-099) has to show overridden rules, and the
  policy reference (RFX-100) has to say this in its first paragraph.
- The engine must evaluate every rule of every source. It cannot stop at the
  first match. RFX-015's benchmark has to show that this fits in 10 ms.
- `defaults.unresolved` cannot be loosened locally. A user whose organization
  says `deny` for the unknown cannot opt into `semantic`.

### Follow-ups

- RFX-012 rejects a mandatory `allow`, with the line and the reason.
- RFX-014 implements steps 1 to 4; RFX-015 reports the matches in the order of
  section 5.
- The source of a rule is not in `PolicyMatch` today. If `rfx explain` needs
  it spelled out instead of derived from `precedence`, that is an additive
  contract change (ADR-009).

## Alternatives considered

- **Strict hierarchy: the most general source with a match wins.** Simple, and
  `mandatory` becomes meaningless: a user could never refine anything.
- **Most restrictive match always wins.** Safe, and nobody could ever allow
  anything that any source asks about. It kills the autonomy the product is
  for.
- **First match wins, by file order.** Familiar from firewalls, and it makes
  formatting part of the semantics: moving a rule changes decisions and the
  hash means nothing.
- **Mandatory `allow`.** Rejected above.
- **Trust as a weight in the precedence number.** Rejected: trust is a gate on
  what may loosen, not a degree of strength.

## Enforcement

- RFX-014: an exhaustive test over every combination of source, `mandatory` and
  effect for two and three matching rules, asserting the theorem: the final
  effect is never under any mandatory match. Adversarial: an untrusted project
  `allow` against every other source.
- RFX-012: a mandatory `allow` does not compile.
- RFX-016: two documents that differ only in rule order have the same hash and
  the same decisions on the replay corpus.
- The gate exit already demands it: "a mandatory deny is shown by test not to
  be weakened by any lower source".

## References

- `CLAUDE.md`: principle 6
- `docs/architecture.md`: §8
- ADR-002, ADR-011, ADR-012
- `packages/contracts/src/policy.ts`
