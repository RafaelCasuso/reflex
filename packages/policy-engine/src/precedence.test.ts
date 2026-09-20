import { DECISION_EFFECTS, type DecisionEffect } from "@reflex/contracts";
import { describe, expect, it } from "vitest";

import {
  POLICY_SOURCES,
  combine,
  precedenceOf,
  resolve,
  type PolicySource,
  type SourcedRule,
} from "./precedence.js";

/** RFX-014 — ADR-004, exhaustively. */
const STRICTNESS: Readonly<Record<DecisionEffect, number>> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

let counter = 0;
function matched(
  source: PolicySource,
  effect: DecisionEffect,
  mandatory = false,
  trusted = true,
): SourcedRule {
  counter += 1;
  return {
    source,
    trusted,
    rule: {
      id: `r${String(counter).padStart(4, "0")}`,
      name: `${source} ${effect}`,
      effect,
      ...(mandatory ? { mandatory } : {}),
      conditions: [{ field: "tool.name", operator: "exists" }],
    },
  };
}

/** Every rule a source could contribute: three defaults and two mandates. */
function everyRule(): SourcedRule[] {
  return POLICY_SOURCES.flatMap((source) => [
    ...DECISION_EFFECTS.map((effect) => matched(source, effect)),
    matched(source, "ask", true),
    matched(source, "deny", true),
  ]);
}

describe("RFX-014 precedence", () => {
  it("leaves an action unresolved when nothing matched", () => {
    expect(resolve([])).toEqual({ effect: undefined, matches: [] });
  });

  it("a single match decides", () => {
    for (const effect of DECISION_EFFECTS) {
      expect(resolve([matched("local", effect)]).effect).toBe(effect);
    }
  });

  it("inside one source the most restrictive effect wins, whatever the order", () => {
    const rules = [
      matched("project", "allow"),
      matched("project", "deny"),
      matched("project", "ask"),
    ];
    expect(resolve(rules).effect).toBe("deny");
    expect(resolve(rules.toReversed()).effect).toBe("deny");
  });

  // ADR-004 §3: defaults cascade down. That is what makes `mandatory` mean
  // something.
  it("a more specific source overrides a default, in either direction", () => {
    expect(
      resolve([matched("organization", "deny"), matched("local", "allow")])
        .effect,
    ).toBe("allow");
    expect(
      resolve([matched("organization", "allow"), matched("local", "deny")])
        .effect,
    ).toBe("deny");
    expect(
      resolve([
        matched("organization", "deny"),
        matched("project", "ask"),
        matched("local", "allow"),
      ]).effect,
    ).toBe("allow");
    expect(
      resolve([matched("built-in", "allow"), matched("environment", "ask")])
        .effect,
    ).toBe("ask");
  });

  it("a mandate is a floor that a more specific source cannot go under", () => {
    expect(
      resolve([
        matched("organization", "deny", true),
        matched("local", "allow"),
      ]).effect,
    ).toBe("deny");
    expect(
      resolve([matched("organization", "ask", true), matched("local", "allow")])
        .effect,
    ).toBe("ask");
    expect(
      resolve([
        matched("built-in", "ask", true),
        matched("project", "allow"),
        matched("local", "allow"),
      ]).effect,
    ).toBe("ask");
  });

  it("tightening is always possible, even against a mandate", () => {
    expect(
      resolve([
        matched("organization", "ask", true),
        matched("project", "deny"),
      ]).effect,
    ).toBe("deny");
  });

  // The gate exit: a mandatory deny is shown by test not to be weakened by any
  // lower source. Exhaustive over every pair and every triple of rules that
  // five sources can contribute: 25 rules, 300 pairs, 2,300 triples.
  it("no combination of rules brings the effect under a mandatory match", () => {
    const rules = everyRule();
    let checked = 0;
    const check = (combination: readonly SourcedRule[]): void => {
      const { effect } = resolve(combination);
      const floor = Math.max(
        -1,
        ...combination
          .filter((sourced) => sourced.rule.mandatory === true)
          .map((sourced) => STRICTNESS[sourced.rule.effect]),
      );
      expect(effect).toBeDefined();
      if (effect !== undefined) {
        expect(STRICTNESS[effect]).toBeGreaterThanOrEqual(floor);
        // And the effect is one that some matching rule asked for.
        expect(combination.map((sourced) => sourced.rule.effect)).toContain(
          effect,
        );
      }
      checked += 1;
    };
    for (let a = 0; a < rules.length; a += 1) {
      for (let b = a + 1; b < rules.length; b += 1) {
        const first = rules[a];
        const second = rules[b];
        if (first === undefined || second === undefined) {
          continue;
        }
        check([first, second]);
        check([second, first]);
        for (let c = b + 1; c < rules.length; c += 1) {
          const third = rules[c];
          if (third !== undefined) {
            check([first, second, third]);
            check([third, first, second]);
          }
        }
      }
    }
    expect(checked).toBe(2 * 300 + 2 * 2_300);
  });

  it("does not depend on the order the rules arrive in", () => {
    const rules = [
      matched("organization", "deny"),
      matched("project", "ask", true),
      matched("local", "allow"),
      matched("environment", "allow"),
    ];
    const expected = resolve(rules);
    for (let shift = 1; shift < rules.length; shift += 1) {
      const rotated = [...rules.slice(shift), ...rules.slice(0, shift)];
      expect(resolve(rotated)).toEqual(expected);
    }
  });

  // ADR-012: untrusted can only tighten.
  describe("trust", () => {
    it("drops an allow from a source that is not trusted", () => {
      expect(resolve([matched("project", "allow", false, false)])).toEqual({
        effect: undefined,
        matches: [],
      });
      expect(
        resolve([
          matched("organization", "ask"),
          matched("project", "allow", false, false),
        ]).effect,
      ).toBe("ask");
    });

    it("lets its deny and its ask tighten what the user's own rules resolved", () => {
      expect(
        resolve([
          matched("local", "allow"),
          matched("project", "deny", false, false),
        ]).effect,
      ).toBe("deny");
      expect(
        resolve([
          matched("local", "allow"),
          matched("project", "ask", false, false),
        ]).effect,
      ).toBe("ask");
      expect(resolve([matched("project", "deny", false, false)]).effect).toBe(
        "deny",
      );
    });

    // An organization denies by default and a repository ships an `ask` for
    // the same thing. In a cascade the more specific default would win.
    it("never lets its ask override a more general deny", () => {
      expect(
        resolve([
          matched("organization", "deny"),
          matched("project", "ask", false, false),
        ]).effect,
      ).toBe("deny");
      expect(
        resolve([
          matched("built-in", "deny"),
          matched("project", "ask", true, false),
        ]).effect,
      ).toBe("deny");
    });

    // Alone, an untrusted ask must not resolve the action: what would have
    // decided next might have denied. It leaves a floor instead.
    it("does not let its ask resolve an action by itself", () => {
      expect(resolve([matched("project", "ask", false, false)])).toMatchObject({
        effect: undefined,
        floor: "ask",
      });
    });

    // Adversarial: a hostile repository against every rule the user's own
    // sources can hold. Whatever it ships, the result is never more
    // permissive than without it.
    it("never loosens anything, whatever a hostile repository ships", () => {
      const hostile = (): SourcedRule[] => [
        matched("project", "allow", false, false),
        matched("project", "ask", false, false),
        matched("project", "deny", false, false),
        matched("project", "ask", true, false),
        matched("project", "deny", true, false),
      ];
      let checked = 0;
      const own = everyRule().filter((sourced) => sourced.source !== "project");
      for (const first of own) {
        for (const second of own) {
          const without = resolve([first, second]).effect;
          for (const shipped of hostile()) {
            const withIt = resolve([first, second, shipped]).effect;
            expect(without).toBeDefined();
            expect(withIt).toBeDefined();
            if (without !== undefined && withIt !== undefined) {
              expect(
                STRICTNESS[withIt],
                `${first.rule.name} + ${second.rule.name} + untrusted ${shipped.rule.name}`,
              ).toBeGreaterThanOrEqual(STRICTNESS[without]);
            }
            checked += 1;
          }
        }
      }
      expect(checked).toBe(20 * 20 * 5);
    });
  });

  describe("explanation", () => {
    it("derives precedence as ADR-004 §5 tabulates it", () => {
      expect(
        POLICY_SOURCES.map((source) => precedenceOf(source, false)),
      ).toEqual([10, 20, 30, 40, 50]);
      expect(
        POLICY_SOURCES.map((source) => precedenceOf(source, true)),
      ).toEqual([150, 140, 130, 120, 110]);
    });

    it("lists the deciding match first, and the ones that lost after it", () => {
      const { effect, matches } = resolve([
        matched("organization", "deny"),
        matched("local", "allow"),
        matched("environment", "ask"),
      ]);
      expect(effect).toBe("allow");
      expect(matches.map((match) => [match.effect, match.precedence])).toEqual([
        ["allow", 50],
        ["ask", 30],
        ["deny", 20],
      ]);
    });

    it("lists a tightening default first even though a mandate outranks it", () => {
      const { matches } = resolve([
        matched("organization", "ask", true),
        matched("project", "deny"),
      ]);
      expect(matches.map((match) => match.effect)).toEqual(["deny", "ask"]);
    });

    it("breaks a tie by rule id, in code-point order", () => {
      const a = matched("local", "deny");
      const b = matched("local", "deny");
      expect(resolve([b, a]).matches.map((match) => match.ruleId)).toEqual([
        a.rule.id,
        b.rule.id,
      ]);
    });
  });

  describe("an action with several subjects", () => {
    const of = (effect: DecisionEffect | undefined) => ({
      effect,
      matches:
        effect === undefined ? [] : resolve([matched("local", effect)]).matches,
    });

    it.each<
      [readonly (DecisionEffect | undefined)[], DecisionEffect | undefined]
    >([
      [["allow", "allow"], "allow"],
      [["allow", undefined], undefined],
      [["allow", "ask"], "ask"],
      [["ask", undefined], "ask"],
      [["allow", "deny", "ask"], "deny"],
      [[undefined, "deny"], "deny"],
      [[undefined, undefined], undefined],
      [[], undefined],
    ])("%j is %s", (effects, expected) => {
      expect(combine(effects.map(of)).effect).toBe(expected);
    });

    it("reports each rule once, the deciding subject's first", () => {
      const allow = resolve([matched("local", "allow")]);
      const deny = resolve([matched("local", "deny")]);
      const combined = combine([allow, deny, allow]);
      expect(combined.matches.map((match) => match.effect)).toEqual([
        "deny",
        "allow",
      ]);
    });
  });
});
