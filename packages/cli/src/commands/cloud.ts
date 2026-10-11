import { basename, join } from "node:path";

import {
  CLAIM_CODE_FORM,
  parseClaimResult,
  type AgentId,
  type ClaimRequest,
  type ClaimResult,
  type DecisionRecord,
  type DecisionSummary,
  type HostKind,
  type ProjectId,
} from "@reflex-control/contracts";
import {
  classifyEndpoint,
  cloudConsentCovers,
  cloudConsentDigest,
  cloudConsentStatement,
  cloudPath,
  parseCloudRecord,
  serializeCloud,
  type ClaimedProject,
  type CloudRecord,
  type CloudState,
} from "@reflex-control/decision-gateway/cloud.js";
import {
  CloudOutbox,
  DecisionLog,
  DecisionRecordLog,
  decisionEntryOf,
  defaultDecisionLogDirectory,
  defaultDecisionRecordDirectory,
  defaultOutboxDirectory,
  OUTBOX_CURSOR_FILE,
  OUTBOX_FILE,
  summaryFromEvent,
} from "@reflex-control/telemetry";

import type { FileSystemPort } from "../backups/file-system.js";
import { stopDaemon } from "../daemon/lifecycle.js";
import {
  parseIdentity,
  parseRegistry,
  reflexHome,
  statePaths,
  STATE_FILE_MODE,
  type Environment,
} from "../state.js";
import { appendAudit } from "./pause-command.js";

/**
 * RFX-061 — `rfx claim` and `rfx unclaim` (ADR-019 §3).
 *
 * A claim links this installation's anonymous identity and this project's
 * local identity to an organization, keeping both ids. It shows the cloud
 * consent statement first and sends nothing before the yes; then one
 * request to the control plane with the claim code, and `cloud.json` with
 * the `ingest` key it answers with. The daemon is stopped so that the next
 * one starts uploading, and what this version already recorded locally for
 * the project goes into the outbox, so that the account starts with the
 * history the machine has.
 */
export { cloudConsentStatement };

const RECENT_EVENTS = 5_000;
const CLAIM_TIMEOUT_MS = 15_000;

export interface CloudReport {
  readonly record: CloudRecord | undefined;
  /** False when the statement changed since the yes: nothing is uploaded. */
  readonly consentCurrent: boolean;
  /** The claim that covers the current project, if any. */
  readonly thisProject: ClaimedProject | undefined;
  /** Entries waiting in the outbox, from the files. */
  readonly pending: number;
  /** What the running daemon reports, when one answers. */
  readonly live: CloudState | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the daemon's `cloud` health entry by shape; absent is undefined. */
export function cloudStateOf(
  health: Readonly<Record<string, unknown>> | undefined,
): CloudState | undefined {
  const value = health?.cloud;
  if (
    !isRecord(value) ||
    typeof value.claimed !== "boolean" ||
    typeof value.pending !== "number" ||
    typeof value.uploaded !== "number" ||
    typeof value.keyRefused !== "boolean"
  ) {
    return undefined;
  }
  return value as unknown as CloudState;
}

export async function readCloud(
  environment: Environment,
  fileSystem: FileSystemPort,
  health?: Readonly<Record<string, unknown>>,
): Promise<CloudReport> {
  const home = reflexHome(environment);
  const record = parseCloudRecord(
    (await fileSystem.read(cloudPath(home)))?.content.toString("utf8"),
  );
  const outbox = new CloudOutbox({ directory: defaultOutboxDirectory(home) });
  return {
    record,
    consentCurrent: cloudConsentCovers(record),
    thisProject: record?.projects.find(
      (project) => project.projectDir === environment.projectDir,
    ),
    pending: record === undefined ? 0 : await outbox.pending(),
    live: cloudStateOf(health),
  };
}

/** One line for `rfx status`. */
export function describeCloud(report: CloudReport): string {
  const { record } = report;
  if (record === undefined) {
    return 'not claimed; local only ("rfx claim <code> --endpoint <url>" links this project to an account)';
  }
  const where = `${record.organizationName} (${record.organizationId}) at ${record.endpoint}`;
  if (!report.consentCurrent) {
    return `claimed into ${where}; the consent statement changed, nothing is uploaded until "rfx claim" is run again`;
  }
  if (report.thisProject === undefined) {
    return `this installation is claimed into ${where}; this project is not ("rfx claim <code> --endpoint ${record.endpoint}" adds it)`;
  }
  const live = report.live;
  const uploads =
    live === undefined
      ? `${String(report.pending)} waiting to upload`
      : live.keyRefused
        ? `uploads stopped: the key was refused, run "rfx claim" again (${String(live.pending)} waiting)`
        : `${String(live.uploaded)} uploaded since the daemon started, ${String(live.pending)} waiting${live.lastError === undefined ? "" : `, last attempt failed (${live.lastError})`}`;
  return `${report.thisProject.name} is claimed into ${where}; ${uploads}`;
}

export interface ClaimPlan {
  readonly code: string;
  readonly endpoint: string;
  readonly agentId: AgentId;
  readonly agentCreatedAt: string;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly hosts: readonly HostKind[];
  /** Decisions this version recorded locally for the project. */
  readonly history: readonly {
    readonly summary: DecisionSummary;
    readonly record?: DecisionRecord;
  }[];
  /** An existing claim of this installation, which this one must agree with. */
  readonly existing: CloudRecord | undefined;
}

export type ClaimInspection =
  | { readonly ok: true; readonly plan: ClaimPlan }
  | {
      readonly ok: false;
      readonly reason:
        | "bad-code"
        | "bad-endpoint"
        | "not-initialized"
        | "not-installed"
        | "already-claimed";
      readonly detail: string;
    };

/** Normalizes a typed code to the form the control plane stores. */
export function normalizeClaimCode(code: string): string | undefined {
  const compact = code.trim().toUpperCase().replaceAll("-", "");
  if (!CLAIM_CODE_FORM.test(compact)) {
    return undefined;
  }
  return `RFX-${compact.slice(3, 7)}-${compact.slice(7, 11)}-${compact.slice(11, 15)}`;
}

/** Everything the claim needs, before anything is shown or sent. */
export async function inspectClaim(
  environment: Environment,
  fileSystem: FileSystemPort,
  options: {
    readonly code: string;
    readonly endpoint: string;
    readonly name?: string;
  },
): Promise<ClaimInspection> {
  const code = normalizeClaimCode(options.code);
  if (code === undefined) {
    return {
      ok: false,
      reason: "bad-code",
      detail: "a claim code looks like RFX-XXXX-XXXX-XXXX",
    };
  }
  const endpoint = classifyEndpoint(options.endpoint);
  if (endpoint === undefined) {
    return {
      ok: false,
      reason: "bad-endpoint",
      detail:
        "the endpoint must be an https: URL (plain http: only on this machine's loopback)",
    };
  }
  const home = reflexHome(environment);
  const paths = statePaths(home);
  const identity = parseIdentity(
    (await fileSystem.read(paths.identity))?.content.toString("utf8"),
  );
  if (identity === undefined) {
    return {
      ok: false,
      reason: "not-initialized",
      detail: 'this machine has no REFLEX identity yet; run "rfx init" first',
    };
  }
  const registry = parseRegistry(
    (await fileSystem.read(paths.installs))?.content.toString("utf8"),
  );
  const project = registry.projects.find(
    (entry) => entry.projectDir === environment.projectDir,
  );
  if (project === undefined) {
    return {
      ok: false,
      reason: "not-installed",
      detail: 'REFLEX is not installed in this project; run "rfx init" here',
    };
  }
  const hosts = [
    ...new Set(
      registry.installs
        .filter((entry) => entry.projectDir === environment.projectDir)
        .map((entry): HostKind => entry.host),
    ),
  ];
  const existing = parseCloudRecord(
    (await fileSystem.read(cloudPath(home)))?.content.toString("utf8"),
  );
  if (existing !== undefined && existing.endpoint !== endpoint) {
    return {
      ok: false,
      reason: "already-claimed",
      detail: `this installation is claimed into ${existing.organizationName} at ${existing.endpoint}; run "rfx unclaim" first to claim it elsewhere`,
    };
  }
  const name = options.name?.trim();
  return {
    ok: true,
    plan: {
      code,
      endpoint,
      agentId: identity.agentId,
      agentCreatedAt: identity.createdAt,
      projectId: project.projectId,
      projectName:
        name === undefined || name === ""
          ? basename(environment.projectDir) || "project"
          : name,
      hosts,
      history: await localHistory(home, project.projectId, identity.agentId),
      existing,
    },
  };
}

/** What this version recorded locally for the project, oldest first. */
export async function localHistory(
  home: string,
  projectId: ProjectId,
  agentId: AgentId,
): Promise<ClaimPlan["history"]> {
  const events = await new DecisionLog({
    directory: defaultDecisionLogDirectory(home),
  }).readRecent(RECENT_EVENTS);
  const records = new Map(
    (
      await new DecisionRecordLog({
        directory: defaultDecisionRecordDirectory(home),
      }).readRecent(RECENT_EVENTS)
    ).map((record) => [record.decisionId, record] as const),
  );
  const seen = new Set<string>();
  const history: { summary: DecisionSummary; record?: DecisionRecord }[] = [];
  for (const event of events) {
    if (event.kind !== "decision" || seen.has(event.decisionId)) {
      continue;
    }
    const summary = summaryFromEvent(event, agentId);
    if (summary?.projectId !== projectId) {
      continue;
    }
    seen.add(event.decisionId);
    const record = records.get(event.decisionId);
    history.push({ summary, ...(record === undefined ? {} : { record }) });
  }
  return history;
}

export type ClaimOutcome =
  | {
      readonly kind: "claimed";
      readonly record: CloudRecord;
      readonly enqueued: number;
    }
  | {
      readonly kind: "refused";
      readonly reason:
        "code-rejected" | "other-organization" | "unreachable" | "bad-answer";
      readonly detail: string;
    }
  | { readonly kind: "write-failed" };

export type ClaimFetchOutcome =
  | { readonly kind: "claimed"; readonly result: ClaimResult }
  | { readonly kind: "code-rejected"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string };

export type ClaimFetcher = (
  endpoint: string,
  request: ClaimRequest,
) => Promise<ClaimFetchOutcome>;

/** The default fetcher: one `POST /v1/claims`, no credential, a timeout. */
export async function postClaim(
  endpoint: string,
  request: ClaimRequest,
): Promise<ClaimFetchOutcome> {
  let response: Response;
  try {
    response = await fetch(`${endpoint}/v1/claims`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (error) {
    return {
      kind: "failed",
      detail: `cannot reach ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (
    response.status === 404 ||
    response.status === 409 ||
    response.status === 410 ||
    response.status === 422
  ) {
    return {
      kind: "code-rejected",
      detail: `the control plane answered HTTP ${String(response.status)}`,
    };
  }
  if (!response.ok) {
    return { kind: "failed", detail: `HTTP ${String(response.status)}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "failed", detail: "the answer was not JSON" };
  }
  const parsed = parseClaimResult(body);
  return parsed.ok
    ? { kind: "claimed", result: parsed.value }
    : { kind: "failed", detail: "the answer was not a claim result" };
}

/**
 * Sends the claim, writes `cloud.json`, stops the daemon, enqueues the
 * local history, and records the audit line. Only after the yes.
 */
export async function performClaim(
  environment: Environment,
  fileSystem: FileSystemPort,
  plan: ClaimPlan,
  fetcher: ClaimFetcher = postClaim,
): Promise<ClaimOutcome> {
  const now = environment.now();
  const sent = await fetcher(plan.endpoint, {
    code: plan.code,
    agent: { id: plan.agentId, createdAt: plan.agentCreatedAt },
    project: { id: plan.projectId, name: plan.projectName },
    hosts: plan.hosts,
    requestedAt: now.toISOString(),
  });
  if (sent.kind === "code-rejected") {
    return {
      kind: "refused",
      reason: "code-rejected",
      detail: `the code was not accepted (${sent.detail}): it may be used, expired, or for a project another organization already claimed`,
    };
  }
  if (sent.kind === "failed") {
    return { kind: "refused", reason: "unreachable", detail: sent.detail };
  }
  const { result } = sent;
  if (result.project.id !== plan.projectId) {
    return {
      kind: "refused",
      reason: "bad-answer",
      detail:
        "the control plane answered with another project id; the local identity is kept and nothing was written",
    };
  }
  if (
    plan.existing !== undefined &&
    plan.existing.organizationId !== result.organization.id
  ) {
    return {
      kind: "refused",
      reason: "other-organization",
      detail: `this installation is claimed into ${plan.existing.organizationName}; the code belongs to ${result.organization.name}. Run "rfx unclaim" first.`,
    };
  }
  const home = reflexHome(environment);
  const record: CloudRecord = {
    version: 1,
    endpoint: plan.endpoint,
    organizationId: result.organization.id,
    organizationName: result.organization.name,
    agentId: plan.agentId,
    key: { id: result.key.id, secret: result.key.secret },
    consent: {
      statementDigest: cloudConsentDigest(),
      grantedAt: now.toISOString(),
    },
    projects: [
      ...(plan.existing?.projects ?? []).filter(
        (project) => project.projectId !== plan.projectId,
      ),
      {
        projectId: plan.projectId,
        projectDir: environment.projectDir,
        name: plan.projectName,
        claimedAt: result.claimedAt,
      },
    ],
  };
  try {
    await fileSystem.write(
      cloudPath(home),
      Buffer.from(serializeCloud(record), "utf8"),
      STATE_FILE_MODE,
    );
  } catch {
    return { kind: "write-failed" };
  }
  // The daemon runs with what it was started with; the next decision starts
  // one that uploads. The history is appended while no daemon writes.
  await stopDaemon(home);
  const outbox = new CloudOutbox({ directory: defaultOutboxDirectory(home) });
  let enqueued = 0;
  for (const { summary, record: decisionRecord } of plan.history) {
    const appended = await outbox.append(
      decisionEntryOf(summary, decisionRecord),
    );
    if (appended.ok) {
      enqueued += 1;
    }
  }
  await appendAudit(home, {
    at: now.toISOString(),
    kind: "claim",
    projectDir: environment.projectDir,
    detail: {
      endpoint: plan.endpoint,
      organizationId: result.organization.id,
      projectId: plan.projectId,
      keyId: result.key.id,
      enqueued: String(enqueued),
    },
  });
  return { kind: "claimed", record, enqueued };
}

export type UnclaimOutcome =
  | { readonly kind: "unclaimed"; readonly record: CloudRecord }
  | { readonly kind: "not-claimed" }
  | { readonly kind: "write-failed" };

/** Deletes the claim and the outbox. What was uploaded stays with the organization. */
export async function unclaim(
  environment: Environment,
  fileSystem: FileSystemPort,
): Promise<UnclaimOutcome> {
  const home = reflexHome(environment);
  const record = parseCloudRecord(
    (await fileSystem.read(cloudPath(home)))?.content.toString("utf8"),
  );
  if (record === undefined) {
    return { kind: "not-claimed" };
  }
  await stopDaemon(home);
  try {
    await fileSystem.remove(cloudPath(home));
    const directory = defaultOutboxDirectory(home);
    for (const file of [OUTBOX_FILE, OUTBOX_CURSOR_FILE, "outcomes.json"]) {
      await fileSystem.remove(join(directory, file)).catch(() => undefined);
    }
  } catch {
    return { kind: "write-failed" };
  }
  await appendAudit(home, {
    at: environment.now().toISOString(),
    kind: "unclaim",
    projectDir: environment.projectDir,
    detail: {
      endpoint: record.endpoint,
      organizationId: record.organizationId,
    },
  });
  return { kind: "unclaimed", record };
}
