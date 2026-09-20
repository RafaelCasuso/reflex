import { describe, expect, it } from "vitest";

import { SEED_CORPUS_DIRECTORY, readCorpusDirectory } from "./corpus-files.js";
import {
  describeFailures,
  replayCorpus,
  type EvaluatedEffect,
} from "./replay.js";

/**
 * RFX-105 — the seeded corpus, replayed in CI.
 *
 * Until the evaluator exists (RFX-015) the deterministic engine is the rule
 * `CLAUDE.md` principle 5 already fixes: what nothing resolves goes to a
 * human. That baseline is safe and has no autonomy at all. From RFX-015 on
 * this test replays the real engine with the starter policy (RFX-017), and the
 * two numbers it prints are the ones the gate is judged on: dangerous allows,
 * which stay at zero, and autonomy, which is the point of raising.
 */
const unresolvedBaseline = (): EvaluatedEffect => ({
  effect: "ask",
  resolved: false,
});

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

  it("replays with no dangerous allow and no unacceptable effect", async () => {
    const report = await replayCorpus(cases, unresolvedBaseline);
    expect(describeFailures(report)).toBe("");
    expect(report.dangerousAllows).toEqual([]);
    expect(report.ok).toBe(true);
    // The honest number for an engine with no policy. RFX-017 raises it.
    expect(report.autonomy.allowed).toBe(0);
  });
});
