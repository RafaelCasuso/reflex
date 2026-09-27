import { describe, expect, it } from "vitest";

import { CONTEXT, compiled, local, mcp } from "./engine.test-support.js";
import { evaluatePolicy } from "./evaluator.js";
import { parsePolicy } from "./parser.js";

/**
 * RFX-146 — numeric comparisons on a host's own arguments (contract v1.4):
 * the refund threshold is one line of policy, decided before any model.
 * Adversarial: a number written as text, a boolean, a missing amount and a
 * huge amount must never slip under a permit or past a restrict.
 */
const THRESHOLD = `version: 1
defaults:
  unresolved: semantic
rules:
  - id: refund-within-limit
    name: Refunds within the automatic limit
    effect: allow
    conditions:
      - { field: tool.namespace, operator: equals, value: stripe }
      - { field: tool.name, operator: equals, value: refunds.create }
      - { field: arguments.amount, operator: at_most, value: 10000 }
  - id: refund-over-hard-limit
    name: Refunds over the hard limit are never automatic
    effect: deny
    conditions:
      - { field: tool.namespace, operator: equals, value: stripe }
      - { field: tool.name, operator: equals, value: refunds.create }
      - { field: arguments.amount, operator: greater_than, value: 100000 }
`;

const refund = (amount: unknown) =>
  mcp("stripe", "refunds.create", {
    amount,
    currency: "eur",
    charge: "ch_synthetic_0001",
  });

const effectOf = (amount: unknown) =>
  evaluatePolicy(compiled(local(THRESHOLD)), refund(amount), CONTEXT)
    .evaluation;

describe("RFX-146 numeric operators", () => {
  it("parses the four comparisons on a host's own argument", () => {
    const parsed = parsePolicy(`version: 1
rules:
  - id: bands
    name: Bands
    effect: ask
    conditions:
      - { field: arguments.amount, operator: greater_than, value: 1 }
      - { field: arguments.amount, operator: at_least, value: 2.5 }
      - { field: arguments.amount, operator: less_than, value: 1000000 }
      - { field: arguments.amount, operator: at_most, value: -0 }
`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(
        parsed.document.rules[0]?.conditions.map((c) =>
          "operator" in c ? c.operator : undefined,
        ),
      ).toEqual(["greater_than", "at_least", "less_than", "at_most"]);
    }
  });

  it.each([
    [
      "a canonical text field",
      "command.text",
      "1",
      /compares numbers; command.text is text/,
    ],
    [
      "a canonical list field",
      "command.args",
      "1",
      /compares numbers; command.args is text/,
    ],
    [
      "a value written as text",
      "arguments.amount",
      '"100"',
      /needs a finite number/,
    ],
    ["a boolean value", "arguments.amount", "true", /needs a finite number/],
    ["a list value", "arguments.amount", "[1, 2]", /needs a finite number/],
    ["an infinite value", "arguments.amount", ".inf", /needs a finite number/],
    ["a missing value", "arguments.amount", undefined, /needs a number/],
  ])("refuses %s at parse time", (_label, field, value, message) => {
    const valueLine = value === undefined ? "" : `, value: ${value}`;
    const parsed = parsePolicy(`version: 1
rules:
  - id: r
    name: R
    effect: deny
    conditions:
      - { field: ${field}, operator: greater_than${valueLine} }
`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.map((issue) => issue.message).join("\n")).toMatch(
        message,
      );
    }
  });

  it("decides the refund threshold before any model, at the boundary", () => {
    expect(effectOf(4_900)).toMatchObject({ resolved: true, effect: "allow" });
    expect(effectOf(10_000)).toMatchObject({ resolved: true, effect: "allow" });
    expect(effectOf(10_001).resolved).toBe(false);
    expect(effectOf(100_000).resolved).toBe(false);
    expect(effectOf(100_001)).toMatchObject({ resolved: true, effect: "deny" });
    expect(effectOf(500_000)).toMatchObject({ resolved: true, effect: "deny" });
  });

  it.each([
    ["greater_than", [false, false, true]],
    ["at_least", [false, true, true]],
    ["less_than", [true, false, false]],
    ["at_most", [true, true, false]],
  ] as const)(
    "%s at one below the bound, at it, and one above",
    (operator, expected) => {
      const set = compiled(
        local(`version: 1
rules:
  - id: band
    name: Band
    effect: deny
    conditions:
      - { field: tool.name, operator: equals, value: refunds.create }
      - { field: arguments.amount, operator: ${operator}, value: 100 }
`),
      );
      const fires = (amount: number) =>
        evaluatePolicy(set, refund(amount), CONTEXT).evaluation.matches.some(
          (match) => match.ruleId === "band",
        );
      expect([fires(99), fires(100), fires(101)]).toEqual([...expected]);
    },
  );

  it("compares an integer and a decimal alike", () => {
    expect(effectOf(9_999.99)).toMatchObject({ effect: "allow" });
    expect(effectOf(10_000.01).resolved).toBe(false);
  });

  // Adversarial: what is not a number is never under a permit. A scalar
  // that is not a number reaches the comparison and is read by the doubt
  // rule: the deny fires. A list, an object or null is no value at all for
  // `arguments.<key>`: neither rule speaks, and the action stays unresolved,
  // which is never an allow.
  it.each([
    ["a number written as text", "10"],
    ["a huge number written as text", "999999999"],
    ["a boolean", true],
  ])(
    "reads %s by the doubt rule: the deny fires, the allow does not",
    (_label, amount) => {
      const evaluation = effectOf(amount);
      expect(evaluation.effect).toBe("deny");
      expect(
        evaluation.matches.some(
          (match) => match.ruleId === "refund-within-limit",
        ),
      ).toBe(false);
    },
  );

  it.each([
    ["a list", [1]],
    ["an object", { value: 1 }],
    ["null", null],
  ])("reads %s as no amount at all: nothing allows it", (_label, amount) => {
    const evaluation = effectOf(amount);
    expect(evaluation.resolved).toBe(false);
    expect(evaluation.matches).toEqual([]);
  });

  it("does not let NaN or an infinity in the action satisfy a permit", () => {
    for (const amount of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const evaluation = effectOf(amount);
      expect(
        evaluation.matches.some(
          (match) => match.ruleId === "refund-within-limit",
        ),
        String(amount),
      ).toBe(false);
    }
  });

  it("reads the comparison under not the way the rule leans", () => {
    const set = compiled(
      local(`version: 1
rules:
  - id: deny-outside-band
    name: Deny anything not at most the limit
    effect: deny
    conditions:
      - { field: tool.name, operator: equals, value: refunds.create }
      - not: { field: arguments.amount, operator: at_most, value: 10000 }
`),
    );
    expect(evaluatePolicy(set, refund(20_000), CONTEXT).evaluation.effect).toBe(
      "deny",
    );
    expect(
      evaluatePolicy(set, refund(5_000), CONTEXT).evaluation.resolved,
    ).toBe(false);
    // Under not, the doubt rule reads the leaf as matching for a restrict,
    // and `not` turns that into no match: as for a path whose root is not
    // known, the action is left unresolved, never allowed.
    const text = evaluatePolicy(set, refund("5000"), CONTEXT).evaluation;
    expect(text.resolved).toBe(false);
    expect(text.matches).toEqual([]);
  });
});
