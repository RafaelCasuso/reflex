import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import {
  DECISION_EFFECTS,
  ENVIRONMENT_KINDS,
  FAILURE_MODES,
  REFLEX_MODES,
  SIDE_EFFECT_CLASSES,
  type DecisionEffect,
  type EnvironmentKind,
  type FailureMode,
  type ReflexMode,
  type SideEffectClass,
} from "./index.js";
import {
  confidenceSchema,
  durationMsSchema,
  hashSchema,
  nameSchema,
  pathSchema,
  scoreSchema,
  timestampSchema,
} from "./internal/schemas.js";

const accepts = (schema: z.ZodType, value: unknown): boolean =>
  schema.safeParse(value).success;

/** RFX-006 — modes, effects, risk/confidence primitives. */
describe("RFX-006 vocabulary", () => {
  it("derives each union from its runtime tuple, so they cannot drift", () => {
    expectTypeOf<DecisionEffect>().toEqualTypeOf<"allow" | "ask" | "deny">();
    expectTypeOf<ReflexMode>().toEqualTypeOf<
      "observe" | "assist" | "autopilot"
    >();
    expectTypeOf<FailureMode>().toEqualTypeOf<
      "fail-open" | "fail-ask" | "fail-closed"
    >();
    expectTypeOf<
      (typeof ENVIRONMENT_KINDS)[number]
    >().toEqualTypeOf<EnvironmentKind>();
    expectTypeOf<
      (typeof SIDE_EFFECT_CLASSES)[number]
    >().toEqualTypeOf<SideEffectClass>();

    expect(DECISION_EFFECTS).toEqual(["allow", "ask", "deny"]);
    expect(REFLEX_MODES).toEqual(["observe", "assist", "autopilot"]);
    expect(FAILURE_MODES).toEqual(["fail-open", "fail-ask", "fail-closed"]);
  });

  it("keeps `unknown` available wherever an adapter may not know", () => {
    expect(ENVIRONMENT_KINDS).toContain("unknown");
    expect(SIDE_EFFECT_CLASSES).toContain("unknown");
  });

  it("uses lowercase string literals for every public enum member", () => {
    const members = [
      ...DECISION_EFFECTS,
      ...REFLEX_MODES,
      ...FAILURE_MODES,
      ...ENVIRONMENT_KINDS,
      ...SIDE_EFFECT_CLASSES,
    ];
    for (const member of members) {
      expect(member).toMatch(/^[a-z]+(?:[-_][a-z]+)*$/);
    }
  });
});

describe("RFX-006 risk: integer 0..100", () => {
  it.each([0, 1, 50, 100])("accepts %d", (value) => {
    expect(accepts(scoreSchema, value)).toBe(true);
  });

  // Adversarial: a risk that fails to parse as a number must never be read as
  // "no risk".
  it.each([
    ["below range", -1],
    ["above range", 101],
    ["a fraction", 50.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a numeric string", "50"],
    ["null", null],
    ["a boolean", true],
    ["a confidence-scale value mistaken for risk", 0.9],
  ])("rejects %s", (_label, value) => {
    expect(accepts(scoreSchema, value)).toBe(false);
  });
});

describe("RFX-006 confidence: float 0..1", () => {
  it.each([0, 0.5, 0.999, 1])("accepts %d", (value) => {
    expect(accepts(confidenceSchema, value)).toBe(true);
  });

  it.each([
    ["below range", -0.01],
    ["above range", 1.01],
    ["a risk-scale value mistaken for confidence", 90],
    ["NaN", Number.NaN],
    ["a numeric string", "0.5"],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(accepts(confidenceSchema, value)).toBe(false);
  });
});

describe("RFX-006 durations: non-negative integer milliseconds", () => {
  it.each([0, 1, 400, 86_400_000])("accepts %d", (value) => {
    expect(accepts(durationMsSchema, value)).toBe(true);
  });

  it.each([-1, 0.4, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects %d",
    (value) => {
      expect(accepts(durationMsSchema, value)).toBe(false);
    },
  );
});

describe("RFX-006 timestamps: ISO 8601 UTC", () => {
  it.each([
    "2026-09-18T10:15:30Z",
    "2026-09-18T10:15:30.250Z",
    "2028-02-29T00:00:00Z",
  ])("accepts %s", (value) => {
    expect(accepts(timestampSchema, value)).toBe(true);
  });

  it.each([
    ["a local offset", "2026-09-18T12:15:30+02:00"],
    ["no zone", "2026-09-18T10:15:30"],
    ["a lower-case z", "2026-09-18T10:15:30z"],
    ["a space separator", "2026-09-18 10:15:30Z"],
    ["date only", "2026-09-18"],
    ["an impossible date", "2026-02-30T10:15:30Z"],
    ["a leap day in a common year", "2026-02-29T00:00:00Z"],
    ["hour 24", "2026-09-18T24:00:00Z"],
    ["epoch milliseconds", 1_789_726_530_000],
    ["trailing garbage", "2026-09-18T10:15:30Z; DROP TABLE decisions"],
    ["an absurdly long fraction", `2026-09-18T10:15:30.${"1".repeat(100)}Z`],
  ])("rejects %s", (_label, value) => {
    expect(accepts(timestampSchema, value)).toBe(false);
  });
});

describe("RFX-006 strings used as match keys and labels", () => {
  it.each([
    "Bash",
    "create_pull_request",
    "mcp__github__create_issue",
    "fix/date-parser",
    "日本語",
  ])("accepts the name %s", (value) => {
    expect(accepts(nameSchema, value)).toBe(true);
  });

  // Adversarial: a second spelling of a tool name that an explicit deny rule
  // written for the first spelling would not match.
  it.each([
    ["empty", ""],
    ["leading space", " Bash"],
    ["trailing space", "Bash "],
    ["trailing newline", "Bash\n"],
    ["embedded tab", "Ba\tsh"],
    ["embedded NUL", "Ba\0sh"],
    ["ANSI escape", "\x1b[2KBash"],
    ["C1 control", `Bash${String.fromCodePoint(0x85)}`],
    ["line separator", `Bash${String.fromCodePoint(0x2028)}`],
    ["paragraph separator", `Bash${String.fromCodePoint(0x2029)}`],
    ["too long", "a".repeat(257)],
    ["not a string", 42],
  ])("rejects a name with %s", (_label, value) => {
    expect(accepts(nameSchema, value)).toBe(false);
  });

  it("bounds paths and forbids control characters in them", () => {
    expect(accepts(pathSchema, "/Users/dev/my project/src")).toBe(true);
    expect(accepts(pathSchema, "")).toBe(false);
    expect(accepts(pathSchema, "/tmp/a\nb")).toBe(false);
    expect(accepts(pathSchema, "a".repeat(4_097))).toBe(false);
  });

  it("restricts hashes and cache keys to inert characters", () => {
    expect(accepts(hashSchema, "sha256:9f86d081884c7d65")).toBe(true);
    expect(accepts(hashSchema, "prj_demo:3a7bd3e2")).toBe(true);
    expect(accepts(hashSchema, "abc def")).toBe(false);
    expect(accepts(hashSchema, "abc\ndef")).toBe(false);
    expect(accepts(hashSchema, "")).toBe(false);
  });
});
