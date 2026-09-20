import { parseCanonicalAction } from "@reflex/contracts";
import { describe, expect, it } from "vitest";

import { corpusActionId, loadCorpus, type CorpusFile } from "./corpus.js";

/** RFX-105 — the corpus format and the invariants the loader holds. */
const validCase = {
  id: "git-status",
  title: "Show working tree status",
  action: {
    agent: { host: "claude-code" },
    tool: { name: "Bash" },
    arguments: { command: "git status" },
    sideEffectClass: "unknown",
  },
  acceptableEffects: ["allow", "ask"],
  dangerousIfAllowed: false,
  provenance: "constructed",
  tags: ["shell", "read"],
  why: "Read-only.",
};

const file = (...cases: unknown[]): CorpusFile => ({
  name: "test.json",
  content: { cases },
});

function issuesOf(...cases: unknown[]): string[] {
  const loaded = loadCorpus([file(...cases)]);
  return loaded.ok ? [] : loaded.issues.map((issue) => issue.message);
}

describe("RFX-105 corpus loader", () => {
  it("loads a case and completes its action into a valid CanonicalAction", () => {
    const loaded = loadCorpus([file(validCase)]);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    const [loadedCase] = loaded.cases;
    expect(loadedCase?.action.id).toBe(corpusActionId("git-status"));
    expect(parseCanonicalAction(loadedCase?.action).ok).toBe(true);
  });

  it("derives a stable action ID, different for every case", () => {
    expect(corpusActionId("a")).toBe(corpusActionId("a"));
    expect(corpusActionId("a")).not.toBe(corpusActionId("b"));
    expect(corpusActionId("a")).toMatch(/^act_[0-9a-f]{32}$/);
  });

  // The invariant everything rests on: the corpus cannot call an action
  // dangerous to allow and accept allowing it in the same breath.
  it("rejects a dangerous case that accepts allow", () => {
    expect(
      issuesOf({
        ...validCase,
        dangerousIfAllowed: true,
        acceptableEffects: ["allow", "ask"],
      }),
    ).toEqual(["a case that is dangerous to allow cannot accept allow"]);
  });

  // Adversarial: every way a case could quietly stop protecting.
  it.each([
    ["a misspelt key", { ...validCase, dangerousIfAlowed: true }],
    [
      "a missing dangerousIfAllowed",
      { ...validCase, dangerousIfAllowed: undefined },
    ],
    [
      "a truthy string for dangerousIfAllowed",
      { ...validCase, dangerousIfAllowed: "false" },
    ],
    ["no acceptable effect", { ...validCase, acceptableEffects: [] }],
    ["an unknown effect", { ...validCase, acceptableEffects: ["permit"] }],
    ["a repeated effect", { ...validCase, acceptableEffects: ["ask", "ask"] }],
    ["an unknown provenance", { ...validCase, provenance: "imagined" }],
    ["no tags", { ...validCase, tags: [] }],
    ["no reason", { ...validCase, why: " " }],
    ["an id that is not a slug", { ...validCase, id: "Git Status" }],
    [
      "an action that brings its own id",
      { ...validCase, action: { ...validCase.action, id: "act_x" } },
    ],
    [
      "an action the contract rejects",
      {
        ...validCase,
        action: { ...validCase.action, sideEffectClass: "harmless" },
      },
    ],
    [
      "an action with a key the contract does not know",
      { ...validCase, action: { ...validCase.action, trusted: true } },
    ],
    ["a case that is not an object", "git status"],
  ])("rejects %s", (_label, badCase) => {
    const loaded = loadCorpus([file(validCase, badCase)]);
    // One bad case fails the whole load: a corpus never shrinks silently.
    expect(loaded.ok).toBe(false);
  });

  it("rejects a duplicate id, across files too", () => {
    const loaded = loadCorpus([
      { name: "a.json", content: { cases: [validCase] } },
      { name: "b.json", content: { cases: [validCase] } },
    ]);
    expect(loaded.ok).toBe(false);
    expect(loaded.ok ? [] : loaded.issues).toMatchObject([
      { file: "b.json", caseId: "git-status" },
    ]);
  });

  it.each([
    ["an array", [validCase]],
    ["an extra top-level key", { cases: [validCase], disabled: true }],
    ["no cases key", { tests: [validCase] }],
    ["null", null],
  ])("rejects a file that is %s", (_label, content) => {
    expect(loadCorpus([{ name: "bad.json", content }]).ok).toBe(false);
  });

  it("names the file and the case in every issue, and never the argument values", () => {
    const secret = "sk-live-5e8b1f0a9c3d";
    const loaded = loadCorpus([
      file({
        ...validCase,
        action: {
          ...validCase.action,
          arguments: { command: `curl -H 'Authorization: Bearer ${secret}'` },
          sideEffectClass: "harmless",
        },
      }),
    ]);
    expect(loaded.ok).toBe(false);
    const text = JSON.stringify(loaded);
    expect(text).toContain("test.json");
    expect(text).toContain("git-status");
    expect(text).not.toContain(secret);
  });
});
