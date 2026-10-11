import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DecisionSummary,
  IngestEntry,
  IngestRequest,
} from "@reflex-control/contracts";
import {
  CloudOutbox,
  ObservationLog,
  type ObservationRecord,
} from "@reflex-control/telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classifyEndpoint,
  cloudConsentCovers,
  cloudConsentDigest,
  cloudConsentStatement,
  cloudPath,
  createUploader,
  newOutcomes,
  parseCloudRecord,
  serializeCloud,
  type CloudRecord,
  type IngestFetcher,
  type IngestOutcome,
} from "./cloud.js";

/**
 * ADR-019 §3 and §4 — nothing is written without a covering consent; the
 * uploader moves the cursor only on success, stops on a refused key, backs
 * off on failure, never retries what the server rejected, and ships the
 * outcomes of claimed projects by watermark.
 */
let root: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-cloud-"));
  home = join(root, "home");
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const PROJECT_DIR = "/work/claimed";
const OTHER_DIR = "/work/other";

function record(overrides: Partial<CloudRecord> = {}): CloudRecord {
  return {
    version: 1,
    endpoint: "https://cloud.example",
    organizationId: "org_a1b2c3d4e5f60718",
    organizationName: "Example Co",
    agentId: "agt_0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    key: {
      id: "key_0123456789abcdef",
      secret: "rfk_key_0123456789abcdef_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    },
    consent: {
      statementDigest: cloudConsentDigest(),
      grantedAt: "2026-10-10T09:00:00.000Z",
    },
    projects: [
      {
        projectId: "prj_00112233445566778899aabbccddeeff",
        projectDir: PROJECT_DIR,
        name: "claimed",
        claimedAt: "2026-10-10T09:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function summary(index: number): DecisionSummary {
  return {
    decisionId: `dec_${String(index).padStart(6, "0")}`,
    actionId: `act_${String(index).padStart(6, "0")}`,
    agentId: "agt_0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    projectId: "prj_00112233445566778899aabbccddeeff",
    decidedAt: "2026-10-10T10:00:00.000Z",
    action: {
      host: "claude-code",
      toolName: "Bash",
      sideEffectClass: "local-read",
      environment: "unknown",
    },
    effect: "allow",
    effectiveEffect: "allow",
    mode: "autopilot",
    risk: 5,
    confidence: 1,
    reasonCodes: ["explicit_allow"],
    matchedRuleIds: ["allow-reads"],
    cached: false,
    latency: { totalMs: 1, policyMs: 1 },
  };
}

const entry = (index: number): IngestEntry => ({
  kind: "decision",
  summary: summary(index),
});

interface FakeControlPlane {
  readonly fetcher: IngestFetcher;
  readonly requests: IngestRequest[];
  readonly keys: string[];
  answers: IngestOutcome[];
}

function controlPlane(...answers: IngestOutcome[]): FakeControlPlane {
  const plane: FakeControlPlane = {
    requests: [],
    keys: [],
    answers,
    fetcher: (_endpoint, key, request) => {
      plane.requests.push(request);
      plane.keys.push(key);
      const next = plane.answers.shift() ?? {
        kind: "accepted",
        result: {
          accepted: request.entries.length,
          duplicates: 0,
          rejected: [],
        },
      };
      return Promise.resolve(next);
    },
  };
  return plane;
}

describe("ADR-019 cloud record", () => {
  it("round-trips, and refuses what it cannot read", () => {
    const written = serializeCloud(record());
    expect(parseCloudRecord(written)).toEqual(record());
    expect(parseCloudRecord(undefined)).toBeUndefined();
    expect(parseCloudRecord("{")).toBeUndefined();
    expect(parseCloudRecord(JSON.stringify({ version: 2 }))).toBeUndefined();
  });

  it.each([
    ["an endpoint that is not https", { endpoint: "http://cloud.example" }],
    [
      "a key of another form",
      { key: { id: "key_0123456789abcdef", secret: "sk-live-0123456789ab" } },
    ],
    ["an agent id of another kind", { agentId: "prj_x" }],
  ] as const)("refuses a record with %s", (_label, overrides) => {
    expect(
      parseCloudRecord(
        JSON.stringify({ ...record(), ...(overrides as object) }),
      ),
    ).toBeUndefined();
  });

  it("drops a project entry it cannot read and keeps the rest", () => {
    const parsed = parseCloudRecord(
      JSON.stringify({
        ...record(),
        projects: [...record().projects, { projectId: "nope" }],
      }),
    );
    expect(parsed?.projects).toHaveLength(1);
  });

  it("lives at <home>/cloud.json", () => {
    expect(cloudPath("/h")).toBe("/h/cloud.json");
  });
});

describe("ADR-019 endpoints", () => {
  it.each([
    ["https://cloud.example", "https://cloud.example"],
    ["https://cloud.example/v1/", "https://cloud.example"],
    ["https://cloud.example:8443", "https://cloud.example:8443"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://localhost:3000/x", "http://localhost:3000"],
  ])("accepts %s as %s", (endpoint, origin) => {
    expect(classifyEndpoint(endpoint)).toBe(origin);
  });

  it.each([
    "http://cloud.example",
    "http://10.0.0.5:3000",
    "ftp://cloud.example",
    "https://user:pw@cloud.example",
    "cloud.example",
    "",
  ])("refuses %j", (endpoint) => {
    expect(classifyEndpoint(endpoint)).toBeUndefined();
  });
});

describe("ADR-019 cloud consent", () => {
  it("is versioned by its digest, and a changed statement withdraws the yes", () => {
    expect(cloudConsentDigest()).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(cloudConsentCovers(record())).toBe(true);
    expect(
      cloudConsentCovers(
        record({
          consent: { statementDigest: "sha256:old", grantedAt: "2026" },
        }),
      ),
    ).toBe(false);
    expect(cloudConsentCovers(undefined)).toBe(false);
  });

  it("says what is uploaded, what never is, where, for how long, and that declining changes nothing", () => {
    const statement = cloudConsentStatement();
    for (const phrase of [
      "What is uploaded, per decision:",
      "never its path on disk",
      "What is never uploaded:",
      "file paths, working directories, tool output, transcripts",
      "rfx unclaim",
      "90 days by default",
      "30 days",
      "Declining changes nothing",
    ]) {
      expect(statement).toContain(phrase);
    }
    // Fixed text: the endpoint and the organization are printed beside it.
    expect(statement).not.toContain("https://");
  });
});

describe("ADR-019 uploader", () => {
  it("writes nothing to the outbox, and uploads nothing, without a covering consent", async () => {
    const plane = controlPlane();
    const outbox = new CloudOutbox({ directory: join(home, "cloud") });
    const uploader = createUploader({
      home,
      record: record({
        consent: { statementDigest: "sha256:old", grantedAt: "2026" },
      }),
      outbox,
      fetcher: plane.fetcher,
    });
    await uploader.enqueue(entry(1));
    expect(await outbox.pending()).toBe(0);
    expect(await uploader.tick()).toEqual({
      kind: "withheld",
      reason: "consent-outdated",
    });
    expect(plane.requests).toEqual([]);
    expect(uploader.state().consentCurrent).toBe(false);
  });

  it("uploads the outbox in order with the key, and moves the cursor on success only", async () => {
    const plane = controlPlane(
      { kind: "failed", reason: "HTTP 503" },
      {
        kind: "accepted",
        result: { accepted: 1, duplicates: 1, rejected: [] },
      },
    );
    const outbox = new CloudOutbox({ directory: join(home, "cloud") });
    const uploader = createUploader({
      home,
      record: record(),
      outbox,
      fetcher: plane.fetcher,
      clock: () => new Date("2026-10-10T12:00:00.000Z"),
    });
    await uploader.enqueue(entry(1));
    await uploader.enqueue(entry(2));

    expect(await uploader.tick()).toEqual({
      kind: "failed",
      reason: "HTTP 503",
    });
    // Nothing acknowledged: the same two go again.
    expect(await outbox.pending()).toBe(2);
    expect(uploader.state()).toMatchObject({
      pending: 2,
      uploaded: 0,
      lastError: "HTTP 503",
    });

    expect(await uploader.tick()).toEqual({ kind: "uploaded", entries: 2 });
    expect(plane.keys).toEqual([record().key.secret, record().key.secret]);
    expect(plane.requests[1]).toMatchObject({
      agentId: record().agentId,
      sentAt: "2026-10-10T12:00:00.000Z",
    });
    expect(
      plane.requests[1]?.entries.map((item) =>
        item.kind === "decision" ? item.summary.decisionId : item.kind,
      ),
    ).toEqual(["dec_000001", "dec_000002"]);
    expect(await outbox.pending()).toBe(0);
    expect(uploader.state()).toMatchObject({
      pending: 0,
      uploaded: 1,
      duplicates: 1,
      rejected: 0,
      lastUploadAt: "2026-10-10T12:00:00.000Z",
      keyRefused: false,
    });
    expect(uploader.state().lastError).toBeUndefined();
    expect(await uploader.tick()).toEqual({ kind: "idle" });
  });

  it("counts what the control plane rejected and never sends it again", async () => {
    const plane = controlPlane({
      kind: "accepted",
      result: {
        accepted: 1,
        duplicates: 0,
        rejected: [{ index: 1, reason: "unknown-project" }],
      },
    });
    const uploader = createUploader({
      home,
      record: record(),
      fetcher: plane.fetcher,
    });
    await uploader.enqueue(entry(1));
    await uploader.enqueue(entry(2));
    await uploader.tick();
    expect(uploader.state()).toMatchObject({ uploaded: 1, rejected: 1 });
    expect(await uploader.tick()).toEqual({ kind: "idle" });
    expect(plane.requests).toHaveLength(1);
  });

  it("stops on a refused key and says so", async () => {
    const plane = controlPlane({ kind: "refused-key" });
    const uploader = createUploader({
      home,
      record: record(),
      fetcher: plane.fetcher,
    });
    await uploader.enqueue(entry(1));
    uploader.start();
    expect(await uploader.tick()).toEqual({ kind: "refused-key" });
    expect(await uploader.tick()).toEqual({ kind: "refused-key" });
    expect(plane.requests).toHaveLength(1);
    expect(uploader.state()).toMatchObject({
      keyRefused: true,
      pending: 1,
      lastError: "the control plane refused this installation's key",
    });
    expect(uploader.state().nextAttemptAt).toBeUndefined();
    uploader.stop();
  });

  it("halves the batch when the control plane calls it too large", async () => {
    const plane = controlPlane({ kind: "too-large" });
    const uploader = createUploader({
      home,
      record: record(),
      fetcher: plane.fetcher,
      batchSize: 4,
    });
    for (const index of [1, 2, 3, 4]) {
      await uploader.enqueue(entry(index));
    }
    expect((await uploader.tick()).kind).toBe("failed");
    expect(plane.requests[0]?.entries).toHaveLength(4);
    await uploader.tick();
    expect(plane.requests[1]?.entries).toHaveLength(2);
  });

  it("backs off on failure, up to a bound, and plans nothing until started", async () => {
    const plane = controlPlane(
      { kind: "failed", reason: "down" },
      { kind: "failed", reason: "down" },
      { kind: "failed", reason: "down" },
    );
    let now = Date.parse("2026-10-10T12:00:00.000Z");
    const uploader = createUploader({
      home,
      record: record(),
      fetcher: plane.fetcher,
      clock: () => new Date(now),
      intervalMs: 5_000,
    });
    await uploader.enqueue(entry(1));
    await uploader.tick();
    expect(uploader.state().nextAttemptAt).toBeUndefined();

    uploader.start();
    const delays: number[] = [];
    for (let round = 0; round < 2; round += 1) {
      await uploader.tick();
      const next = uploader.state().nextAttemptAt;
      delays.push(Date.parse(next ?? "") - now);
      now += 1;
    }
    expect(delays[0]).toBe(20_000);
    expect(delays[1]).toBe(40_000);
    uploader.stop();
    expect(uploader.state().nextAttemptAt).toBeUndefined();
  });

  it("attributes an action to the claimed project by its directory", () => {
    const uploader = createUploader({ home, record: record() });
    expect(uploader.projectOf(PROJECT_DIR)?.projectId).toBe(
      "prj_00112233445566778899aabbccddeeff",
    );
    expect(uploader.projectOf(OTHER_DIR)).toBeUndefined();
    expect(uploader.projectOf(undefined)).toBeUndefined();
  });
});

describe("ADR-019 outcomes of claimed projects", () => {
  const action = (
    id: string,
    projectRoot: string,
    at: string,
  ): ObservationRecord => ({
    kind: "action",
    recordVersion: 1,
    recordedAt: at,
    actionId: `act_${id}`,
    host: "claude-code",
    toolName: "Bash",
    sideEffectClass: "local-read",
    projectRoot,
    createdAt: at,
    argumentShape: { type: "object", keys: {}, otherKeys: 0 },
  });
  const executed = (id: string, at: string): ObservationRecord => ({
    kind: "signal",
    recordVersion: 1,
    recordedAt: at,
    actionId: `act_${id}`,
    signal: "executed",
  });

  const records: ObservationRecord[] = [
    action("a", PROJECT_DIR, "2026-10-10T10:00:00.000Z"),
    executed("a", "2026-10-10T10:00:01.000Z"),
    action("b", OTHER_DIR, "2026-10-10T10:00:02.000Z"),
    executed("b", "2026-10-10T10:00:03.000Z"),
    action("c", PROJECT_DIR, "2026-10-10T10:00:04.000Z"),
    executed("c", "2026-10-10T10:00:05.000Z"),
    // Observed, nothing known yet: not worth sending.
    action("d", PROJECT_DIR, "2026-10-10T10:00:06.000Z"),
  ];

  it("ships outcomes of claimed projects only, newer than the watermark, oldest first", () => {
    const all = newOutcomes(records, record().projects, {
      observedAt: "",
      actionIds: [],
    });
    expect(all.map(({ outcome }) => outcome.actionId)).toEqual([
      "act_a",
      "act_c",
    ]);
    expect(all[0]?.outcome).toMatchObject({
      prompted: "no",
      humanResponse: "none",
      executed: "yes",
    });
    const later = newOutcomes(records, record().projects, {
      observedAt: "2026-10-10T10:00:01.000Z",
      actionIds: ["act_a"],
    });
    expect(later.map(({ outcome }) => outcome.actionId)).toEqual(["act_c"]);
  });

  it("uploads them beside the decisions and advances the watermark", async () => {
    const observations = new ObservationLog({
      directory: join(home, "observe"),
    });
    for (const item of records) {
      await observations.append(item);
    }
    const plane = controlPlane();
    const uploader = createUploader({
      home,
      record: record(),
      observations,
      fetcher: plane.fetcher,
    });
    await uploader.enqueue(entry(1));
    expect(await uploader.tick()).toEqual({ kind: "uploaded", entries: 3 });
    expect(
      plane.requests[0]?.entries.map((item) =>
        item.kind === "outcome" ? item.outcome.actionId : item.kind,
      ),
    ).toEqual(["decision", "act_a", "act_c"]);
    const watermark: unknown = JSON.parse(
      await readFile(join(home, "cloud", "outcomes.json"), "utf8"),
    );
    expect(watermark).toEqual({
      observedAt: "2026-10-10T10:00:05.000Z",
      actionIds: ["act_c"],
    });
    // Nothing new: idle, and no resend.
    expect(await uploader.tick()).toEqual({ kind: "idle" });
    expect(plane.requests).toHaveLength(1);
  });

  it("leaves the watermark alone when the upload fails", async () => {
    const observations = new ObservationLog({
      directory: join(home, "observe"),
    });
    for (const item of records) {
      await observations.append(item);
    }
    const plane = controlPlane({ kind: "failed", reason: "down" });
    const uploader = createUploader({
      home,
      record: record(),
      observations,
      fetcher: plane.fetcher,
    });
    expect((await uploader.tick()).kind).toBe("failed");
    await expect(
      readFile(join(home, "cloud", "outcomes.json"), "utf8"),
    ).rejects.toThrow();
    expect(await uploader.tick()).toEqual({ kind: "uploaded", entries: 2 });
  });
});
