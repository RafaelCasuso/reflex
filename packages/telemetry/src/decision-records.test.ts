import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTRACT_VERSION,
  parseDecisionRecord,
  type ActionOutcome,
  type DecisionFeedback,
  type ReflexDecision,
  type SemanticAssessment,
  type SemanticDecisionRequest,
} from "@reflex/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  DECISION_RECORD_RETENTION_MS,
  DecisionRecordLog,
  decisionRecordOf,
  labelsFromFeedback,
  labelsFromOutcome,
  withFeedback,
  withOutcome,
} from "./decision-records.js";
import { RotatingJsonlLog } from "./rotating-log.js";

/**
 * RFX-143 — the record is built from the decision and what the engine
 * observed, joined later by id, and written to a log kept seven days.
 */
const AT = "2026-09-25T10:00:00.000Z";

const signal = (value: number) => ({ value, confidence: 0.9 });
const assessment: SemanticAssessment = {
  objectiveAlignment: signal(90),
  destructiveRisk: signal(0),
  reversibility: signal(100),
  externalSideEffect: { value: false, confidence: 0.9 },
  privilegeEscalation: signal(0),
  secretAccess: signal(0),
  sensitiveDataExposure: signal(0),
  financialConsequence: signal(0),
  productionMutation: signal(0),
  unusualScope: signal(0),
  untrustedInput: signal(0),
  provider: "fake",
  model: "fake-1",
  latencyMs: 1,
};

const request: SemanticDecisionRequest = {
  action: {
    tool: { name: "Bash" },
    arguments: { command: "cat [REDACTED:github-token:0123abcd]" },
    sideEffectClass: "local-read",
  },
  maxInputTokens: 600,
  deadlineMs: 500,
};

const decision: ReflexDecision = {
  id: "dec_00000000000000000000000000000001",
  actionId: "act_00000000000000000000000000000001",
  effect: "allow",
  effectiveEffect: "allow",
  mode: "autopilot",
  risk: 10,
  confidence: 0.9,
  reasonCodes: [],
  policyMatches: [],
  semanticAssessment: assessment,
  policySetHash: "sha256:abc",
  cached: false,
  cacheKey: "sha256:canary-cache-key",
  latency: { totalMs: 3, policyMs: 1, semanticMs: 1 },
  decidedAt: AT,
};

describe("decisionRecordOf", () => {
  it("keeps what the record is made of and nothing of the cache or the clock", () => {
    const record = decisionRecordOf({
      decision,
      request,
      evaluations: [
        {
          provider: "fake",
          model: "fake-1",
          role: "primary",
          result: { ok: true, assessment },
          latencyMs: 1.4,
        },
        {
          provider: "local",
          role: "shadow",
          sampledOn: "unresolved",
          result: {
            ok: false,
            error: { kind: "timeout", retryable: true },
          },
          latencyMs: 2_000,
        },
      ],
      resolvedByPolicy: false,
      recordedAt: AT,
    });
    expect(parseDecisionRecord(record).ok).toBe(true);
    expect(record).toMatchObject({
      decisionId: decision.id,
      actionId: decision.actionId,
      contractVersion: `${String(CONTRACT_VERSION.major)}.${String(CONTRACT_VERSION.minor)}`,
      request,
      decision: { effect: "allow", policySetHash: "sha256:abc" },
      labels: [],
    });
    expect(record.evaluations).toEqual([
      {
        provider: "fake",
        model: "fake-1",
        role: "primary",
        latencyMs: 1,
        assessment,
      },
      {
        provider: "local",
        role: "shadow",
        sampledOn: "unresolved",
        latencyMs: 2_000,
        error: { kind: "timeout", retryable: true },
      },
    ]);
    const text = JSON.stringify(record);
    expect(text).not.toContain("canary-cache-key");
    expect(text).not.toContain('latency"');
    expect(text).not.toContain("decidedAt");
  });

  it("labels what policy decided with its source, and nothing else", () => {
    const resolved = decisionRecordOf({
      decision: { ...decision, reasonCodes: ["explicit_allow"] },
      evaluations: [],
      resolvedByPolicy: true,
      recordedAt: AT,
    });
    expect(resolved.labels).toEqual([
      { kind: "effect", value: "allow", source: "deterministic_rule", at: AT },
    ]);
    expect(resolved).not.toHaveProperty("request");
    expect(parseDecisionRecord(resolved).ok).toBe(true);
  });

  // RFX-125: the human's yes is the label, and it is never "deterministic".
  it("labels a human override as the human's, not policy's", () => {
    const overridden = decisionRecordOf({
      decision: {
        ...decision,
        effect: "allow",
        effectiveEffect: "allow",
        reasonCodes: ["human_override", "destructive"],
      },
      evaluations: [],
      resolvedByPolicy: false,
      humanOverride: true,
      recordedAt: AT,
    });
    expect(overridden.labels).toEqual([
      { kind: "effect", value: "allow", source: "human", at: AT },
    ]);
    expect(parseDecisionRecord(overridden).ok).toBe(true);
  });
});

describe("joining an outcome and feedback by id", () => {
  const record = decisionRecordOf({
    decision,
    request,
    evaluations: [],
    resolvedByPolicy: false,
    recordedAt: AT,
  });
  const outcome: ActionOutcome = {
    actionId: decision.actionId,
    prompted: "yes",
    humanResponse: "approved",
    executed: "yes",
    observedAt: "2026-09-25T10:00:05.000Z",
  };
  const feedback: DecisionFeedback = {
    decisionId: decision.id,
    value: "should-deny",
    createdAt: "2026-09-25T11:00:00.000Z",
  };

  it("appends an outcome of the same action with a human label, and refuses another action's", () => {
    const joined = withOutcome(record, outcome);
    expect(joined?.outcome).toEqual(outcome);
    expect(joined?.labels).toEqual([
      {
        kind: "effect",
        value: "allow",
        source: "human",
        at: outcome.observedAt,
      },
    ]);
    expect(parseDecisionRecord(joined).ok).toBe(true);
    expect(
      withOutcome(record, {
        ...outcome,
        actionId: "act_00000000000000000000000000000002",
      }),
    ).toBeUndefined();
  });

  it("appends feedback on the same decision with a human label, and refuses another decision's", () => {
    const joined = withFeedback(record, feedback);
    expect(joined?.feedback).toEqual([feedback]);
    expect(joined?.labels).toEqual([
      {
        kind: "effect",
        value: "deny",
        source: "human",
        at: feedback.createdAt,
      },
    ]);
    expect(parseDecisionRecord(joined).ok).toBe(true);
    const twice = withFeedback(joined ?? record, {
      ...feedback,
      value: "correct",
    });
    expect(twice?.feedback).toHaveLength(2);
    expect(twice?.labels.at(-1)).toMatchObject({
      value: "allow",
      source: "human",
    });
    expect(
      withFeedback(record, {
        ...feedback,
        decisionId: "dec_00000000000000000000000000000002",
      }),
    ).toBeUndefined();
  });

  it("reads the host's own doing as a production outcome, and never labels unknown", () => {
    expect(
      labelsFromOutcome({
        ...outcome,
        prompted: "no",
        humanResponse: "none",
        executed: "yes",
      }),
    ).toEqual([
      {
        kind: "effect",
        value: "allow",
        source: "production_outcome",
        at: outcome.observedAt,
      },
    ]);
    expect(
      labelsFromOutcome({
        ...outcome,
        prompted: "no",
        humanResponse: "none",
        executed: "no",
      }),
    ).toEqual([
      {
        kind: "effect",
        value: "deny",
        source: "production_outcome",
        at: outcome.observedAt,
      },
    ]);
    expect(
      labelsFromOutcome({
        ...outcome,
        prompted: "unknown",
        humanResponse: "unknown",
        executed: "unknown",
      }),
    ).toEqual([]);
    expect(
      labelsFromFeedback({ ...feedback, value: "should-ask" }, "allow"),
    ).toEqual([
      { kind: "effect", value: "ask", source: "human", at: feedback.createdAt },
    ]);
  });
});

describe("DecisionRecordLog", () => {
  let directory: string;
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes records off the path, in order, and reads back only what parses", async () => {
    directory = await mkdtemp(join(tmpdir(), "reflex-records-"));
    const log = new DecisionRecordLog({ directory });
    const record = decisionRecordOf({
      decision,
      request,
      evaluations: [],
      resolvedByPolicy: false,
      recordedAt: AT,
    });
    log.write(record);
    log.write({
      ...record,
      decisionId: "dec_00000000000000000000000000000002",
    });
    await log.flush();
    await writeFile(
      log.activeFile,
      `${await readFile(log.activeFile, "utf8")}{"kind":"not a record"}\n{"decisionId":"dec_x"\n`,
    );
    const recent = await log.readRecent(10);
    expect(recent.map((entry) => entry.decisionId)).toEqual([
      record.decisionId,
      "dec_00000000000000000000000000000002",
    ]);
    expect(log.dropped).toBe(0);
    expect((await stat(log.activeFile)).mode & 0o777).toBe(0o600);
  });

  it("rotates the active file after the retention and removes rotated files past it", async () => {
    // Everything on one fake clock: the log's `now`, and each file's last
    // write, set after every append so that the purge reads the same time.
    directory = await mkdtemp(join(tmpdir(), "reflex-records-age-"));
    const R = DECISION_RECORD_RETENTION_MS;
    let now = Date.parse(AT);
    const log = new RotatingJsonlLog<{ n: number }>(
      {
        directory,
        baseName: "records",
        maxAgeMs: R,
        keepFiles: 3,
        now: () => now,
      },
      (value): value is { n: number } =>
        typeof value === "object" && value !== null && "n" in value,
    );
    const lines = async (file: string) =>
      (await readFile(file, "utf8")).split("\n").filter(Boolean).length;
    const touch = async () => {
      const at = new Date(now);
      await utimes(log.activeFile, at, at);
    };
    await log.append({ n: 1 });
    await touch();
    now += R - 1;
    await log.append({ n: 2 });
    await touch();
    // One millisecond under the retention: the same file.
    expect(await lines(log.activeFile)).toBe(2);
    now += 1;
    await log.append({ n: 3 });
    await touch();
    // At the retention: rotated. The rotated file's last write was a
    // millisecond ago, so it stays.
    const rotated = join(directory, "records.1.jsonl");
    expect(await lines(log.activeFile)).toBe(1);
    expect(await lines(rotated)).toBe(2);
    expect(await log.readRecent(10)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    // A rotation a retention later: the older rotated file is past it and
    // goes; so does the one holding 3, written exactly a retention ago.
    now += R;
    await log.append({ n: 4 });
    await expect(stat(join(directory, "records.2.jsonl"))).rejects.toThrow();
    await expect(stat(rotated)).rejects.toThrow();
    expect(await log.readRecent(10)).toEqual([{ n: 4 }]);
  });
});
