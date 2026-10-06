# What is stored, and for how long

Everything REFLEX keeps is on your machine, under `~/.reflex` (or `REFLEX_HOME`), in a directory only you can read. Nothing is uploaded until you turn a remote model on and consent to what it is sent, and the consent statement on the [front page](/#what-leaves-your-machine) is the exact text you are shown.

## In `~/.reflex`

| What                    | Where                                | Holds                                                                                                                                   | Kept                                                                            |
| ----------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Observations            | `observe/`                           | which tool ran, when, in which project, what happened to it; the shape of its arguments (keys, types, sizes), never their values        | rotated at 5 MiB, the last three files kept; `rfx status` reads the recent ones |
| Decisions               | `decisions/`                         | each decision the daemon made: effect, mode, matched rules, policy set hash, latencies; no argument values                              | rotated at 5 MiB, the last three files kept                                     |
| Decision records        | `records/`                           | for actions a provider assessed: the redacted request as sent, the assessment as received, and later the human's and the host's outcome | seven days                                                                      |
| Your policy             | `policy.yaml`                        | your own rules, every project                                                                                                           | until you change it                                                             |
| Trust                   | `trust.json`                         | which project policies you trusted, by content hash                                                                                     | until `rfx trust --revoke`                                                      |
| The team's subscription | `subscription.json`, `snapshot.json` | the location and the public key; the last snapshot that verified                                                                        | until `rfx policy unsubscribe`                                                  |
| Provider                | `config.json`, `consent.json`        | which provider, and the consent you gave, with the digest of the statement you saw                                                      | until `rfx provider`                                                            |
| Identity                | `identity.json`                      | a random local id; never sent anywhere                                                                                                  | until `rfx uninstall --purge`                                                   |
| Audit                   | `audit.jsonl`                        | one line per pause, resume, mode change, provider change, trust, keygen, snapshot, subscribe, unsubscribe                               | appended                                                                        |
| Backups                 | `backups/`                           | every file `rfx init` changed, as it was                                                                                                | until `rfx uninstall --purge`                                                   |
| The redaction key       | `redaction.key`                      | the key that turns a secret into a fingerprint, so repeats are visible and values are not                                               | until `rfx uninstall --purge`                                                   |
| The daemon              | `run/`                               | its socket, state and log                                                                                                               | while it runs                                                                   |

## In the project

`.reflex/policy.yaml`, yours to edit and commit; and the host's settings file with REFLEX's hooks in it, which `rfx uninstall` removes.

## What is never stored

Tool output. Transcripts. The values of tool arguments, anywhere: the hook records their shape, the daemon redacts them before any model sees them, and the decision log holds none of them. A secret the redactor does not recognize as one would be sent to a provider as it is; the consent statement says so, and the rule is not to put secrets in commands.

## Deleting it

`rfx uninstall` removes the hooks and leaves your observations and backups; `rfx uninstall --purge` deletes `~/.reflex` entirely.
