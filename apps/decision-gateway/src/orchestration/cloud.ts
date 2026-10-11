import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CLOUD_KEY_FORM,
  CONTRACT_LIMITS,
  isOpaqueId,
  parseIngestResult,
  type ActionOutcome,
  type AgentId,
  type IngestEntry,
  type IngestRequest,
  type IngestResult,
  type KeyId,
  type OrganizationId,
  type ProjectId,
} from "@reflex-control/contracts";
import {
  assembleOutcomes,
  CloudOutbox,
  ObservationLog,
  type ObservationRecord,
} from "@reflex-control/telemetry";

/**
 * ADR-019 §3 and §4 — the daemon's side of a claimed installation.
 *
 * `rfx claim` writes `<REFLEX_HOME>/cloud.json`: where the control plane
 * is, which organization, this installation's `ingest` key, the consent
 * that was given (by the digest of the statement that was shown) and the
 * projects claimed on this machine. From then on, after every decision of
 * a claimed project and off the decision path, the daemon appends the
 * decision's summary and record to the outbox, and the uploader ships the
 * outbox in batches, in order, at a bounded interval, with the key.
 *
 * Nothing is written for the cloud without a record whose consent covers
 * the current statement: a changed statement withdraws the yes, and the
 * daemon says so in health until the user agrees again.
 */
export const CLOUD_RECORD_VERSION = 1;
export const DEFAULT_UPLOAD_INTERVAL_MS = 30_000;
export const MIN_UPLOAD_INTERVAL_MS = 5_000;
export const MAX_BACKOFF_MS = 600_000;
export const DEFAULT_BATCH_SIZE = 200;
/** How soon after a new entry the next round runs, when none is due sooner. */
export const ENQUEUE_DELAY_MS = 1_000;
const UPLOAD_TIMEOUT_MS = 15_000;
const RECENT_OBSERVATIONS = 5_000;
const OUTCOME_WATERMARK_FILE = "outcomes.json";
const FILE_MODE = 0o600;

export interface ClaimedProject {
  readonly projectId: ProjectId;
  /** The project's directory on this machine: how an action is attributed. */
  readonly projectDir: string;
  readonly name: string;
  readonly claimedAt: string;
}

export interface CloudRecord {
  readonly version: typeof CLOUD_RECORD_VERSION;
  readonly endpoint: string;
  readonly organizationId: OrganizationId;
  readonly organizationName: string;
  readonly agentId: AgentId;
  readonly key: {
    readonly id: KeyId;
    readonly secret: string;
  };
  readonly consent: {
    readonly statementDigest: string;
    readonly grantedAt: string;
  };
  readonly projects: readonly ClaimedProject[];
}

export function cloudPath(home: string): string {
  return join(home, "cloud.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A record REFLEX cannot read is no claim: nothing is uploaded. */
export function parseCloudRecord(
  text: string | undefined,
): CloudRecord | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      !isRecord(parsed) ||
      parsed.version !== CLOUD_RECORD_VERSION ||
      typeof parsed.endpoint !== "string" ||
      classifyEndpoint(parsed.endpoint) === undefined ||
      !isOpaqueId("org", parsed.organizationId) ||
      typeof parsed.organizationName !== "string" ||
      !isOpaqueId("agt", parsed.agentId) ||
      !isRecord(parsed.key) ||
      !isOpaqueId("key", parsed.key.id) ||
      typeof parsed.key.secret !== "string" ||
      !CLOUD_KEY_FORM.test(parsed.key.secret) ||
      !isRecord(parsed.consent) ||
      typeof parsed.consent.statementDigest !== "string" ||
      typeof parsed.consent.grantedAt !== "string" ||
      !Array.isArray(parsed.projects)
    ) {
      return undefined;
    }
    const projects = (parsed.projects as unknown[]).flatMap(
      (entry): ClaimedProject[] =>
        isRecord(entry) &&
        isOpaqueId("prj", entry.projectId) &&
        typeof entry.projectDir === "string" &&
        typeof entry.name === "string" &&
        typeof entry.claimedAt === "string"
          ? [
              {
                projectId: entry.projectId,
                projectDir: entry.projectDir,
                name: entry.name,
                claimedAt: entry.claimedAt,
              },
            ]
          : [],
    );
    return {
      version: CLOUD_RECORD_VERSION,
      endpoint: parsed.endpoint,
      organizationId: parsed.organizationId,
      organizationName: parsed.organizationName,
      agentId: parsed.agentId,
      key: { id: parsed.key.id, secret: parsed.key.secret },
      consent: {
        statementDigest: parsed.consent.statementDigest,
        grantedAt: parsed.consent.grantedAt,
      },
      projects,
    };
  } catch {
    return undefined;
  }
}

export function serializeCloud(record: CloudRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Where a control plane may be: HTTPS anywhere, plain HTTP on the loopback
 * only (a control plane under test on this machine). Anything else is
 * refused before any I/O. The origin is kept; a path is not.
 */
export function classifyEndpoint(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "") {
    return undefined;
  }
  if (url.protocol === "https:") {
    return url.hostname === "" ? undefined : url.origin;
  }
  if (
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    return url.origin;
  }
  return undefined;
}

/**
 * The cloud consent statement (ADR-019 §3). Fixed text, so that its digest
 * names one statement: the endpoint, the organization and the count of
 * local decisions are printed beside it by `rfx claim`, never inside it.
 */
export function cloudConsentStatement(): string {
  return [
    "REFLEX will upload what it decides in this project to the organization's control plane, from this installation, after each decision and never before it.",
    "",
    "What is uploaded, per decision:",
    "  - the ids: this installation's, the project's, the session's, the decision's and the action's;",
    "  - the host and its version; the tool's name and namespace, the operation, and the side-effect class;",
    "  - the environment, and the repository's branch and remote host, never its path on disk;",
    "  - the effect, the mode, the risk, the reason codes, the ids of the rules that matched, the policy set's hash, and the latencies;",
    "  - for an action a consented provider assessed: the redacted request it was given and its answer, exactly as kept locally;",
    "  - what the host then did: whether it prompted, what the human answered, whether the action ran.",
    "",
    "What is never uploaded:",
    "  - the arguments of an action a rule or a policy default decided, file paths, working directories, tool output, transcripts, or your name;",
    '  - anything before you agree, and nothing after you run "rfx unclaim".',
    "",
    "Where it goes, and for how long:",
    "  - to the control plane at the endpoint shown below, over HTTPS, with a key that can only add this installation's own decisions;",
    "  - the organization's administrators can see it, set how long it is kept (90 days by default), and delete it;",
    "  - the redacted requests are kept for 30 days, and only once the organization turns that on;",
    "  - the decisions this version already recorded locally for this project are uploaded with the first batch; the count is shown below.",
    "",
    "Declining changes nothing: REFLEX keeps deciding here, and nothing leaves this machine.",
  ].join("\n");
}

export function cloudConsentDigest(): string {
  return `sha256:${createHash("sha256").update(cloudConsentStatement(), "utf8").digest("hex")}`;
}

/** True when the record's consent is to the current statement. */
export function cloudConsentCovers(record: CloudRecord | undefined): boolean {
  return record?.consent.statementDigest === cloudConsentDigest();
}

export interface CloudState {
  readonly claimed: boolean;
  readonly endpoint?: string;
  readonly organizationId?: OrganizationId;
  readonly organizationName?: string;
  readonly projects?: readonly { projectId: ProjectId; name: string }[];
  /** False when the statement changed since the yes: nothing is uploaded. */
  readonly consentCurrent?: boolean;
  /** Entries waiting in the outbox. */
  readonly pending: number;
  readonly uploaded: number;
  readonly duplicates: number;
  /** Entries the control plane refused; dropped, counted, never retried. */
  readonly rejected: number;
  /** Entries dropped because the outbox was full. */
  readonly dropped: number;
  readonly lastUploadAt?: string;
  readonly lastError?: string;
  /** The key was refused: uploads stop until the installation is claimed again. */
  readonly keyRefused: boolean;
  readonly nextAttemptAt?: string;
}

export type IngestOutcome =
  | { readonly kind: "accepted"; readonly result: IngestResult }
  | { readonly kind: "refused-key" }
  | { readonly kind: "too-large" }
  | { readonly kind: "failed"; readonly reason: string };

export type IngestFetcher = (
  endpoint: string,
  key: string,
  request: IngestRequest,
) => Promise<IngestOutcome>;

/** The default fetcher: one `POST`, the key as a bearer token, a timeout. */
export async function postIngest(
  endpoint: string,
  key: string,
  request: IngestRequest,
): Promise<IngestOutcome> {
  let response: Response;
  try {
    response = await fetch(`${endpoint}/v1/ingest`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
  } catch (error) {
    return {
      kind: "failed",
      reason: `upload failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "refused-key" };
  }
  if (response.status === 413) {
    return { kind: "too-large" };
  }
  if (!response.ok) {
    return { kind: "failed", reason: `HTTP ${String(response.status)}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "failed", reason: "the answer was not JSON" };
  }
  const parsed = parseIngestResult(body);
  return parsed.ok
    ? { kind: "accepted", result: parsed.value }
    : { kind: "failed", reason: "the answer was not an ingest result" };
}

export type TickOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "uploaded"; readonly entries: number }
  | { readonly kind: "refused-key" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "withheld"; readonly reason: string };

export interface Uploader {
  readonly record: CloudRecord;
  /** The claimed project an action in this directory belongs to, if any. */
  readonly projectOf: (
    projectDir: string | undefined,
  ) => ClaimedProject | undefined;
  /** Appends to the outbox; never on the decision path, never throws. */
  readonly enqueue: (entry: IngestEntry) => Promise<void>;
  /** One upload round: outcomes gathered, one batch sent, cursor moved. */
  readonly tick: () => Promise<TickOutcome>;
  readonly start: () => void;
  readonly stop: () => void;
  readonly state: () => CloudState;
}

export interface UploaderOptions {
  readonly home: string;
  readonly record: CloudRecord;
  readonly outbox?: CloudOutbox;
  readonly observations?: ObservationLog;
  readonly fetcher?: IngestFetcher;
  readonly clock?: () => Date;
  readonly intervalMs?: number;
  readonly batchSize?: number;
}

interface OutcomeWatermark {
  readonly observedAt: string;
  readonly actionIds: readonly string[];
}

async function readWatermark(file: string): Promise<OutcomeWatermark> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      isRecord(parsed) &&
      typeof parsed.observedAt === "string" &&
      Array.isArray(parsed.actionIds)
    ) {
      return {
        observedAt: parsed.observedAt,
        actionIds: (parsed.actionIds as unknown[]).filter(
          (id): id is string => typeof id === "string",
        ),
      };
    }
  } catch {
    // Nothing shipped yet.
  }
  return { observedAt: "", actionIds: [] };
}

async function writeWatermark(
  file: string,
  watermark: OutcomeWatermark,
): Promise<void> {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(watermark)}\n`, {
    mode: FILE_MODE,
  });
  await rename(temporary, file);
}

/** Outcomes of claimed projects newer than the watermark, oldest first. */
export function newOutcomes(
  records: readonly ObservationRecord[],
  projects: readonly ClaimedProject[],
  watermark: OutcomeWatermark,
): readonly {
  readonly projectId: ProjectId;
  readonly outcome: ActionOutcome;
}[] {
  const byRoot = new Map(projects.map((p) => [p.projectDir, p.projectId]));
  const projectOfAction = new Map<string, ProjectId>();
  for (const record of records) {
    if (record.kind === "action" && record.projectRoot !== undefined) {
      const projectId = byRoot.get(record.projectRoot);
      if (projectId !== undefined) {
        projectOfAction.set(record.actionId, projectId);
      }
    }
  }
  const shipped = new Set(watermark.actionIds);
  return assembleOutcomes(records)
    .flatMap((outcome) => {
      const projectId = projectOfAction.get(outcome.actionId);
      if (projectId === undefined) {
        return [];
      }
      if (
        outcome.observedAt < watermark.observedAt ||
        (outcome.observedAt === watermark.observedAt &&
          shipped.has(outcome.actionId))
      ) {
        return [];
      }
      // An outcome with no signal yet says nothing worth sending.
      if (outcome.prompted === "unknown" && outcome.executed === "unknown") {
        return [];
      }
      return [{ projectId, outcome }];
    })
    .sort((a, b) => a.outcome.observedAt.localeCompare(b.outcome.observedAt));
}

export function createUploader(options: UploaderOptions): Uploader {
  const { record } = options;
  const clock = options.clock ?? (() => new Date());
  const fetcher = options.fetcher ?? postIngest;
  const outbox =
    options.outbox ??
    new CloudOutbox({ directory: join(options.home, "cloud") });
  const observations =
    options.observations ??
    new ObservationLog({ directory: join(options.home, "observe") });
  const watermarkFile = join(options.home, "cloud", OUTCOME_WATERMARK_FILE);
  const intervalMs = Math.max(
    MIN_UPLOAD_INTERVAL_MS,
    options.intervalMs ?? DEFAULT_UPLOAD_INTERVAL_MS,
  );
  let batchSize = Math.max(
    1,
    Math.min(
      options.batchSize ?? DEFAULT_BATCH_SIZE,
      CONTRACT_LIMITS.ingestEntries,
    ),
  );
  const consentCurrent = cloudConsentCovers(record);

  let pending = 0;
  let uploaded = 0;
  let duplicates = 0;
  let rejected = 0;
  let lastUploadAt: string | undefined;
  let lastError: string | undefined;
  let keyRefused = false;
  let backoffMs = intervalMs;
  let nextAttemptAt: Date | undefined;
  let timer: NodeJS.Timeout | undefined;
  let started = false;
  let running: Promise<TickOutcome> | undefined;

  const projectOf = (
    projectDir: string | undefined,
  ): ClaimedProject | undefined =>
    projectDir === undefined
      ? undefined
      : record.projects.find((project) => project.projectDir === projectDir);

  const enqueue = async (entry: IngestEntry): Promise<void> => {
    if (!consentCurrent) {
      return;
    }
    const result = await outbox.append(entry);
    if (result.ok) {
      pending += 1;
      // A decision reaches the control plane soon, not after a whole
      // interval; a backoff after a failure is kept.
      if (
        backoffMs === intervalMs &&
        (nextAttemptAt === undefined ||
          nextAttemptAt.getTime() - clock().getTime() > ENQUEUE_DELAY_MS)
      ) {
        schedule(ENQUEUE_DELAY_MS);
      }
    }
  };

  /** Plans the next round. Only a started uploader plans anything. */
  const schedule = (delayMs: number): void => {
    if (!started || keyRefused) {
      return;
    }
    clearTimeout(timer);
    nextAttemptAt = new Date(clock().getTime() + delayMs);
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
    timer.unref();
  };

  const tick = async (): Promise<TickOutcome> => {
    if (running !== undefined) {
      return running;
    }
    running = run().finally(() => {
      running = undefined;
    });
    return running;
  };

  interface GatheredOutcomes {
    readonly entries: readonly IngestEntry[];
    readonly watermark: OutcomeWatermark | undefined;
  }

  /** Never throws: an unreadable observation log ships no outcome this round. */
  const gatherOutcomes = async (): Promise<GatheredOutcomes> => {
    try {
      const current = await readWatermark(watermarkFile);
      const fresh = newOutcomes(
        await observations.readRecent(RECENT_OBSERVATIONS),
        record.projects,
        current,
      ).slice(0, Math.max(1, Math.floor(batchSize / 2)));
      const last = fresh.at(-1);
      const at = last?.outcome.observedAt;
      return {
        entries: fresh.map(({ projectId, outcome }): IngestEntry => ({
          kind: "outcome",
          projectId,
          outcome,
        })),
        watermark:
          at === undefined
            ? undefined
            : {
                observedAt: at,
                actionIds: [
                  ...(at === current.observedAt ? current.actionIds : []),
                  ...fresh
                    .filter(({ outcome }) => outcome.observedAt === at)
                    .map(({ outcome }) => outcome.actionId),
                ],
              },
      };
    } catch {
      return { entries: [], watermark: undefined };
    }
  };

  const run = async (): Promise<TickOutcome> => {
    if (!consentCurrent) {
      return { kind: "withheld", reason: "consent-outdated" };
    }
    if (keyRefused) {
      return { kind: "refused-key" };
    }
    // Outcomes of claimed projects first: they are joined to decisions
    // already uploaded, and a resend is harmless (keyed by action id).
    const gathered = await gatherOutcomes();
    const outcomeEntries = gathered.entries;
    const watermark = gathered.watermark;

    const batch = await outbox.peek(
      Math.max(1, batchSize - outcomeEntries.length),
    );
    pending = await outbox.pending();
    const entries = [...batch.entries, ...outcomeEntries];
    if (entries.length === 0) {
      schedule(intervalMs);
      return { kind: "idle" };
    }

    const outcome = await fetcher(record.endpoint, record.key.secret, {
      agentId: record.agentId,
      sentAt: clock().toISOString(),
      entries,
    });
    switch (outcome.kind) {
      case "accepted": {
        if (batch.entries.length > 0) {
          await outbox.acknowledge(batch.cursor);
        }
        if (watermark !== undefined) {
          await writeWatermark(watermarkFile, watermark).catch(() => undefined);
        }
        uploaded += outcome.result.accepted;
        duplicates += outcome.result.duplicates;
        rejected += outcome.result.rejected.length;
        lastUploadAt = clock().toISOString();
        lastError = undefined;
        backoffMs = intervalMs;
        pending = await outbox.pending();
        // More waiting: go again soon, not after a whole interval.
        schedule(pending > 0 ? MIN_UPLOAD_INTERVAL_MS : intervalMs);
        return { kind: "uploaded", entries: entries.length };
      }
      case "refused-key": {
        keyRefused = true;
        lastError = "the control plane refused this installation's key";
        clearTimeout(timer);
        timer = undefined;
        nextAttemptAt = undefined;
        return { kind: "refused-key" };
      }
      case "too-large": {
        batchSize = Math.max(1, Math.floor(batchSize / 2));
        lastError = "the control plane refused the batch as too large";
        schedule(MIN_UPLOAD_INTERVAL_MS);
        return { kind: "failed", reason: lastError };
      }
      case "failed": {
        lastError = outcome.reason;
        backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
        schedule(backoffMs);
        return { kind: "failed", reason: outcome.reason };
      }
    }
  };

  return {
    record,
    projectOf,
    enqueue,
    tick,
    start: () => {
      if (started) {
        return;
      }
      started = true;
      schedule(MIN_UPLOAD_INTERVAL_MS);
    },
    stop: () => {
      started = false;
      clearTimeout(timer);
      timer = undefined;
      nextAttemptAt = undefined;
    },
    state: () => ({
      claimed: true,
      endpoint: record.endpoint,
      organizationId: record.organizationId,
      organizationName: record.organizationName,
      projects: record.projects.map(({ projectId, name }) => ({
        projectId,
        name,
      })),
      consentCurrent,
      pending,
      uploaded,
      duplicates,
      rejected,
      dropped: outbox.dropped,
      ...(lastUploadAt === undefined ? {} : { lastUploadAt }),
      ...(lastError === undefined ? {} : { lastError }),
      keyRefused,
      ...(nextAttemptAt === undefined
        ? {}
        : { nextAttemptAt: nextAttemptAt.toISOString() }),
    }),
  };
}

/** The state of a machine that is not claimed. */
export const UNCLAIMED: CloudState = {
  claimed: false,
  pending: 0,
  uploaded: 0,
  duplicates: 0,
  rejected: 0,
  dropped: 0,
  keyRefused: false,
};

/** Reads `cloud.json`; `undefined` when there is none or it cannot be read. */
export async function readCloudRecord(
  home: string,
): Promise<CloudRecord | undefined> {
  return parseCloudRecord(
    await readFile(cloudPath(home), "utf8").catch(() => undefined),
  );
}
