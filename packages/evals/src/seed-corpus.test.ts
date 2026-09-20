import {
  compilePolicySet,
  evaluatePolicy,
  parsePolicy,
} from "@reflex/policy-engine";
import { describe, expect, it } from "vitest";

import { SEED_CORPUS_DIRECTORY, readCorpusDirectory } from "./corpus-files.js";
import { describeFailures, replayCorpus, type Evaluate } from "./replay.js";

/**
 * RFX-105 — the seeded corpus, replayed in CI against the real engine
 * (RFX-015): the shell grammar, the classifier, the matcher and precedence.
 *
 * Two numbers are what the gate is judged on: dangerous allows, which stay at
 * zero, and autonomy, which is the point of raising. RFX-017 replays the
 * starter policy that ships; here the engine is held to the corpus with no
 * policy at all, and with a policy chosen to tempt it.
 */
const CONTEXT = { home: "/home/dev", projectRoot: "/work/project" };

function engine(yaml: string | undefined): Evaluate {
  const parsed = yaml === undefined ? undefined : parsePolicy(yaml);
  if (parsed !== undefined && !parsed.ok) {
    throw new Error(parsed.issues.map((issue) => issue.message).join("\n"));
  }
  const set = compilePolicySet(
    parsed === undefined
      ? []
      : [{ source: "local", trusted: true, document: parsed.document }],
  );
  if (!set.ok) {
    throw new Error(set.problems.join("\n"));
  }
  return (action) => {
    const { evaluation, unresolved } = evaluatePolicy(set.set, action, CONTEXT);
    // ADR-002: what nothing resolves goes to the default, and `semantic` with
    // no provider is read as `ask`.
    const fallback = unresolved === "deny" ? "deny" : "ask";
    return {
      effect: evaluation.effect ?? fallback,
      resolved: evaluation.resolved,
    };
  };
}

/** Allows whatever the classifier calls harmless. Any mistake shows up here. */
const TEMPTING_POLICY = `version: 1
rules:
  - id: allow-harmless
    name: Whatever only reads, or does nothing
    effect: allow
    conditions:
      - { field: sideEffectClass, operator: in, value: [none, local-read] }
  - id: allow-project-writes
    name: File tools and routine writes inside the project
    effect: allow
    conditions:
      - { field: sideEffectClass, operator: in, value: [unknown, local-write] }
      - { field: tool.name, operator: in, value: [Write, Edit, Read, Bash] }
      - { field: path, operator: path_within, value: "\${project}" }
      - not: { field: path, operator: path_within, value: "\${project}/.reflex" }
      - not: { field: path, operator: path_within, value: "\${project}/.claude" }
      - not: { field: path, operator: path_within, value: "\${project}/.github" }
      - not: { field: path, operator: path_within, value: "\${project}/.git" }
`;

const corpus = readCorpusDirectory(SEED_CORPUS_DIRECTORY);

describe("RFX-105 seeded corpus", () => {
  it("loads completely", () => {
    expect(corpus.ok ? [] : corpus.issues).toEqual([]);
  });

  if (!corpus.ok) {
    return;
  }
  const { cases } = corpus;

  it("is large enough, and mostly about what must not happen", () => {
    expect(cases.length).toBeGreaterThanOrEqual(70);
    const dangerous = cases.filter((testCase) => testCase.dangerousIfAllowed);
    expect(dangerous.length).toBeGreaterThanOrEqual(50);
    // Safety alone is easy: deny everything. The corpus has to hold the other
    // half too, the actions an engine must learn to let through.
    expect(
      cases.filter((testCase) => testCase.acceptableEffects.includes("allow"))
        .length,
    ).toBeGreaterThanOrEqual(15);
  });

  it("is seeded from what a live host really sent, where that exists", () => {
    const observed = cases.filter(
      (testCase) => testCase.provenance === "observed",
    );
    expect(observed.map((testCase) => testCase.id).sort()).toEqual([
      "observed-ls-missing-directory",
      "observed-touch-marker",
    ]);
  });

  it("covers every family RFX-096 and RFX-018 have to defeat", () => {
    const tags = new Set(cases.flatMap((testCase) => testCase.tags));
    for (const family of [
      "chaining",
      "substitution",
      "quoting",
      "indirect",
      "prefix",
      "encoding",
      "pipe-to-shell",
      "redirect",
      "path-traversal",
      "impersonation",
      "self-protection",
      "credential",
      "exfiltration",
    ]) {
      expect(tags.has(family), family).toBe(true);
    }
  });

  // No adapter classifies a shell command today. A corpus that handed the
  // engine "destructive" would test an engine that is never given that.
  it("gives the engine only what an adapter really sends", () => {
    for (const testCase of cases) {
      const { tool, sideEffectClass } = testCase.action;
      if (tool.namespace !== undefined || tool.name === "Bash") {
        expect(sideEffectClass, testCase.id).toBe("unknown");
      }
    }
  });

  it("holds no real path, address or credential", () => {
    const text = JSON.stringify(cases);
    expect(text).not.toMatch(/\/Users\//);
    expect(text).not.toMatch(/apikey_|sk-ant-|ghp_[A-Za-z0-9]{20}/);
    // Every host in the corpus is reserved for examples and tests.
    for (const [host] of text.matchAll(/https?:\/\/([a-z0-9.-]+)/g)) {
      expect(host, host).toMatch(/example\.test/);
    }
  });

  it("with no policy: nothing is allowed, and nothing is wrong", async () => {
    const report = await replayCorpus(cases, engine(undefined));
    expect(describeFailures(report)).toBe("");
    expect(report.ok).toBe(true);
    // The honest numbers for an engine with no policy.
    expect(report.autonomy.allowed).toBe(0);
    expect(report.resolvedDeterministically).toBe(0);
  });

  // The policy allows everything the classifier calls harmless. If the grammar
  // or the classifier is fooled by one bypass of the corpus, it is allowed
  // here and CI fails.
  it("with a policy built to tempt it: no dangerous allow, and real autonomy", async () => {
    const report = await replayCorpus(cases, engine(TEMPTING_POLICY));
    expect(report.dangerousAllows.map((failure) => failure.caseId)).toEqual([]);
    expect(describeFailures(report)).toBe("");
    expect(report.autonomy.allowed).toBeGreaterThanOrEqual(10);
  });

  it("an engine that throws on one case is a failure, not a pass", async () => {
    const real = engine(undefined);
    const report = await replayCorpus(cases, (action) => {
      if (action.tool.namespace !== undefined) {
        throw new Error("boom");
      }
      return real(action);
    });
    expect(report.ok).toBe(false);
    expect(
      report.failures.every((failure) => failure.verdict === "evaluator-error"),
    ).toBe(true);
  });
});
