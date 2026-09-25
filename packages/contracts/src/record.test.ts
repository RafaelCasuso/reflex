import { describe, expect, it } from "vitest";

import {
  loadFixture,
  summarize,
  valueOf,
  withValue,
  without,
} from "./fixtures.test-support.js";
import { parseDecisionRecord } from "./index.js";

/**
 * RFX-143 — the decision record (ADR-016 §4). Strict, joined by id, and
 * every label with a source. Adversarial: the ways a record could carry a
 * label nobody vouched for, or another action's outcome, all fail to parse.
 */
const VERSION = "v1.3";
/** Issue paths write array indices in brackets: `labels[0].source`. */
const pathOf = (segments: readonly string[]): string =>
  segments
    .reduce(
      (path, segment) =>
        /^\d+$/.test(segment) ? `${path}[${segment}]` : `${path}.${segment}`,
      "",
    )
    .slice(1);
const full = () => loadFixture("decision-record.full.json", VERSION);
const minimal = () => loadFixture("decision-record.minimal.json", VERSION);

describe("parseDecisionRecord", () => {
  it("parses the frozen records unchanged", () => {
    for (const file of [
      "decision-record.full.json",
      "decision-record.minimal.json",
      "decision-record.deterministic.json",
    ]) {
      const wire = loadFixture(file, VERSION);
      expect(valueOf(parseDecisionRecord(wire))).toStrictEqual(wire);
    }
  });

  it("refuses a label without a source, or with one it does not know", () => {
    const labels = full().labels as Record<string, unknown>[];
    const first = labels[0] ?? {};
    const unsourced = { ...first };
    delete unsourced.source;
    expect(
      summarize(
        parseDecisionRecord(withValue(full(), ["labels"], [unsourced])),
      ),
    ).toEqual(["missing_field:labels[0].source"]);
    expect(
      summarize(
        parseDecisionRecord(
          withValue(full(), ["labels"], [{ ...first, source: "guess" }]),
        ),
      ),
    ).toEqual(["invalid_value:labels[0].source"]);
    expect(
      summarize(
        parseDecisionRecord(
          withValue(full(), ["labels"], [{ ...first, source: "" }]),
        ),
      ),
    ).toEqual(["invalid_value:labels[0].source"]);
  });

  it("refuses a label of a kind it does not know, and a dimension it does not know", () => {
    const at = "2026-09-18T10:15:31.430Z";
    expect(
      parseDecisionRecord(
        withValue(
          full(),
          ["labels"],
          [{ kind: "verdict", value: "allow", source: "human", at }],
        ),
      ).ok,
    ).toBe(false);
    expect(
      parseDecisionRecord(
        withValue(
          full(),
          ["labels"],
          [
            {
              kind: "dimension",
              dimension: "blastRadius",
              value: 10,
              source: "llm_teacher",
              at,
            },
          ],
        ),
      ).ok,
    ).toBe(false);
  });

  it("holds a dimension label to the dimension's own type", () => {
    const at = "2026-09-18T10:15:31.430Z";
    const flagAsScore = {
      kind: "dimension",
      dimension: "externalSideEffect",
      value: 100,
      source: "llm_teacher",
      at,
    };
    const scoreAsFlag = {
      kind: "dimension",
      dimension: "destructiveRisk",
      value: true,
      source: "llm_teacher",
      at,
    };
    expect(
      summarize(
        parseDecisionRecord(withValue(full(), ["labels"], [flagAsScore])),
      ),
    ).toEqual(["invalid_type:labels[0].value"]);
    expect(
      summarize(
        parseDecisionRecord(withValue(full(), ["labels"], [scoreAsFlag])),
      ),
    ).toEqual(["invalid_type:labels[0].value"]);
    expect(
      parseDecisionRecord(
        withValue(full(), ["labels"], [{ ...scoreAsFlag, value: 101 }]),
      ).ok,
    ).toBe(false);
  });

  it("refuses an evaluation with both an assessment and an error, or neither", () => {
    const evaluations = full().evaluations as Record<string, unknown>[];
    const assessed = evaluations[0] ?? {};
    const failed = evaluations[1] ?? {};
    const both = { ...assessed, error: failed.error };
    expect(
      summarize(
        parseDecisionRecord(withValue(full(), ["evaluations"], [both])),
      ),
    ).toEqual(["invalid_value:evaluations[0].error"]);
    const neither = { ...assessed };
    delete neither.assessment;
    expect(
      summarize(
        parseDecisionRecord(withValue(full(), ["evaluations"], [neither])),
      ),
    ).toEqual(["missing_field:evaluations[0].assessment"]);
  });

  it("refuses a partial assessment inside an evaluation, as the assessment parser does", () => {
    expect(
      parseDecisionRecord(
        without(full(), ["evaluations", "0", "assessment", "secretAccess"]),
      ).ok,
    ).toBe(false);
    expect(
      parseDecisionRecord(
        withValue(full(), ["evaluations", "1", "error", "kind"], "exploded"),
      ).ok,
    ).toBe(false);
  });

  it("refuses an outcome of another action and feedback on another decision", () => {
    expect(
      summarize(
        parseDecisionRecord(
          withValue(
            full(),
            ["outcome", "actionId"],
            "act_01J8ZC2N6Q4T7V9X3B5D8F0H2Z",
          ),
        ),
      ),
    ).toEqual(["invalid_value:outcome.actionId"]);
    expect(
      summarize(
        parseDecisionRecord(
          withValue(
            full(),
            ["feedback", "0", "decisionId"],
            "dec_01J8ZC2P0R3S5U7W9Y1A3C5E7Z",
          ),
        ),
      ),
    ).toEqual(["invalid_value:feedback[0].decisionId"]);
  });

  it("is strict at every level: an unknown key anywhere is refused", () => {
    for (const path of [
      ["extra"],
      ["decision", "extra"],
      ["request", "action", "cwd"],
      ["request", "action", "adapterMetadata"],
      ["evaluations", "0", "rawResponse"],
      ["labels", "0", "note"],
    ]) {
      const result = parseDecisionRecord(withValue(full(), path, "x"));
      expect(result.ok, path.join(".")).toBe(false);
      expect(summarize(result), path.join(".")).toEqual([
        `unrecognized_field:${pathOf(path)}`,
      ]);
    }
  });

  it("refuses a request that carries what a provider is never given", () => {
    // The request is what was sent, selected by name (ADR-001 §3): identity,
    // tenancy, working directory and adapter metadata are not among them.
    for (const key of ["id", "agent", "sessionId", "organizationId"]) {
      expect(
        parseDecisionRecord(withValue(full(), ["request", "action", key], "x"))
          .ok,
        key,
      ).toBe(false);
    }
  });

  it("refuses a contract version that is not MAJOR.MINOR, and an unknown effect", () => {
    for (const version of ["1", "v1.3", "1.3.0", "", "latest"]) {
      expect(
        parseDecisionRecord(withValue(minimal(), ["contractVersion"], version))
          .ok,
        version,
      ).toBe(false);
    }
    expect(
      parseDecisionRecord(withValue(minimal(), ["decision", "effect"], "maybe"))
        .ok,
    ).toBe(false);
  });

  it("keeps a minimal record minimal: nothing optional is invented", () => {
    const parsed = valueOf(parseDecisionRecord(minimal()));
    expect(parsed).not.toHaveProperty("request");
    expect(parsed).not.toHaveProperty("outcome");
    expect(parsed).not.toHaveProperty("feedback");
    expect(parsed.decision).not.toHaveProperty("fallback");
  });
});
