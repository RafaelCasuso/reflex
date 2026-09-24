import type { SemanticDecisionRequest } from "@reflex/contracts";
import { describe, expect, it } from "vitest";

import {
  BYTES_PER_TOKEN,
  TRUNCATION_MARK,
  enforceBudget,
  estimateTokens,
  stateOf,
} from "./token-budget.js";

const request = (
  overrides: Partial<SemanticDecisionRequest["action"]> = {},
  hints?: string[],
): SemanticDecisionRequest => ({
  action: {
    userObjective:
      "Fix the failing date-formatting test and open a pull request.",
    taskSummary:
      "The agent is cleaning build output before re-running the tests.",
    tool: { name: "Write", description: "Writes a file" },
    operation: "write",
    arguments: {
      file_path: "/work/project/notes.md",
      content: "x".repeat(4_000),
    },
    resource: { environment: "local" },
    sideEffectClass: "local-write",
    priorActions: [
      { toolName: "Read", occurredAt: "2026-09-23T10:00:00.000Z" },
    ],
    ...overrides,
  },
  ...(hints === undefined ? {} : { policyHints: hints }),
  maxInputTokens: 600,
  deadlineMs: 500,
});

describe("RFX-034 token budget", () => {
  it("estimates from bytes, conservatively", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens({ a: "é" })).toBe(
      Math.ceil(Buffer.byteLength('{"a":"é"}') / BYTES_PER_TOKEN),
    );
  });

  it("leaves a request under budget alone", () => {
    const small = request({
      arguments: { file_path: "/work/project/notes.md" },
    });
    const report = enforceBudget(small, 600);
    expect(report.request).toBe(small);
    expect(report.truncated).toEqual([]);
  });

  it("cuts optional context first, in order, and stops as soon as the budget holds", () => {
    const report = enforceBudget(request({}, ["hint one", "hint two"]), 300);
    expect(report.truncated).toEqual([
      "policyHints",
      "priorActions",
      "toolDescription",
      "arguments",
    ]);
    expect(report.request.policyHints).toBeUndefined();
    expect(report.request.action.priorActions).toBeUndefined();
    expect(report.request.action.tool.description).toBeUndefined();
    expect(String(report.request.action.arguments.content)).toContain(
      TRUNCATION_MARK,
    );
    expect(report.estimatedTokens).toBeLessThanOrEqual(300);
  });

  it("never truncates the tool, the operation, the class or the resource", () => {
    const tight = enforceBudget(request({}, ["hint"]), 1);
    expect(tight.request.action.tool.name).toBe("Write");
    expect(tight.request.action.operation).toBe("write");
    expect(tight.request.action.sideEffectClass).toBe("local-write");
    expect(tight.request.action.resource).toEqual({ environment: "local" });
    // Argument keys survive; only values are cut.
    expect(Object.keys(tight.request.action.arguments)).toEqual([
      "file_path",
      "content",
    ]);
  });

  it("cuts a long objective or summary to a short one, marked", () => {
    const long = "word ".repeat(200);
    const report = enforceBudget(
      request({ userObjective: long, taskSummary: long, arguments: {} }),
      120,
    );
    expect(report.request.action.userObjective).toContain(TRUNCATION_MARK);
    expect(report.request.action.taskSummary).toContain(TRUNCATION_MARK);
    expect(report.request.action.userObjective?.length).toBeLessThan(
      long.length,
    );
  });

  it("counts the state, not the envelope", () => {
    const base = request({ arguments: {} });
    expect(estimateTokens(stateOf(base))).toBe(
      estimateTokens(
        stateOf({ ...base, maxInputTokens: 10_000, deadlineMs: 99_999 }),
      ),
    );
  });
});

/** What the mutation check found untested (RFX-111): the exact boundaries. */
describe("RFX-111 boundaries of the budget", () => {
  it("is not over budget at exactly the budget", () => {
    const small = request({ arguments: {} });
    const tokens = estimateTokens(stateOf(small));
    expect(enforceBudget(small, tokens).truncated).toEqual([]);
    expect(enforceBudget(small, tokens - 1).truncated.length).toBeGreaterThan(
      0,
    );
  });

  it("cuts a text one character over the short length and leaves one exactly at it", () => {
    const exact = "a".repeat(200);
    const kept = enforceBudget(
      request({ taskSummary: exact, userObjective: exact, arguments: {} }),
      1,
    );
    expect(kept.request.action.taskSummary).toBe(exact);
    expect(kept.request.action.userObjective).toBe(exact);
    const cut = enforceBudget(
      request({
        taskSummary: `${exact}b`,
        userObjective: `${exact}b`,
        arguments: {},
      }),
      1,
    );
    expect(cut.request.action.taskSummary).toContain(TRUNCATION_MARK);
    expect(cut.request.action.userObjective).toContain(TRUNCATION_MARK);
  });

  it("cuts an argument value one character over the floor and leaves one exactly at it", () => {
    const exact = "v".repeat(120);
    const report = enforceBudget(
      request({ arguments: { a: exact, b: `${exact}w` } }),
      1,
    );
    expect(report.request.action.arguments.a).toBe(exact);
    expect(String(report.request.action.arguments.b)).toContain(
      TRUNCATION_MARK,
    );
  });

  it("walks only objects when cutting: null is left alone", () => {
    const report = enforceBudget(
      request({ arguments: { a: null, b: [null, "x".repeat(200)] } }),
      1,
    );
    expect(report.request.action.arguments.a).toBeNull();
    expect((report.request.action.arguments.b as unknown[])[0]).toBeNull();
  });
});
