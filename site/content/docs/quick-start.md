# Quick start

From nothing to a policy you can read, in one project, with no account. Every command on this page is run by a test in the repository that builds this site, against the built `rfx`, in a temporary project.

## 1. Install

```sh
npm install -g @reflex-control/cli
```

Node.js 24 or later. The package and every package it depends on are published from the repository's release workflow with provenance; `npm audit signatures` verifies them.

## 2. Install into a project

In the project you want governed:

```sh
rfx init --dry-run
```

shows the plan and changes nothing: which hosts were detected, which settings file gets REFLEX's hooks, where the backup goes. Then, for real:

```sh
rfx init --yes --host claude-code
```

(`--host` is optional; without it REFLEX installs for every host it detects, after showing each plan.) It backs up every file it changes, adds its hooks, writes a conservative starter policy to `.reflex/policy.yaml` if the project has none and trusts it as written, and starts in Observe: the hooks record what the agent does and answer nothing to the host.

## 3. Look

Use your agent for a while, then:

```sh
rfx status
```

shows what REFLEX observed in this project (how many actions, how many prompted, how many the host blocked), each host's hook health, the daemon, the provider, the policy and whether it is trusted.

## 4. Ask why

```sh
rfx explain git push --force
rfx explain --tool Write --path src/index.ts
```

answers from the same evaluation the daemon runs, offline: the action's class, every rule that matched with its source and precedence, which one decides, the effect, and what each mode would do with it. The starter policy denies nothing by itself; it asks about what is destructive, external or a credential, and allows reads and the usual build commands.

## 5. Write a rule

`.reflex/policy.yaml` is yours to edit and commit. A rule is an effect and conditions:

```yaml
version: 1
defaults:
  unresolved: ask
rules:
  - id: allow-tests
    name: The test runner is fine here
    effect: allow
    conditions:
      - { field: command.name, operator: in, value: [pnpm, npm] }
      - { field: command.args, operator: in, value: [test, lint, typecheck] }
  - id: never-force-push
    name: Never force-push
    effect: deny
    mandatory: true
    conditions:
      - { field: command.name, operator: equals, value: git }
      - { field: command.args, operator: in, value: [--force, -f] }
```

The [policy language](./policy-language.md) has every field and operator, each with an example that is executed. A changed project policy is untrusted again until you look at it:

```sh
rfx trust --yes
```

prints what the policy would allow and trusts that version; until then its deny and ask rules apply and its allow rules do not, so a repository you clone can only make REFLEX stricter.

## 6. Let it decide

```sh
rfx mode assist
```

allows what the policy allows and hands everything uncertain to the host's own prompt; it never blocks. When the policy reads right:

```sh
rfx mode autopilot
```

enforces allow, ask and deny. A denied action can be let through once, by a human, with `rfx override <decision id>`; the id is in the message the host shows. `rfx mode observe` goes back.

## 7. When in doubt

```sh
rfx doctor
```

checks everything and names what to do about each failure. `rfx pause --for 30m` suspends enforcement for a bounded time while REFLEX keeps observing; `rfx resume` ends it early. `rfx uninstall --yes` removes the hooks.

Next: [how a decision is made](./decisions.md), and [one policy for the whole team](./team-policy.md).
