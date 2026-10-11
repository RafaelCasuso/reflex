# ADR-019: Control plane persistence, tenancy, claim and ingest

- **Status:** Accepted
- **Date:** 2026-10-10
- **Tickets:** RFX-059, RFX-060, RFX-061, RFX-062, RFX-078, RFX-085, RFX-121,
  RFX-122
- **Supersedes:** none

## Context

Until G9.5 nothing REFLEX records has ever left the user's machine except
the redacted request a consented remote provider is given (ADR-006,
RFX-123). ADR-008 decided where decision telemetry goes once it does
(PostgreSQL, append-only, partitioned by month, until a named measurement
says otherwise), what is never stored, and how long each class is kept. It
did not decide who a stored row belongs to, how the control plane knows who
is sending, how a machine that was anonymous becomes someone's, or what
leaves the machine beyond the provider request. G10 needs all four before
its first row is written, and `CLAUDE.md` names tenant isolation, auth and
redaction as security-sensitive code.

Three facts shape the answer:

1. **The ids already exist.** Since G1.5 every installation has an anonymous
   `agt_` identity and every project a `prj_` identity, kept apart from the
   install registry so that they survive `rfx uninstall` (RFX-058). RFX-061
   asks that a claim link them "without losing history": the ids must not
   change when a machine is claimed.
2. **The decision never waits for the network** (ADR-010). Whatever is
   uploaded is uploaded after the answer, from a local buffer, and ADR-008
   §2 already names that buffer: the local journal, shipped at least once,
   in order, asynchronously.
3. **Application-level tenant checks fail open** when one query forgets its
   filter (RFX-122). The database has to refuse a cross-tenant row on its
   own.

## Decision

Accepted by the maintainer on 2026-10-10, as implemented.

### 1. Tenancy: the organization owns everything, and local ids are kept

An **organization** (`org_`) owns projects (`prj_`), agents (`agt_`, one per
installation), API keys (`key_`), claim codes, policy versions, decisions,
decision records, outcomes, feedback and its audit log. Every row of every
one of those tables carries `organization_id`, not null.

A claim **keeps the local ids**: the control plane's project id is the
`prj_` the machine already had and the agent id is its `agt_`. The ids were
random and opaque from the start (RFX-058), so they identify nothing but
the installation and the project, and keeping them is what links the local
history to the account. Two organizations can never claim the same project
id, and an installation belongs to one organization at a time.

### 2. Authentication: hashed, scoped, revocable keys

The control plane authenticates a request by an **API key** of the form
`rfk_<key id>_<secret>`. The key id (`key_` + 16 hex) is stored; the secret
is stored only as its SHA-256, and a presented key is verified by hashing
it and comparing in constant time. A key has one of three scopes:

- `ingest`: write the decisions, outcomes and feedback of the key's own
  agent, in the projects that agent has claimed; read nothing;
- `read`: the organization's timeline;
- `admin`: keys, claim codes, retention, deletion.

A key is revoked by setting `revoked_at`; a revoked key is refused on the
next request and never deleted, so that the audit log keeps naming it. The
`ingest` key an installation holds is **the only credential REFLEX ever
writes to a user's disk**, in `<REFLEX_HOME>/cloud.json`, mode `0600`, and
it can do nothing but upload that installation's own decisions.

A **claim code** is what an organization's admin hands to a developer:
`RFX-XXXX-XXXX-XXXX`, stored hashed, single use, expiring (24 hours by
default), bound to the organization that minted it. Resolving a code is the
one path that starts without a tenant, so it runs inside a `SECURITY
DEFINER` function that resolves the organization and links the project in
one transaction; the application role can call it and cannot read the table
it reads.

### 3. The claim (RFX-061): consent first, then one request

`rfx claim <code> --endpoint <url>` shows the **cloud consent statement**
(what will be uploaded, what is redacted first, where it goes, for how long,
and that declining changes nothing), and sends nothing until the user
agrees. Then one `POST /v1/claims` carries the code, the local agent id and
its creation time, the local project id and a name for it, and the hosts
installed in that project. The answer is the organization, the project id
(the same one), an `ingest` key and the claim time, and the CLI writes
`cloud.json`.

- The statement is versioned by its digest, like the provider's (RFX-123):
  when the statement changes, the earlier consent covers nothing, nothing
  is uploaded, and `rfx status` and `rfx doctor` say so.
- A second project on the same machine is claimed with another code of the
  same organization; a code of another organization is refused until
  `rfx unclaim`.
- A claim also enqueues what this version already recorded locally for that
  project, so that the account starts with the history the machine has; the
  statement says how many decisions that is.
- `rfx unclaim` deletes `cloud.json` and the outbox. What was uploaded stays
  until the organization deletes it (§7); the CLI says so.

### 4. The outbox and the uploader (RFX-060): off the path, at least once

The daemon writes nothing for the cloud unless `cloud.json` exists and its
consent covers the current statement. When it does, **after** every decision
of a claimed project, off the decision path, it appends one entry to
`<REFLEX_HOME>/cloud/outbox.jsonl`: the **decision summary** (the ids, the
host and tool names, the operation, the side-effect class, the environment,
the branch and remote host, the effect, the mode, the risk, the reason
codes, the matched rule ids, the policy set hash, the latencies; by name,
never the arguments, never a path, never the working directory) and the
**decision record** of ADR-016 §4 (the redacted request when a provider was
given one, the evaluations, the labels).

An uploader in the daemon ships the outbox in batches, in order, at a
bounded interval, with the `ingest` key: on success the cursor moves past
the batch; on a refused key it stops and reports (`rfx status`, `rfx
doctor`); on anything else it backs off and retries, and a decision rejected
by the server is dropped and counted, never retried. The outbox is bounded
in size: when it is full, the oldest unsent entries are dropped and counted.
Outcomes (ADR-013) of claimed projects go the same way, from the local
observation log, keyed by action id so that a resend is harmless.

The server does not trust the first redaction. Every record's request goes
through the **second redaction pass** (ADR-006) with the control plane's
own key before it is stored, and a hit there is counted as a defect of the
first pass. What is stored carries no raw argument value, which the gate's
dump test holds end to end.

### 5. Tenant isolation in the database (RFX-122)

Every organization-scoped table has **row-level security enabled and
forced**, with one policy: a row is visible, insertable and updatable only
when its `organization_id` equals the transaction's `reflex.organization_id`
setting. The application connects as a role that owns nothing, cannot bypass
RLS and holds only the privileges each table needs (`audit_log`: insert and
select, never update or delete). A query issued without a tenant setting
sees no rows and writes none, whatever its `WHERE` clause says.

The only cross-tenant reads are two `SECURITY DEFINER` functions, claim
resolution (§2) and key authentication (key id to organization, scope and
secret hash), each returning one row and nothing else. Migrations run as the
owner role, which the application never uses.

### 6. The audit log (RFX-085): same transaction, append-only

Policy, mode, membership and security changes on the control plane are
written to `audit_log` **in the same transaction** as the change they record
(ADR-008 §2): a claim, a key issued or revoked, a retention changed, a
retention run, a deletion, a policy version published. The table refuses
`UPDATE` and `DELETE` by trigger, the application role has no privilege to
do either, and an entry never contains the content it is about: a deletion
entry carries counts, never a decision.

### 7. Retention and deletion (RFX-121)

Per organization: decision metadata 90 days (may be lengthened), redacted
requests 30 days and **off until the organization consents** (a record's
request is dropped before it is stored until then), outcomes 90 days, the
audit log one year (may be lengthened). A scheduled job deletes what has
expired, per class, and writes one audit entry per organization with the
counts. A deletion request removes an organization's or a project's
decisions, records, outcomes and feedback at once, and leaves an audit entry
that names the subject and the counts and nothing else.

### 8. The timeline (RFX-062)

`GET /v1/decisions` returns one organization's decision summaries, newest
first, by keyset cursor, filtered by project, agent, effect, tool, a risk
range and a time range; `GET /v1/decisions/<id>` adds the record while it
is retained. Both need a `read` or `admin` key and see one organization.

### 9. What is open and what is private

The contracts of the claim and the ingest (v1.6: the summary, the entry,
the request and the result shapes), the outbox, the uploader, the consent
statement and `rfx claim` are **open** (ADR-015: everything that runs on the
user's machine). The schema, the migrations, the key store, the audit log,
the ingest endpoint, the timeline and the retention job are **private**, in
`apps/api` and `packages/auth` of `reflex-cloud`, which consume the open
packages by published version (RFX-149).

## Consequences

### Positive

- A claimed machine uploads only after a yes to a statement that says what,
  where and for how long, and a changed statement withdraws the yes.
- One credential on disk, scoped to upload and nothing else, hashed at rest,
  revocable without touching the machine.
- A forgotten filter cannot leak a tenant's rows: the database refuses them.
- The decision path is unchanged: the outbox is written after the answer and
  the network is never waited for (ADR-010).

### Negative

- Row-level security costs a `SET LOCAL` per transaction and a policy check
  per row; the benchmark of ADR-008 measures it with the rest.
- An installation belongs to one organization; a contractor with two
  clients claims one and unclaims before the other.
- Monthly partitions, a second redaction key and a retention job are three
  pieces of operations the control plane did not have.
- The outbox is one more bounded file under `~/.reflex` that can fill a
  disk slowly while a key is revoked; the count is in `rfx status`.

### Follow-ups

- RFX-059, RFX-122: schema, RLS, the isolation and migration tests.
- RFX-078, RFX-085: keys and the audit log.
- RFX-060, RFX-061, RFX-062, RFX-121: the outbox, the uploader, the claim,
  the ingest, the timeline, retention and deletion, the benchmark.
- Later: key rotation without a new claim; organization-wide retention
  consent in the dashboard (G11); members and roles (G16).

## Alternatives considered

- **New ids on claim, mapped to the local ones.** Rejected: a mapping table
  is one more place to get tenancy wrong, and nothing is gained; the local
  ids were opaque from the first day.
- **A long-lived account token on the machine.** Rejected: a token that can
  read the timeline or mint keys on a developer's laptop is the credential
  an attacker on that laptop wants. The `ingest` scope can only add that
  machine's own decisions.
- **Upload synchronously from the hook.** Rejected by ADR-010 and ADR-008
  §2: a network call on the decision path.
- **Trust the first redaction.** Rejected by ADR-006, which names the second
  pass; the gate's exit is a dump with no fixture secret in it.
- **Application-level tenant filters only.** Rejected by RFX-122: they fail
  open on the first forgotten `WHERE`.
- **ClickHouse for decisions from the start.** Rejected by ADR-008 and
  `CLAUDE.md`; the triggers are measured by the benchmark instead.

## Enforcement

- `packages/contracts/src/cloud.test.ts`: an ingest entry carrying
  `arguments`, a working directory or a path is refused; a claim result
  with an unknown field is read, a request with one is refused.
- `packages/telemetry/src/cloud-outbox.test.ts`, `cloud-summary.test.ts`:
  the outbox is in order, bounded, survives a partial line and a restart;
  a summary carries no argument value for any canary.
- `apps/decision-gateway/src/orchestration/cloud.test.ts`: nothing is
  written without a covering consent; the uploader moves the cursor only
  on success, stops on a refused key, backs off on failure, never retries
  what the server rejected.
- `packages/cli/src/bin.e2e.test.ts`: `rfx claim` against a fake control
  plane sends nothing before the yes, keeps the local ids, enqueues the
  local history, and the daemon uploads a decision the hook made.
- `reflex-cloud`: `packages/auth` (a key verifies only against its own hash,
  a revoked key is refused), `apps/api` (every repository function fails to
  read or write another organization's rows; a query with no tenant returns
  none; every migration reverses cleanly; a dump of a seeded database holds
  no canary; the audit log refuses update and delete; retention removes
  exactly the expired rows; deletion leaves an audit entry with counts).

## References

- `CLAUDE.md`: principles 1, 5, 7 and "Monorepo rules".
- ADR-006 (second pass), ADR-008 (persistence and retention), ADR-010
  (placement), ADR-013 (outcomes), ADR-015 (open core), ADR-016 §4
  (records), ADR-018 (snapshots, the control plane as a publisher).
- `docs/architecture.md` §9, §10, §13; `docs/security.md`.
