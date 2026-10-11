# What is stored, and for how long

Everything REFLEX keeps is on your machine, under `~/.reflex` (or `REFLEX_HOME`), in a directory only you can read. Nothing is uploaded until you turn a remote model on and consent to what it is sent, and the consent statement on the [front page](/#what-leaves-your-machine) is the exact text you are shown; or until you claim a project into an organization's control plane with `rfx claim`, which shows its own statement first and sends nothing before you agree.

## In `~/.reflex`

| What                    | Where                                | Holds                                                                                                                                                                                          | Kept                                                                            |
| ----------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Observations            | `observe/`                           | which tool ran, when, in which project, what happened to it; the shape of its arguments (keys, types, sizes), never their values                                                               | rotated at 5 MiB, the last three files kept; `rfx status` reads the recent ones |
| Decisions               | `decisions/`                         | each decision the daemon made: effect, mode, matched rules, policy set hash, latencies; no argument values                                                                                     | rotated at 5 MiB, the last three files kept                                     |
| Decision records        | `records/`                           | for actions a provider assessed: the redacted request as sent, the assessment as received, and later the human's and the host's outcome                                                        | seven days                                                                      |
| Your policy             | `policy.yaml`                        | your own rules, every project                                                                                                                                                                  | until you change it                                                             |
| Trust                   | `trust.json`                         | which project policies you trusted, by content hash                                                                                                                                            | until `rfx trust --revoke`                                                      |
| The team's subscription | `subscription.json`, `snapshot.json` | the location and the public key; the last snapshot that verified                                                                                                                               | until `rfx policy unsubscribe`                                                  |
| Provider                | `config.json`, `consent.json`        | which provider, and the consent you gave, with the digest of the statement you saw                                                                                                             | until `rfx provider`                                                            |
| Identity                | `identity.json`                      | a random local id; never sent anywhere                                                                                                                                                         | until `rfx uninstall --purge`                                                   |
| Audit                   | `audit.jsonl`                        | one line per pause, resume, mode change, provider change, trust, keygen, snapshot, subscribe, unsubscribe, claim, unclaim                                                                      | appended                                                                        |
| The claim               | `cloud.json`                         | if you claimed: the endpoint, the organization, the projects claimed here, the digest of the statement you agreed to, and this installation's upload key, which can only add its own decisions | until `rfx unclaim`                                                             |
| The outbox              | `cloud/`                             | if you claimed: the decisions of claimed projects not yet uploaded (their summary by name and their record), the cursor, the outcomes watermark                                                | until uploaded, at most 20 MiB; removed by `rfx unclaim`                        |
| Backups                 | `backups/`                           | every file `rfx init` changed, as it was                                                                                                                                                       | until `rfx uninstall --purge`                                                   |
| The redaction key       | `redaction.key`                      | the key that turns a secret into a fingerprint, so repeats are visible and values are not                                                                                                      | until `rfx uninstall --purge`                                                   |
| The daemon              | `run/`                               | its socket, state and log                                                                                                                                                                      | while it runs                                                                   |

## In the project

`.reflex/policy.yaml`, yours to edit and commit; and the host's settings file with REFLEX's hooks in it, which `rfx uninstall` removes.

## What is never stored

Tool output. Transcripts. The values of tool arguments, anywhere: the hook records their shape, the daemon redacts them before any model sees them, and the decision log holds none of them. A secret the redactor does not recognize as one would be sent to a provider as it is; the consent statement says so, and the rule is not to put secrets in commands.

## If you claim

`rfx claim <code> --endpoint <url>` links this installation and this project to an organization that runs the REFLEX control plane, keeping the same ids. After you agree to its statement, each decision made in a claimed project is uploaded, after it was answered, as a summary by name (which tool, which rules matched, what was decided, how long it took) with the decision record; what was never stored locally is never uploaded either. The organization's administrators see it, keep it for 90 days by default, and can delete it; `rfx unclaim` stops the uploads and removes the claim from this machine. Nothing above changes for a project that is not claimed.

## Deleting it

`rfx uninstall` removes the hooks and leaves your observations and backups; `rfx uninstall --purge` deletes `~/.reflex` entirely.
