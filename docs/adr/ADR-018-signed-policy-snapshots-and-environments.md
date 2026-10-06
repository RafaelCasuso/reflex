# ADR-018: Signed policy snapshots and environment resolution

- **Status:** Accepted
- **Date:** 2026-10-07
- **Tickets:** RFX-083, RFX-084
- **Supersedes:** none

## Context

ADR-004 gives the engine five sources, `built-in`, `organization`,
`environment`, `project`, `local`, and says in §7 that how the first three
are authenticated when they arrive over the network is RFX-083. Since G2 the
engine has applied an `organization` and an `environment` source correctly;
nothing has ever produced one. ADR-017 makes "one policy for every agent,
auditable" the positioning, and RFX-083 its first deliverable: a team
distributes one policy to every member's daemon without an account and
without a control plane.

Three questions had no answer:

1. **What is distributed, and how is it trusted?** A file a daemon fetches
   from a URL is content from the network. ADR-012 trusts nothing a
   repository ships until a human looks at it; a team policy cannot ask a
   human on every machine every time it changes, and must not be loosened
   by whoever controls the URL, the DNS or the disk cache.
2. **What does an `environment` source apply to?** The contract carries
   `resource.environment` (ADR-001 §4) and the policy language can match on
   it, but no host says what environment an action is in: every action has
   been `unknown` since G1. A production rule that never fires is a false
   sense of safety.
3. **What may a production rule be overridden by?** ADR-004 §3 lets a more
   specific source override a non-mandatory rule of a more general one. A
   team that writes `deny` in its production policy and forgets `mandatory`
   would have that deny silently beaten by a project `allow`; RFX-084 asks
   that a production deny hold against every lower source.

## Decision

Accepted by the maintainer on 2026-10-07, as implemented.

### 1. The snapshot

A team policy is distributed as a **signed snapshot**: one JSON envelope,
`format: 1`, carrying the team's label for the version, the publication
time, the canonical policy set of RFX-016 as text, that text's SHA-256, and
an Ed25519 signature. The signature is over a statement that binds the
format, the version, the publication time and the hash; the hash binds the
payload. Changing any of them, or the payload, breaks it.

- The payload is **the canonical set, byte for byte** (`canonicalizePolicySet`):
  a snapshot is immutable by construction, its identity is the hash of its
  payload, and the `policySetHash` of every decision made under it is a
  function of it. A payload that is signed but not canonical is refused.
- A snapshot carries **`organization` and `environment` sources only**, every
  one trusted. A `local`, `project` or `built-in` source inside one is
  refused: a snapshot cannot speak for the user's machine or for a
  repository.
- The rules of a snapshot go through the same parser a file goes through
  (`parsePolicy`), so whatever the parser refuses in a file is refused in a
  snapshot, with the same words, and a mandatory `allow` never compiles.
- The team holds an Ed25519 key pair (`rfx policy keygen`); the private half
  signs (`rfx policy snapshot`), the public half is what every member
  subscribes with (`rfx policy subscribe <location> --key`). Key
  distribution is the team's: a file in the repository, a message, a secret
  manager. There is no certificate authority and no key server.

### 2. The subscription

A machine subscribes by recording a location and a public key in
`<REFLEX_HOME>/subscription.json`. The daemon fetches the snapshot when it
starts and on a bounded interval (`--snapshot-interval`, 5 minutes by
default, never under 30 seconds), verifies it with that key, compiles it and
applies it as the `organization` and `environment` sources ahead of the
user's own.

- **A snapshot that does not verify is refused, reported and never applied.**
  The last good one stays in force (ADR-003 §3) and is kept on disk
  (`snapshot.json`), so a daemon that starts while the location is
  unreachable starts with it. `rfx status` and `rfx doctor` show the version
  in force, the last attempt and the last error.
- A location is an `https:` URL, a `file:` URL or an absolute path. Plain
  `http:` is refused, and so is a redirect: the location is the final URL.
- **Nothing about the subscribing machine is sent to the location beyond the
  fetch itself:** one `GET`, `If-None-Match` when the server gave an ETag,
  no header REFLEX adds, no body.
- A subscribed set is subject to ADR-004 unchanged: a local or project
  policy refines the organization's defaults and cannot weaken its
  mandates; RFX-014's precedence tests run against a subscribed set.
- The hosted control plane (G16) publishes to this same format. A snapshot
  is the boundary between the open daemon and anything that manages
  policies for it.

### 3. The environment of an action

An action's environment is resolved by the daemon, once, before policy is
asked, and written into the request the decision is made on (so that the
decision record carries it):

1. **What the host said wins.** A host that sets `resource.environment` to
   anything but `unknown` is believed, and the mapping is not consulted.
2. **Else the project's mapping.** `.reflex/policy.yaml` may carry an
   `environments` mapping: for each environment, the branches and the
   remotes that mean it, as anchored patterns (RFX-100 §9). The daemon reads
   the branch from the repository's `HEAD` and the `origin` remote from its
   `config`, as `host/owner/repo`, never by running git, and takes the
   riskiest environment whose matchers hold: `production` before `staging`
   before `test` before `development` before `local`.
3. **An untrusted mapping may only raise.** A repository is untrusted until
   the user trusts it (ADR-012). Its mapping is still read, but only a claim
   to `production` or `staging` is honoured: a hostile clone can bring the
   production rules onto itself and can never take them off.
4. **Nothing else: `unknown`.** Unknown is never safe (ADR-001 §4) and is
   what an action is when nothing says otherwise.

The branch and the remote host are written into `repository` as well, where
the host left them empty, so a rule on `repository.branch` works for every
host.

### 4. What an `environment` source means

- Its rules are candidates **only for actions resolved to the environment it
  names**. Everywhere else they are not even matched, and `rfx explain`
  does not list them.
- **Its `deny` rules are floors**, whatever their `mandatory` flag says: they
  compile as mandatory. An environment policy exists to constrain that
  environment, and a deny of it that a project could silently override
  would be no constraint. A non-mandatory `ask` of it stays a default a more
  specific source may override (ADR-004 §3); `mandatory: true` makes it
  hold. An `allow` of it is a default like any other.
- The environment a source names is part of the canonical set, so two
  sources with the same rules for two environments hash differently; a set
  with no environment source hashes exactly as it did before this ADR.

## Consequences

### Positive

- "One policy for every agent" is true for a team today, with a file in a
  bucket and a key: Claude Code and Codex on every member's machine apply
  the same organization policy, and a local policy cannot weaken its
  mandates. The hosted control plane will be an optional publisher, not a
  prerequisite.
- Production rules fire. A repository can say which of its branches are
  production, and a hostile repository can only make that claim, never the
  opposite.
- Every decision made under a team policy records which one, through the
  set's hash, with no new field.

### Negative

- An environment `deny` is mandatory whether or not the author wrote it.
  That is the asymmetry the ticket asks for, and the policy reference says
  it in the environment section's first sentence.
- A team must manage a private key. Losing it means a new key and a new
  subscription on every machine; there is no rotation protocol yet.
- The mapping lives in the project. A team-wide mapping (every repository
  of an organization on `github.com/acme/*` is production on `main`) is a
  snapshot-level mapping this ADR does not define.

### Follow-ups

- RFX-083: `rfx policy keygen | snapshot | subscribe | unsubscribe`, the
  daemon's subscription holder, `rfx status`, `rfx doctor`, `rfx explain`.
- RFX-084: the `environments` mapping, the daemon's enrichment, the
  environment-source semantics.
- Later: key rotation (two keys accepted during a window), a snapshot-level
  mapping, and the hosted publisher (G16) writing this format.

## Alternatives considered

- **Fetch a policy YAML from a URL and trust TLS.** Rejected: TLS
  authenticates the server, not the policy; a compromised bucket, a cache
  or a CDN would be a silently weakened policy on every machine.
- **Sigstore keyless signing.** Rejected for now: it needs an identity
  provider and network access to verify, which a daemon that must start
  offline cannot depend on; a raw Ed25519 key verifies in microseconds with
  nothing but the key. The envelope leaves room for another algorithm.
- **Resolve the environment in the adapters.** Rejected: hosts expose a
  working directory and nothing else; the resolution is the same for every
  host and needs the project policy, which the daemon already reads, so the
  hook pays nothing for it and `rfx explain` sees the same resolution.
- **Treat every rule of an environment source as mandatory.** Rejected: a
  team that wants a production default a project may refine (an `ask`
  that a trusted repository turns into an `allow` for its own build tool)
  should be able to write one; only the deny is unconditional.
- **Let an untrusted mapping say anything, or nothing.** Rejected both
  ways: anything lets a clone dodge production; nothing leaves a fresh
  clone of a production repository with no production rules until a human
  trusts it, which is the wrong direction.

## Enforcement

- `packages/policy-engine/src/snapshot.test.ts`: a tampered payload, a
  payload re-hashed, another key, a non-canonical payload, a forbidden
  source, an untrusted flag and a mandatory allow inside a signed snapshot
  are all refused; a subscribed set holds a mandate against a local allow.
- `packages/policy-engine/src/environment.test.ts`,
  `environment-mapping.test.ts`: an environment source applies to its
  environment only, its deny is a floor, its ask is a default; an untrusted
  mapping raises and never lowers; sets without an environment source hash
  as before.
- `apps/decision-gateway/src/orchestration/subscription.test.ts`,
  `enrich.test.ts`, `git-facts.test.ts`: the last good snapshot stays on a
  bad fetch and on a restart; a changed key drops the cache; the action is
  enriched before the decision.
- `packages/cli/src/bin.e2e.test.ts`: two REFLEX homes subscribe to one
  snapshot and deny the same force-push for Claude Code and for Codex with
  the same set hash; a production branch gets the production deny; a
  tampered snapshot is refused and reported by `rfx policy subscribe` and
  `rfx doctor`.

## References

- `CLAUDE.md`: principle 6 (policy cannot silently weaken), principle 5
  (fail explicitly).
- ADR-001 §4 (environment), ADR-003 §3 (last good configuration), ADR-004
  (precedence), ADR-012 (workspace trust), ADR-016 (decision records),
  ADR-017 (positioning).
- `docs/policy-language.md` §6 and §13, `docs/cli.md`,
  `docs/decision-gateway.md`.
