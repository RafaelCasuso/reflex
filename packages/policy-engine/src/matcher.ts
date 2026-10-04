import type {
  PolicyCondition,
  PolicyFieldCondition,
  PolicyRule,
} from "@reflex-control/contracts";

import { fieldSpec } from "./fields.js";
import { isWithin, resolveRoot, type PathContext } from "./paths.js";
import { PATTERN_LIMITS, type CompiledPattern } from "./pattern.js";
import { valuesOf, type FieldValue, type Subject } from "./subjects.js";

/**
 * RFX-013 and RFX-097 — does this rule match this subject?
 *
 * One principle decides every case that is not obvious (ADR-011, asymmetric
 * matching): **when in doubt, a rule that restricts matches, and a rule that
 * permits does not.** A wrong deny costs a prompt. A wrong allow is the failure
 * the product exists to prevent.
 *
 * So the same condition is read in one of two ways, by the rule's effect:
 *
 * |                              | `allow` (permits)            | `deny`, `ask` (restrict)     |
 * | ---------------------------- | ---------------------------- | ---------------------------- |
 * | the subject is not understood | never matches               | matches as usual             |
 * | a field with several values  | every value must satisfy it  | one value is enough          |
 * | a field that is absent       | never satisfies it, under `not` either | has no value; a list field is an empty list |
 * | a pattern on a very long text | does not match              | is evaluated all the same    |
 * | a path that matches by case only | is not within            | is within                    |
 * | a directory that is unknown  | is not within                | is within                    |
 * | arguments that cannot be read (`rm -rf $DIR`) | never matches | may point anywhere: "every path is inside" is false |
 * | a tool from an MCP server    | only if the rule names `tool.namespace` | matches as usual    |
 *
 * Under `not` the reading flips, so that the rule as a whole keeps leaning the
 * same way: in an allow rule `not: { path within ~/.ssh }` fails if any path is
 * in there, and in a deny rule `not: { path within ${project} }` fires if any
 * path is outside.
 */
export type RuleKind = "permits" | "restricts";

export interface MatchContext extends PathContext {
  /** Compiled once per policy set, never per evaluation. */
  readonly pattern: (source: string) => CompiledPattern | undefined;
}

const isList = (field: string): boolean => fieldSpec(field)?.multi === true;

const kindOf = (rule: PolicyRule): RuleKind =>
  rule.effect === "allow" ? "permits" : "restricts";

function compare(
  condition: PolicyFieldCondition,
  value: FieldValue,
  kind: RuleKind,
  context: MatchContext,
): boolean {
  const expected = condition.value;
  switch (condition.operator) {
    case "exists":
      return true;
    case "equals":
      return value === expected;
    case "not_equals":
      return value !== expected;
    case "in":
      return Array.isArray(expected) && expected.includes(value);
    case "starts_with":
      return (
        typeof value === "string" &&
        typeof expected === "string" &&
        value.startsWith(expected)
      );
    case "matches": {
      if (typeof value !== "string" || typeof expected !== "string") {
        return false;
      }
      if (
        kind === "permits" &&
        value.length > PATTERN_LIMITS.budgetedTextLength
      ) {
        return false;
      }
      const pattern = context.pattern(expected);
      // A pattern that does not compile was rejected when the policy was
      // loaded. If one is missing all the same, the doubt rule applies.
      return pattern === undefined ? kind === "restricts" : pattern.test(value);
    }
    case "greater_than":
    case "at_least":
    case "less_than":
    case "at_most": {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        typeof expected !== "number"
      ) {
        // A value that is not a number cannot be compared: "5000" as text,
        // a boolean, a NaN. The doubt rule applies, as for a root that
        // cannot be resolved: a restrict matches, a permit does not.
        return kind === "restricts";
      }
      return compareNumbers(condition.operator, value, expected);
    }
    case "path_within": {
      if (typeof value !== "string" || typeof expected !== "string") {
        return false;
      }
      const root = resolveRoot(expected, context);
      if (root === undefined || !value.startsWith("/")) {
        return kind === "restricts";
      }
      return isWithin(value, root, kind === "restricts");
    }
  }
}

function compareNumbers(
  operator: "greater_than" | "at_least" | "less_than" | "at_most",
  value: number,
  expected: number,
): boolean {
  switch (operator) {
    case "greater_than":
      return value > expected;
    case "at_least":
      return value >= expected;
    case "less_than":
      return value < expected;
    case "at_most":
      return value <= expected;
  }
}

/**
 * `easy` is how the comparison reads several values and an absent field:
 * easy to satisfy (one value is enough) or hard (every value, and an absent
 * field never). A restricting rule reads easily, a permitting one hard, and
 * `not` swaps them.
 */
function holds(
  condition: PolicyCondition,
  subject: Subject,
  kind: RuleKind,
  easy: boolean,
  context: MatchContext,
): boolean {
  if ("not" in condition) {
    return !holds(condition.not, subject, kind, !easy, context);
  }
  if ("any_of" in condition) {
    return condition.any_of.some((inner) =>
      holds(inner, subject, kind, easy, context),
    );
  }

  const values = valuesOf(subject, condition.field);
  if (values === undefined || values.length === 0) {
    if (kind === "permits") {
      // Absent never satisfies an allow rule. At the top level the comparison
      // is false. Under `not` it has to come out true, so that the rule comes
      // out false: "not rm" must not allow a tool call that has no command.
      return easy;
    }
    // `exists` asks a plain question, and the answer for nothing is no.
    if (condition.operator === "exists") {
      return false;
    }
    // A segment whose arguments could not be read may point anywhere. "Every
    // path is inside the project" cannot be said of `rm -rf $HOME`.
    if (!easy && subject.openLists && isList(condition.field)) {
      return false;
    }
    // For a rule that restricts, absence is a plain fact. A field that holds
    // a list (paths, arguments, hosts) is an empty list: no value satisfies
    // anything, and every value satisfies everything, so a rule about paths
    // says nothing about an action that touches none.
    if (isList(condition.field)) {
      return !easy;
    }
    // A field that holds one value simply has none: nothing equals it, and it
    // is not equal to anything. `not: { namespace equals github }` is true of
    // a tool that has no namespace.
    return condition.operator === "not_equals";
  }
  const test = (value: FieldValue): boolean =>
    compare(condition, value, kind, context);
  if (easy) {
    return values.some(test);
  }
  // Read the hard way, every value has to satisfy it, and the values that
  // could not be read count as ones that do not.
  return !(subject.openLists && isList(condition.field)) && values.every(test);
}

const mentionsNamespace = (condition: PolicyCondition): boolean =>
  "not" in condition
    ? mentionsNamespace(condition.not)
    : "any_of" in condition
      ? condition.any_of.some(mentionsNamespace)
      : condition.field === "tool.namespace";

export function ruleMatches(
  rule: PolicyRule,
  subject: Subject,
  context: MatchContext,
): boolean {
  const kind = kindOf(rule);
  if (kind === "permits") {
    if (!subject.understood) {
      return false;
    }
    // A server names its own tools. A rule that allows `Bash` must not allow
    // another server's tool that calls itself `Bash`.
    if (
      subject.fields.has("tool.namespace") &&
      !rule.conditions.some(mentionsNamespace)
    ) {
      return false;
    }
  }
  return rule.conditions.every((condition) =>
    holds(condition, subject, kind, kind === "restricts", context),
  );
}
