# Modes

A project is in one of three modes. The daemon always computes the same canonical decision; the mode is what the hook does with it. `rfx mode` shows or changes the mode for every host installed in the project; `rfx init` starts in Observe.

## Observe

REFLEX records which tools run and what happened to them, and answers nothing to the host. It never blocks, approves or prompts. Nothing leaves the machine. It stores the shape of tool arguments (keys, types, sizes), never their values.

This is where you look at what your agent does (`rfx status`) and what the policy would have said (`rfx explain`) before letting REFLEX decide.

```sh
rfx mode observe
```

## Assist

Safe actions run without a prompt; everything uncertain goes to the human through the host's own prompt. Assist never blocks: a policy `deny` reaches the host as `ask`, with the rule's name in the prompt, and the human decides.

```sh
rfx mode assist
```

## Autopilot

The policy is enforced: `allow` runs, `ask` uses the host's prompt, `deny` stops the action before it runs. A denied action can be let through once by a human with `rfx override`.

```sh
rfx mode autopilot
```

## What a verdict becomes

| Canonical decision | Observe | Assist            | Autopilot         |
| ------------------ | ------- | ----------------- | ----------------- |
| `allow`            | nothing | runs              | runs              |
| `ask`              | nothing | the host's prompt | the host's prompt |
| `deny`             | nothing | the host's prompt | stopped           |

"The host's prompt" is the host's own permission dialog: Claude Code's permission prompt, Codex's approval. REFLEX draws no dialog of its own, so what you see is what you already know.

## Failure modes

Independent of the mode, a project has a failure mode for when REFLEX cannot decide: the daemon cannot be started or reached, a provider fails, a policy does not load.

- `fail-ask` (default): the host's prompt.
- `fail-open`: a known low-risk read runs; everything else asks.
- `fail-closed`: deny.

```sh
rfx mode autopilot --failure-mode fail-closed
```

In Observe a failure changes nothing, since nothing was going to be answered.

## A bounded pause

```sh
rfx pause --for 30m
rfx resume
```

suspends enforcement for at most a day: the hooks keep observing and answer nothing until the pause ends by itself or `rfx resume` ends it. `rfx status` shows a pause in force; the pause and its end are written to the local audit log.
