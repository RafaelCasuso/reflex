# One policy for the whole team

A team writes its policy once and publishes it as a signed snapshot to a URL or a shared file. Every member's daemon fetches it, verifies the signature with the team's public key, and applies it as the organization and environment sources, ahead of each member's own policy. No account, no control plane, and nothing about a member's machine is sent beyond the fetch itself.

## 1. Make the team's key, once

```sh
rfx policy keygen --out keys
```

{{{captures.keygen.html}}}

The private key signs; keep it where the team keeps secrets, never in a repository. The public key is what every member subscribes with; a file in the repository is a fine place for it.

## 2. Write the policy

An organization policy is an ordinary policy file. Mark what must hold `mandatory`; leave what a project may refine as a default:

```yaml
version: 1
defaults:
  unresolved: ask
rules:
  - id: org-no-force-push
    name: Never force-push
    effect: deny
    mandatory: true
    conditions:
      - { field: command.name, operator: equals, value: git }
      - { field: command.args, operator: in, value: [--force, -f] }
  - id: org-ask-rm
    name: Ask before rm
    effect: ask
    conditions:
      - { field: command.name, operator: equals, value: rm }
```

A policy for an environment is another file. Its `deny` rules are floors whatever they say; they apply only to actions in that environment:

```yaml
version: 1
rules:
  - id: prod-no-migrations
    name: No database migrations from an agent in production
    effect: deny
    conditions:
      - {
          field: command.text,
          operator: matches,
          value: "prisma migrate|rails db:migrate|alembic upgrade",
        }
```

## 3. Sign it into a snapshot

```sh
rfx policy snapshot --policy organization.yaml --environment production=production.yaml --key keys/reflex-policy-key.pem --label 2026.10 --out reflex-policy.json
```

{{{captures.snapshot.html}}}

The snapshot's payload is the canonical policy set, the same form every decision hashes; the signature binds the format, the label, the publication time and that payload's hash. Publish the file where every member can fetch it: an HTTPS URL (a bucket, a static host, a raw file of a repository), or a path on a shared drive.

## 4. Subscribe, on every machine, once

```sh
rfx policy subscribe https://policies.example.com/reflex-policy.json --key keys/reflex-policy-key.pub
```

{{{captures.subscribe.html}}}

From the next decision on, the daemon fetches the snapshot when it starts and every five minutes, verifies it, and applies it. A fetch that fails, or a snapshot that does not verify with the subscribed key, leaves the last good snapshot in force and is reported by `rfx status` and `rfx doctor`; a snapshot that does not verify is never applied. The last good snapshot is kept on disk, so a daemon that starts offline starts with it.

## What a member sees

```sh
rfx explain git push --force
```

{{{captures.explain.html}}}

The member's own policy allows git; the team's mandate decides anyway, and the explanation says so, with the snapshot's version and the set's hash, which every decision made under it also carries.

## Environments

Which actions are "in production" is the project's to say. `.reflex/policy.yaml` may map branches and remotes to environments:

```yaml
version: 1
rules: []
environments:
  production:
    branches: [main, "release/.*"]
    remotes: ["github.com/acme/.*"]
  staging:
    branches: [staging]
```

The daemon reads the repository's branch and `origin` from git's own files, never by running git, and resolves the environment before deciding; a host that says the environment itself is believed. A repository you have not trusted yet may only raise its environment to staging or production, never lower it, so a hostile clone cannot dodge the production rules. The full rules are in the [policy language](./policy-language.md#13-environments).

{{{captures.explain-production.html}}}

## Taking it back

```sh
rfx policy unsubscribe
```

removes the subscription and the cached snapshot; the team's rules stop applying from the next decision.

## What is not here yet

Key rotation (a window during which two keys verify), a team-wide environment mapping inside the snapshot, and a hosted publisher. The snapshot format is the boundary a hosted control plane will publish to; a team that starts with a file in a bucket loses nothing by it.
