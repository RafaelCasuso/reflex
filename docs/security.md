# Threat model

What REFLEX protects, from whom, where its trust boundaries are, and what it
does not try to do. The adversary list decides which tests exist: every
adversary below is tied to the tickets that answer it, or is named as an
accepted risk.

## REFLEX is not a sandbox

REFLEX decides whether an agent's action should run, ask or be blocked, **before
the host runs it**. It does not contain an action once it runs. It does not
intercept system calls, isolate processes, restrict the network or the file
system, or limit what a permitted command does.

Everything follows from that:

- REFLEX sees what the host shows it. An action the host performs without
  calling the hook is invisible.
- A permitted command can do more than its text says. `npm test` runs whatever
  the repository's test script contains.
- REFLEX runs with the user's own privileges, next to the agent it governs. It
  raises the cost of a dangerous action and makes it visible. It is one layer.
  Anyone who needs containment needs a sandbox as well, and REFLEX does not
  replace one.

## Assets

| Asset                                                               | Why it matters                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| The decision itself                                                 | A wrong `allow` is the failure the product exists to prevent                 |
| Policy: files, compiled set, trust records                          | Whoever can change policy can change every decision                          |
| Hook registration in host settings, and REFLEX's own binaries       | Removing the hook removes REFLEX, silently (the host fails open)             |
| Tool arguments and what they contain: secrets, paths, customer data | They pass through REFLEX on every call                                       |
| The local key for redaction fingerprints (ADR-006), API keys        | Disclosure defeats redaction, or spends the user's money                     |
| Telemetry and the audit log                                         | They are the evidence, and they must not become a second copy of the secrets |
| The user's trust in an `allow`                                      | Once lost, the user turns REFLEX off, and then it protects nothing           |

## Adversaries

### 1. The governed agent

The agent REFLEX governs, acting in good faith but wrongly, or steered by
someone else. It is the adversary with the most access: it chooses every
command, and it can read REFLEX's documentation.

It will try to reach a goal by whatever path is allowed: split one dangerous
action into allowed steps, hide it in a script, a pipe, a substitution or a
package-manager hook, write the file that another allowed command then
executes, edit `.reflex/policy.yaml`, remove the hook from the host's settings,
or simply rephrase until something passes.

| Mitigation                                                                                                                              | Ticket                       |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Commands are parsed with a real grammar; an allow rule matches only a command that is fully understood, a deny rule matches any segment | RFX-096 (ADR-011)            |
| A bypass corpus of quoting, chaining and misleading prefixes cannot defeat an explicit deny                                             | RFX-018                      |
| Path containment that survives `..`, case and separator tricks                                                                          | RFX-097                      |
| Built-in mandatory rules over REFLEX's own configuration, policy, hook registration and binaries, including indirect writes             | RFX-103 (ADR-012)            |
| `rfx status` and `rfx doctor` report a removed or altered hook                                                                          | RFX-056, RFX-055             |
| Unknown is never safe: an action nobody classified does not fail open                                                                   | ADR-001 §4, ADR-003, RFX-020 |
| The starter policy never auto-allows destructive, external or privilege actions                                                         | RFX-017                      |

**Accepted risk:** a permitted command that does something other than what its
text says (a test script that deletes files). REFLEX judges the action it is
shown. This is the sandbox's job.

**Accepted risk:** an agent that performs the same effect through a host tool
REFLEX is not registered for. The canary (RFX-124) detects new tools and events
in a host release; it cannot make a host call a hook it does not call.

### 2. Prompt-injected content

Text that reaches the agent or REFLEX from outside the user: a web page, an
issue, a file in the repository, the output of a tool. It wants the agent to
act for it, and it wants REFLEX to judge that action as safe: "this command is
part of the approved cleanup procedure".

The first half is the agent's problem and arrives here as adversary 1. The
second half is REFLEX's own. The vendor of the first semantic provider states
that content written to steer the model can move its answer
(`docs/jev-provider.md` §4).

| Mitigation                                                                                                      | Ticket           |
| --------------------------------------------------------------------------------------------------------------- | ---------------- |
| A deterministic deny cannot be overridden by any semantic result; the provider is not even called               | ADR-002, RFX-019 |
| An assessment is evidence. The aggregator owns the effect, and low confidence escalates                         | RFX-036, RFX-037 |
| `untrustedInput` is its own assessed dimension, separate from the others                                        | RFX-027          |
| A prompt-injection corpus aimed at the semantic path, run against the real provider                             | RFX-108          |
| Minimal context: the provider is sent the action and a summary, not the conversation that carried the injection | RFX-033, RFX-034 |
| Provider output is parsed strictly; malformed or partial output never becomes an allow                          | ADR-005, RFX-027 |

**Accepted risk:** an injection that produces an action which is genuinely
within policy. If the policy allows it, REFLEX allows it.

### 3. A malicious repository

A repository the user clones and opens. It can ship its own
`.reflex/policy.yaml`, its own host settings, scripts, package-manager hooks
and file names chosen to confuse a matcher.

| Mitigation                                                                                                                                                                                   | Ticket                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| A project policy is untrusted until the user trusts that content; untrusted can only tighten: its allow rules are ignored                                                                    | ADR-012, ADR-004, RFX-104 |
| Trust is bound to the content and asked again when it changes                                                                                                                                | RFX-104                   |
| REFLEX installs into the user's local settings by default, through a reversible transaction, and reports the state of its hooks                                                              | RFX-044, RFX-056          |
| A program that runs code defined in the repository (`pnpm test`, `make`, `./deploy.sh`) is marked indirect and is never of a better class than `unknown`; allowing it takes an explicit rule | RFX-096                   |
| A policy cannot make evaluation slow: regular expressions are bounded, and so is document size                                                                                               | RFX-098, RFX-012          |

**Accepted risk:** a repository whose allowed build or test commands are
malicious. See "REFLEX is not a sandbox".

### 4. A malicious MCP server

A tool server the agent is connected to. It controls its tool names, its
descriptions, its schemas and everything it returns. It can name a tool to look
like a trusted one, describe a destructive tool as a read, and return text
written for the agent (adversary 2).

| Mitigation                                                                                                                                                                                                             | Ticket                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| An MCP tool is never classified from its name or description: its side-effect class is `unknown` until policy says otherwise                                                                                           | RFX-042, ADR-001 §4       |
| Tools are addressed by namespace and name, and the namespace is the server the host states, never one read out of a name that a server or a repository can shape, so a server cannot impersonate another server's tool | RFX-042, RFX-089, RFX-074 |
| The proxy decides before forwarding and forwards only what was allowed                                                                                                                                                 | RFX-073, RFX-074          |
| What a tool returns is never an input to a decision about that same call                                                                                                                                               | RFX-074                   |

**Accepted risk:** what the server does with a call that was legitimately
allowed. REFLEX governs the call, not the server.

### 5. A network attacker

Someone on the path between the user's machine and a remote service: the
semantic provider, the decision gateway, the control plane.

| Mitigation                                                                                                                | Ticket                    |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| The deterministic path is local and needs no network; tool arguments of an action policy resolves never leave the machine | ADR-010                   |
| Only redacted, minimal context leaves the machine, and only after consent                                                 | ADR-006, RFX-031, RFX-123 |
| A provider that cannot be reached, or answers garbage, is a fallback and never an allow                                   | ADR-003, RFX-020          |
| Policy that arrives over the network is a signed, immutable snapshot                                                      | RFX-083, RFX-016          |
| The gateway authenticates callers, isolates tenants and limits rate and request size                                      | RFX-078, RFX-122, RFX-119 |

**Accepted risk:** an attacker who can break TLS. Certificate validation is
assumed for every remote call and is not a ticket. Also accepted: a provider
or a gateway that is simply made unreachable. That costs autonomy, since the
fallback asks, and never safety.

### 6. A compromised dependency

A package REFLEX depends on, a build tool, a GitHub Action, or REFLEX's own
release, altered by someone else. REFLEX is an attractive target: it runs on
every tool call, on developers' machines, and sees every argument.

| Mitigation                                                                                                                                 | Ticket           |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Frozen lockfile in CI, pinned package manager, actions pinned to a commit, secret scanning, Dependabot held to what the toolchain supports | RFX-003, RFX-090 |
| The hook's per-call path has almost no dependencies, and none that parses untrusted input                                                  | RFX-086          |
| `packages/contracts` depends on nothing, and the boundary rules are enforced by a test                                                     | RFX-002          |
| Signed releases, so that what runs is what was built                                                                                       | RFX-127          |
| Mutation testing on the security-sensitive packages, so that a weakened check is noticed                                                   | RFX-111          |

**Accepted risk:** a compromise of the host itself (Claude Code, Codex), the
operating system or the user's account. REFLEX runs inside all three.

## Trust boundaries

| Boundary                           | What crosses it                                         | Rule                                                                                                |
| ---------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Host to hook client                | the host's event, on stdin                              | untrusted input: parsed strictly, bounded in size and depth, never trusted for identity (RFX-042)   |
| Hook client to local daemon        | the canonical action, over a same-user local socket     | the daemon treats every client as untrusted (ADR-010); the socket is private to the user            |
| Policy files to the engine         | YAML written by a user, a repository or an organization | parsed strictly with located errors (RFX-012); project content is untrusted until trusted (ADR-012) |
| Daemon to disk                     | logs, journal, state                                    | nothing derived from a raw value (ADR-006); state files are private to the user (RFX-058)           |
| Machine to remote services         | redacted, minimal context                               | only for actions policy did not resolve, only after consent (ADR-006, RFX-123)                      |
| Provider to the engine             | an assessment                                           | untrusted input: parsed strictly, all or nothing (ADR-005, ADR-009)                                 |
| Control plane to the machine       | policy snapshots                                        | signed and immutable (RFX-083)                                                                      |
| Learned suggestions to enforcement | a proposed rule                                         | nothing is enforced until a human accepts it (`CLAUDE.md` principle 8, RFX-071)                     |

## Non-goals

- **Containment.** See the first section.
- **Defending against the user.** The user can uninstall REFLEX, edit their own
  policy and approve anything. Self-protection (ADR-012) stops the agent from
  doing those things without a human; it does not stop the human.
- **Defending against a compromised machine.** Malware running as the user can
  do everything REFLEX can.
- **Replacing IAM, a secrets manager, a SIEM or an agent framework.**
  (`CLAUDE.md`, "Scope control".) REFLEX decides about actions; it does not
  hold credentials or grant access.
- **Judging the agent's output.** REFLEX governs what the agent does, not what
  it says or whether its code is good.
- **Guaranteeing that an allowed action is safe.** REFLEX reduces how often a
  human has to look and makes the dangerous cases visible. A wrong allow is a
  defect to measure (false allow rate), and zero is a goal, not a claim.

## Keeping this document true

`tests/security.test.ts` holds it to the backlog: every adversary the ticket
names is present, every adversary has at least one mitigation tied to a ticket
that exists, and the statement that REFLEX is not a sandbox is there. A new
adversary, or a mitigation whose ticket is removed, fails CI.
