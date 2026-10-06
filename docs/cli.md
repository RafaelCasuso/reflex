# The `rfx` command line

Every command, what it reads and writes, and what it never does. Everything
here runs on the user's machine; nothing leaves it without the consent of
`rfx provider` (RFX-123). Commands marked **human** are on REFLEX's own rule
(`reflex.protect-own-command`, ADR-012): an agent that runs them through a
tool is stopped by a mandatory ask first.

| Command                                                                                                                      | What it does                                                                                                                                                                                          | Writes                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `rfx init [--host] [--scope] [--mode] [--failure-mode] [--yes] [--dry-run]` **human**                                        | Detects Claude Code and Codex, shows one plan per host, installs the hook, writes the starter `.reflex/policy.yaml` when the project has none and trusts it as written (RFX-054, RFX-104)             | the host's hooks file, Codex's `features.hooks`, `.reflex/policy.yaml`, the registry, the trust record, a backup of every file it changes |
| `rfx mode [observe                                                                                                           | assist                                                                                                                                                                                                | autopilot] [--failure-mode]` **human**                                                                                                    | The project's mode, for every host installed in it (ADR-002, ADR-003)                                                                                                                                         | the registry                  |
| `rfx provider [none                                                                                                          | jev                                                                                                                                                                                                   | local] [--model] [--endpoint] [--consent]` **human**                                                                                      | What assesses the actions policy leaves open; a remote provider shows what leaves the machine and asks for consent                                                                                            | `config.json`, `consent.json` |
| `rfx explain <command...>`, `rfx explain --tool Read                                                                         | Write                                                                                                                                                                                                 | Edit --path <file>`                                                                                                                       | Why an action would be allowed, asked or denied here: the matched rules with their source and precedence, the deciding one, the effect per mode, from the same evaluation the daemon makes, offline (RFX-099) | nothing                       |
| `rfx trust [--yes] [--revoke]` **human**                                                                                     | Shows what the project's `.reflex/policy.yaml` would allow and trusts that content; a changed file asks again (RFX-104, ADR-012)                                                                      | the trust record, the audit line                                                                                                          |
| `rfx policy starter [--force]`                                                                                               | Writes the conservative starter policy; never over an existing file without `--force`, which keeps a copy (RFX-054)                                                                                   | `.reflex/policy.yaml`, the trust record                                                                                                   |
| `rfx policy keygen [--out <dir>]`                                                                                            | Creates the team's Ed25519 signing pair: the private key mode `0600` under `~/.reflex/keys` unless `--out`, the public key beside it; never overwrites (RFX-083, ADR-018)                             | `reflex-policy-key.pem`, `reflex-policy-key.pub`, the audit line                                                                          |
| `rfx policy snapshot --policy <org.yaml> [--environment <env>=<file>]... --key <private.pem> --label <version> --out <file>` | Compiles the organization's policy and one policy per environment into the canonical set, signs it, writes the snapshot to publish (RFX-083)                                                          | the snapshot file, the audit line                                                                                                         |
| `rfx policy subscribe <https URL \| file> --key <public.pem>` **human**                                                      | Records the location and the key, fetches and verifies once, stops the daemon so the next one applies it; exit 1 when the snapshot there could not be applied yet (RFX-083)                           | `subscription.json`, `snapshot.json`, the audit line                                                                                      |
| `rfx policy unsubscribe` **human**                                                                                           | Removes the subscription and the cached snapshot; the team's rules stop applying from the next decision                                                                                               | removes `subscription.json` and `snapshot.json`, the audit line                                                                           |
| `rfx pause --for <30m                                                                                                        | 2h                                                                                                                                                                                                    | 1d> [--reason]`, `rfx resume` **human**                                                                                                   | Suspends enforcement for a bounded time, at most a day: the hooks keep observing and answer nothing; `status` shows it; it ends by itself (RFX-126)                                                           | `pause.json`, the audit line  |
| `rfx override <decisionId>` **human**                                                                                        | Lets one denied action through, once (RFX-125)                                                                                                                                                        | the daemon's memory, telemetry                                                                                                            |
| `rfx doctor [--json]`                                                                                                        | Checks the install, the hooks and the host's own switches, the daemon, the policies and their trust, the provider and its consent; every failure names a remediation; exit 1 on any failure (RFX-055) | nothing                                                                                                                                   |
| `rfx status`                                                                                                                 | What REFLEX observed and decided in this project; the daemon, the provider, the project policy's trust, a pause                                                                                       | nothing                                                                                                                                   |
| `rfx uninstall [--yes] [--purge]` **human**                                                                                  | Removes the hooks (byte for byte when unchanged, surgically otherwise), keeps a file another project still uses, stops the daemon; `--purge` deletes the REFLEX home                                  | the hooks files, the registry                                                                                                             |

## Where things live

Under the REFLEX home (`~/.reflex`, or `REFLEX_HOME`), mode `0700`:
`installs.json` (the registry), `identity.json`, `policy.yaml` (the user's
own policy, every project), `config.json` and `consent.json` (provider),
`trust.json` (which project policies the user trusted, by content hash),
`subscription.json` (the team policy's location and public key) and
`snapshot.json` (the last snapshot that verified, so a daemon that starts
offline starts with it), `keys/` (a team's signing pair, if made here),
`pause.json` (while paused), `audit.jsonl` (pause, resume, trust, mode,
provider, starter, keygen, snapshot, subscribe and unsubscribe events: the
local seed of RFX-085), `observe/`, `decisions/`, `records/`, `backups/`,
`run/` (the daemon's socket, state and log).

In the project: `.reflex/policy.yaml`, the project's policy, yours to edit
and commit. It is the `project` source of ADR-004: it refines the user's
policy and cannot weaken a mandatory rule. Until you trust it, its deny and
ask rules apply and its allow rules do not, so a repository you clone can
only make REFLEX stricter (ADR-012). `rfx status`, `rfx doctor` and
`rfx explain` all say whether it is trusted.

## The policy a decision uses

For every action the daemon composes the set from the team's snapshot
(`organization` and `environment` sources, when subscribed), the user's
`policy.yaml`, the project's `.reflex/policy.yaml` found upward from the
action's working directory (never above your home directory), under the
trust recorded for its content, and REFLEX's own rules; `rfx explain`
composes it the same way and runs the same evaluator
(`packages/policy-engine`), so what it prints is what the daemon would do,
except for what a semantic provider would say about an unresolved action,
which `explain` does not know and says so. Before deciding, the daemon
resolves the action's environment from what the host said or from the
project's `environments` mapping and the repository's branch and remote
(`docs/policy-language.md` §13); `rfx explain` prints that resolution too.

## A team's policy, without an account

One person on the team runs `rfx policy keygen` once, keeps the private key
where the team keeps secrets, and publishes a snapshot whenever the policy
changes: `rfx policy snapshot --policy org.yaml --environment production=prod.yaml --key reflex-policy-key.pem --label 2026.10 --out reflex-policy.json`,
then puts the file where every member can fetch it: an HTTPS URL, a shared
file. Every member runs `rfx policy subscribe <location> --key reflex-policy-key.pub`
once. From then on each daemon applies the team's rules to Claude Code and to
Codex alike, a local or project policy cannot weaken a mandatory one, and a
snapshot that does not verify with that key is refused and reported, never
applied (ADR-018).

## Exit codes

`0` done or nothing to do; `1` a failure the output names; `2` the command
line was wrong. The hook (`rfx hook <host>`) always exits `0`
(`docs/claude-code-hook.md` §2, `docs/codex-hook.md` §2).
