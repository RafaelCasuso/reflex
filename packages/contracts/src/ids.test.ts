import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ID_BODY_MAX_LENGTH,
  ID_PREFIXES,
  isOpaqueId,
  type ActionId,
  type AgentId,
  type DecisionId,
  type IdPrefix,
  type OrganizationId,
  type PolicyId,
  type ProjectId,
  type SessionId,
} from "./index.js";

/** RFX-006 — type tests prevent accidental cross-ID assignment. */
describe("RFX-006 opaque IDs: compile-time separation", () => {
  it("rejects assigning one kind of ID to another", () => {
    const decisionId: DecisionId = "dec_01J8ZC2P0R3S5U7W9Y1A3C5E7G";

    // @ts-expect-error -- a decision ID is not an action ID
    const crossAssigned: ActionId = decisionId;
    // @ts-expect-error -- the prefix is part of the type
    const wrongPrefix: ActionId = "dec_01J8ZC2P0R3S5U7W9Y1A3C5E7G";
    const fromTheWire: string = JSON.stringify("act_123").slice(1, -1);
    // @ts-expect-error -- an unvalidated string is not an ID
    const unvalidated: ActionId = fromTheWire;

    expect([crossAssigned, wrongPrefix, unvalidated]).toHaveLength(3);
  });

  it("rejects passing the wrong kind of ID to a function", () => {
    const recordFeedback = (id: DecisionId): DecisionId => id;
    const actionId: ActionId = "act_01J8ZC2N6Q4T7V9X3B5D8F0H2K";

    // @ts-expect-error -- feedback is about decisions, not actions
    expect(recordFeedback(actionId)).toBe(actionId);
  });

  it("keeps every pair of ID kinds mutually unassignable", () => {
    interface Ids {
      dec: DecisionId;
      act: ActionId;
      agt: AgentId;
      prj: ProjectId;
      org: OrganizationId;
      pol: PolicyId;
      ses: SessionId;
    }
    // Every ordered pair (A, B), A != B, where A is assignable to B.
    type Collisions = {
      [A in keyof Ids]: {
        [B in keyof Ids]: A extends B
          ? never
          : Ids[A] extends Ids[B]
            ? [A, B]
            : never;
      }[keyof Ids];
    }[keyof Ids];

    expectTypeOf<Collisions>().toBeNever();
    // The matrix covers the whole registry, so a new prefix cannot skip it.
    expectTypeOf<keyof Ids>().toEqualTypeOf<IdPrefix>();
  });

  it("narrows an unknown value through the runtime guard only", () => {
    const untrusted: unknown = "act_01J8ZC2N6Q4T7V9X3B5D8F0H2K";
    if (isOpaqueId("act", untrusted)) {
      expectTypeOf(untrusted).toEqualTypeOf<ActionId>();
    }
    expect(isOpaqueId("act", untrusted)).toBe(true);
  });
});

describe("RFX-006 opaque IDs: runtime guard", () => {
  it("registers every prefix named in CLAUDE.md, plus sessions", () => {
    expect(Object.values(ID_PREFIXES).sort()).toEqual(
      ["dec", "act", "pol", "agt", "org", "prj", "ses"].sort(),
    );
  });

  it.each([
    ["a ULID body", "act_01J8ZC2N6Q4T7V9X3B5D8F0H2K"],
    ["a UUID body", "act_3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d"],
    ["a nanoid body", "act_V1StGXR8_Z5jdHi6B-myT"],
    ["a one-character body", "act_x"],
    ["the longest body", `act_${"a".repeat(ID_BODY_MAX_LENGTH)}`],
  ])("accepts %s", (_label, id) => {
    expect(isOpaqueId("act", id)).toBe(true);
  });

  // Adversarial: IDs flow into log lines, metric labels, URLs, file names and
  // cache keys. Each of these is an attempt to smuggle structure into one.
  it.each([
    ["another kind's prefix", "dec_01J8ZC2P0R3S5U7W9Y1A3C5E7G"],
    ["no body", "act_"],
    ["no separator", "act01J8ZC2N6Q4"],
    [
      "a body one character too long",
      `act_${"a".repeat(ID_BODY_MAX_LENGTH + 1)}`,
    ],
    ["an upper-case prefix", "ACT_01J8ZC2N6Q4"],
    ["leading whitespace", " act_01J8ZC2N6Q4"],
    ["trailing newline", "act_01J8ZC2N6Q4\n"],
    ["a log-injection newline", "act_abc\ndec_forged"],
    ["path traversal", "act_../../etc/passwd"],
    ["a dot", "act_a.b"],
    ["a cache-key separator", "act_a:b"],
    ["a URL separator", "act_a/b"],
    ["a space", "act_a b"],
    ["a NUL byte", "act_a\0b"],
    ["an ANSI escape", "act_\x1b[31mred"],
    ["a Cyrillic homoglyph prefix", `${String.fromCodePoint(0x430)}ct_abc`],
    ["a non-ASCII body", `act_${String.fromCodePoint(0xe9)}`],
    ["an empty string", ""],
  ])("rejects %s", (_label, id) => {
    expect(isOpaqueId("act", id)).toBe(false);
  });

  it.each([
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
    ["an object with a matching toString", { toString: () => "act_abc" }],
    ["an array", ["act_abc"]],
    ["a String object", new String("act_abc")],
  ])("rejects %s without coercing it", (_label, value) => {
    expect(isOpaqueId("act", value)).toBe(false);
  });
});
