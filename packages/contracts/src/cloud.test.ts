import { describe, expect, it } from "vitest";

import {
  CLAIM_CODE_FORM,
  CLOUD_KEY_FORM,
  CONTRACT_VERSION,
  isOpaqueId,
  parseClaimRequest,
  parseClaimResult,
  parseDecisionSummary,
  parseIngestRequest,
  parseIngestResult,
} from "./index.js";
import {
  loadFixture,
  summarize,
  valueOf,
  withValue,
  without,
  type JsonRecord,
} from "./fixtures.test-support.js";

/**
 * ADR-019 — the control plane's wire contracts (v1.6).
 *
 * A summary is a decision by name. The adversarial cases below are the ways
 * action content could ride along to the control plane inside one: as a
 * field the summary does not have, inside the action summary, as a path
 * where a name is expected, or as a record of another decision.
 */
const VERSION = `v${String(CONTRACT_VERSION.major)}.${String(CONTRACT_VERSION.minor)}`;
const load = (file: string): JsonRecord => loadFixture(file, VERSION);

describe("ADR-019 decision summary", () => {
  it("parses the full and the minimal fixtures unchanged", () => {
    for (const file of [
      "decision-summary.full.json",
      "decision-summary.minimal.json",
    ]) {
      const wire = load(file);
      expect(valueOf(parseDecisionSummary(wire))).toStrictEqual(wire);
    }
  });

  it("needs the tenancy ids: an unclaimed decision has no summary", () => {
    expect(
      summarize(
        parseDecisionSummary(
          without(load("decision-summary.minimal.json"), ["projectId"]),
        ),
      ),
    ).toEqual(["missing_field:projectId"]);
    expect(
      summarize(
        parseDecisionSummary(
          without(load("decision-summary.minimal.json"), ["agentId"]),
        ),
      ),
    ).toEqual(["missing_field:agentId"]);
  });

  // Adversarial: action content has no field to travel in.
  it.each([
    ["arguments at the top", ["arguments"], { command: "cat ~/.ssh/id_rsa" }],
    ["arguments inside the action", ["action", "arguments"], { x: 1 }],
    ["a working directory", ["action", "cwd"], "/Users/someone/secret"],
    ["paths", ["action", "paths"], ["/etc/passwd"]],
    ["the user's objective", ["action", "userObjective"], "do the thing"],
    ["the request", ["request"], { action: {} }],
    ["the repository root", ["action", "root"], "/home/u/repo"],
  ])("refuses %s", (_label, path, value) => {
    const result = parseDecisionSummary(
      withValue(load("decision-summary.full.json"), path, value),
    );
    expect(result.ok).toBe(false);
    expect(summarize(result)).toEqual([`unrecognized_field:${path.join(".")}`]);
  });

  it("refuses a branch or a remote host that is not a name", () => {
    expect(
      summarize(
        parseDecisionSummary(
          withValue(
            load("decision-summary.full.json"),
            ["action", "branch"],
            "main\n--token=abc",
          ),
        ),
      ),
    ).toEqual(["invalid_format:action.branch"]);
  });

  it("closes the enforcement vocabulary", () => {
    expect(
      parseDecisionSummary(
        withValue(load("decision-summary.full.json"), ["effect"], "maybe"),
      ).ok,
    ).toBe(false);
    expect(
      parseDecisionSummary(
        withValue(
          load("decision-summary.full.json"),
          ["reasonCodes"],
          ["made_up"],
        ),
      ).ok,
    ).toBe(false);
  });
});

describe("ADR-019 ingest request", () => {
  it("parses the full fixture unchanged, with every kind of entry", () => {
    const wire = load("ingest-request.full.json");
    const parsed = valueOf(parseIngestRequest(wire));
    expect(parsed).toStrictEqual(wire);
    expect(parsed.entries.map((entry) => entry.kind)).toEqual([
      "decision",
      "decision",
      "outcome",
      "feedback",
    ]);
  });

  it("accepts an empty batch", () => {
    expect(
      valueOf(parseIngestRequest(load("ingest-request.minimal.json"))).entries,
    ).toEqual([]);
  });

  it("refuses an entry of an unknown kind rather than keeping it", () => {
    const result = parseIngestRequest(
      withValue(
        load("ingest-request.full.json"),
        ["entries", "1", "kind"],
        "note",
      ),
    );
    expect(result.ok).toBe(false);
  });

  // Adversarial: a record of another decision cannot be smuggled under a
  // summary, and a summary cannot be given another decision's record.
  it("refuses a record that is not the summary's own decision", () => {
    const wire = load("ingest-request.full.json");
    const result = parseIngestRequest(
      withValue(
        wire,
        ["entries", "0", "summary", "decisionId"],
        "dec_01J8ZC2P0R3S5U7W9Y1A3C5E7J",
      ),
    );
    expect(result.ok).toBe(false);
    expect(summarize(result)).toContain(
      "invalid_value:entries[0].record.decisionId",
    );
  });

  it("refuses a record whose request carries something the summary cannot", () => {
    // The record's request is the redacted one of ADR-006; its schema is
    // the record's, unchanged, so what the record refuses is refused here.
    const result = parseIngestRequest(
      withValue(
        load("ingest-request.full.json"),
        ["entries", "0", "record", "request", "action", "cwd"],
        "/home/u",
      ),
    );
    expect(summarize(result)).toEqual([
      "unrecognized_field:entries[0].record.request.action.cwd",
    ]);
  });

  it("refuses an outcome that contradicts itself, as the record does", () => {
    const result = parseIngestRequest(
      withValue(
        load("ingest-request.full.json"),
        ["entries", "2", "outcome", "prompted"],
        "no",
      ),
    );
    expect(result.ok).toBe(false);
  });

  it("bounds a batch", () => {
    const wire = load("ingest-request.full.json");
    const entry = (wire.entries as unknown[])[1];
    const result = parseIngestRequest({
      ...wire,
      entries: Array.from({ length: 501 }, () => entry),
    });
    expect(summarize(result)).toEqual(["out_of_range:entries"]);
  });
});

describe("ADR-019 ingest result", () => {
  it("parses the fixture and ignores what it does not know", () => {
    const wire = load("ingest-result.json");
    expect(valueOf(parseIngestResult(wire))).toStrictEqual(wire);
    expect(
      valueOf(parseIngestResult({ ...wire, quotaLeft: 12 })),
    ).toStrictEqual(wire);
  });

  it("refuses a rejection reason it does not know: it is not dropped silently", () => {
    // A daemon that does not understand why an entry was refused must not
    // read the answer as success and move its cursor past it blindly.
    expect(
      parseIngestResult(
        withValue(load("ingest-result.json"), ["rejected", "0", "reason"], "?"),
      ).ok,
    ).toBe(false);
  });
});

describe("ADR-019 claim request", () => {
  it("parses the fixture unchanged", () => {
    const wire = load("claim-request.json");
    expect(valueOf(parseClaimRequest(wire))).toStrictEqual(wire);
  });

  it.each(["RFX-7K3M-9PQ2-X4ZB", "rfx-7k3m-9pq2-x4zb", "RFX7K3M9PQ2X4ZB"])(
    "accepts the code form %s, case and dashes forgiven",
    (code) => {
      expect(CLAIM_CODE_FORM.test(code)).toBe(true);
      expect(
        parseClaimRequest(withValue(load("claim-request.json"), ["code"], code))
          .ok,
      ).toBe(true);
    },
  );

  it.each(["", "RFX-7K3M-9PQ2", "RFX-7K3M-9PQ2-X4ZB-EXTRA", "https://x/claim"])(
    "refuses %j as a code",
    (code) => {
      expect(
        parseClaimRequest(withValue(load("claim-request.json"), ["code"], code))
          .ok,
      ).toBe(false);
    },
  );

  // Adversarial: a claim names an installation and a project, nothing else.
  it.each([
    ["a working directory", ["project", "cwd"], "/Users/someone/repo"],
    ["an email", ["agent", "email"], "someone@example.com"],
    ["a hostname", ["hostname"], "laptop.local"],
  ])("refuses %s", (_label, path, value) => {
    expect(
      summarize(
        parseClaimRequest(withValue(load("claim-request.json"), path, value)),
      ),
    ).toEqual([`unrecognized_field:${path.join(".")}`]);
  });

  it("knows the hosts it is told, and no other", () => {
    expect(
      parseClaimRequest(
        withValue(
          load("claim-request.json"),
          ["hosts"],
          ["claude-code", "vim"],
        ),
      ).ok,
    ).toBe(false);
  });
});

describe("ADR-019 claim result", () => {
  it("parses the fixture, keeps the project id that was sent, and is tolerant", () => {
    const wire = load("claim-result.json");
    const parsed = valueOf(parseClaimResult(wire));
    expect(parsed).toStrictEqual(wire);
    expect(parsed.project.id).toBe(
      (load("claim-request.json").project as { id: string }).id,
    );
    expect(valueOf(parseClaimResult({ ...wire, plan: "team" }))).toStrictEqual(
      wire,
    );
  });

  it("refuses a key that is not of the documented form", () => {
    for (const secret of [
      "rfk_key_0123456789abcdef",
      "sk-live-0123456789ab",
      "rfk_key_0123456789abcdef_short",
      "",
    ]) {
      expect(CLOUD_KEY_FORM.test(secret)).toBe(false);
      expect(
        parseClaimResult(
          withValue(load("claim-result.json"), ["key", "secret"], secret),
        ).ok,
      ).toBe(false);
    }
  });

  it("types the key id with its own prefix", () => {
    const parsed = valueOf(parseClaimResult(load("claim-result.json")));
    expect(isOpaqueId("key", parsed.key.id)).toBe(true);
    expect(isOpaqueId("agt", parsed.key.id)).toBe(false);
  });

  it("refuses a scope it does not know", () => {
    expect(
      parseClaimResult(
        withValue(load("claim-result.json"), ["key", "scope"], "root"),
      ).ok,
    ).toBe(false);
  });
});
