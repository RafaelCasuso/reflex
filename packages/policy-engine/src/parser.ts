import {
  DECISION_EFFECTS,
  POLICY_OPERATORS,
  type DecisionEffect,
  type PolicyCondition,
  type PolicyDocument,
  type PolicyOperator,
  type PolicyRule,
  type PolicyUnresolvedDefault,
} from "@reflex/contracts";
import {
  LineCounter,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Node,
  type YAMLMap,
} from "yaml";

import {
  RAW_ARGUMENTS_PREFIX,
  addressableFieldNames,
  fieldSpec,
  type FieldSpec,
} from "./fields.js";

/**
 * RFX-012 — the v1 policy document parser.
 *
 * A policy file is untrusted input: a project policy is written by whoever
 * wrote the repository (ADR-012). So the parser is strict in the way every
 * decision input is (ADR-009): nothing is defaulted, coerced or repaired, an
 * unknown key is an error and not a rule that quietly does nothing, and every
 * problem comes back with the line it is on, because a policy nobody can fix is
 * a policy somebody deletes.
 *
 * Pure: a string in, a document or every problem found out. No I/O, never
 * throws, bounded in what it will read.
 */
export const POLICY_LIMITS = {
  /** A policy is configuration, not data. */
  sourceBytes: 256 * 1024,
  rules: 2_000,
  conditionsPerRule: 64,
  listValues: 1_024,
  nameLength: 256,
  textLength: 1_024,
  /** More than this and the author needs a fix, not a longer list. */
  issues: 50,
} as const;

export const POLICY_ISSUE_CODES = [
  "too_large",
  "invalid_yaml",
  "unsupported_yaml",
  "invalid_type",
  "missing_key",
  "unknown_key",
  "invalid_value",
  "duplicate_id",
  "unknown_field",
  "unknown_operator",
  "too_many",
] as const;
export type PolicyIssueCode = (typeof POLICY_ISSUE_CODES)[number];

export interface PolicyIssue {
  readonly code: PolicyIssueCode;
  /** Where in the document: `rules[2].conditions[0].operator`. */
  readonly path: string;
  /** 1-based, as an editor shows them. */
  readonly line: number;
  readonly column: number;
  /** What is wrong and what would be right. */
  readonly message: string;
}

export type PolicyParseResult =
  | { readonly ok: true; readonly document: PolicyDocument }
  | { readonly ok: false; readonly issues: readonly PolicyIssue[] };

const UNRESOLVED_DEFAULTS: readonly PolicyUnresolvedDefault[] = [
  "semantic",
  "ask",
  "deny",
];
const RULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const STANDARD_TAG = /^tag:yaml\.org,2002:(?:str|int|float|bool|null|map|seq)$/;

type Scalarish = string | number | boolean;

const list = (values: readonly string[]): string => values.join(", ");

/** Short enough for one line of a terminal, and never the whole document. */
function shown(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

class Parse {
  readonly issues: PolicyIssue[] = [];
  readonly #lines: LineCounter;

  constructor(lines: LineCounter) {
    this.#lines = lines;
  }

  at(
    code: PolicyIssueCode,
    path: string,
    where: Node | number | null | undefined,
    message: string,
  ): void {
    if (this.issues.length >= POLICY_LIMITS.issues) {
      return;
    }
    const offset = typeof where === "number" ? where : (where?.range?.[0] ?? 0);
    const { line, col } = this.#lines.linePos(offset);
    this.issues.push({
      code,
      path,
      line: Math.max(1, line),
      column: Math.max(1, col),
      message,
    });
  }

  lineOf(node: Node | null | undefined): number {
    return Math.max(1, this.#lines.linePos(node?.range?.[0] ?? 0).line);
  }

  /** Anchors, aliases and custom tags add power a policy never needs. */
  plain(node: Node | null | undefined, path: string): boolean {
    if (node === null || node === undefined) {
      return true;
    }
    if (isAlias(node)) {
      this.at(
        "unsupported_yaml",
        path,
        node,
        "aliases are not supported in a policy; write the value out",
      );
      return false;
    }
    if (node.anchor !== undefined) {
      this.at(
        "unsupported_yaml",
        path,
        node,
        "anchors are not supported in a policy; write the value out",
      );
      return false;
    }
    if (node.tag !== undefined && !STANDARD_TAG.test(node.tag)) {
      this.at(
        "unsupported_yaml",
        path,
        node,
        `the tag ${shown(node.tag)} is not supported in a policy`,
      );
      return false;
    }
    return true;
  }

  /** The entries of a mapping with string keys, or nothing and an issue. */
  map(
    node: Node | null | undefined,
    path: string,
    allowed: readonly string[],
    what: string,
  ): Map<string, Node | null> | undefined {
    if (!this.plain(node, path)) {
      return undefined;
    }
    if (!isMap(node)) {
      this.at(
        "invalid_type",
        path,
        node,
        `${what} must be a mapping with the keys: ${list(allowed)}`,
      );
      return undefined;
    }
    const entries = new Map<string, Node | null>();
    for (const pair of (node as YAMLMap<Node, Node | null>).items) {
      const key = pair.key;
      if (!isScalar(key) || typeof key.value !== "string") {
        this.at("invalid_type", path, key, "keys must be plain strings");
        continue;
      }
      if (!this.plain(key, path)) {
        continue;
      }
      if (!allowed.includes(key.value)) {
        this.at(
          "unknown_key",
          path === "" ? key.value : `${path}.${key.value}`,
          key,
          `unknown key ${shown(key.value)}; ${what} has: ${list(allowed)}`,
        );
        continue;
      }
      entries.set(key.value, pair.value);
    }
    return entries;
  }

  text(
    node: Node | null | undefined,
    path: string,
    what: string,
    maxLength: number,
  ): string | undefined {
    if (!this.plain(node, path)) {
      return undefined;
    }
    if (!isScalar(node) || typeof node.value !== "string") {
      this.at("invalid_type", path, node, `${what} must be a string`);
      return undefined;
    }
    if (node.value.trim() === "") {
      this.at("invalid_value", path, node, `${what} must not be empty`);
      return undefined;
    }
    if (node.value.length > maxLength) {
      this.at(
        "invalid_value",
        path,
        node,
        `${what} is longer than ${String(maxLength)} characters`,
      );
      return undefined;
    }
    return node.value;
  }

  oneOf<T extends string>(
    node: Node | null | undefined,
    path: string,
    what: string,
    values: readonly T[],
  ): T | undefined {
    if (!this.plain(node, path)) {
      return undefined;
    }
    if (
      !isScalar(node) ||
      typeof node.value !== "string" ||
      !(values as readonly string[]).includes(node.value)
    ) {
      this.at(
        "invalid_value",
        path,
        node,
        `${what} must be one of: ${list(values)}${
          isScalar(node) ? `; got ${shown(node.value)}` : ""
        }`,
      );
      return undefined;
    }
    return node.value as T;
  }
}

function readScalarValue(
  parse: Parse,
  node: Node | null | undefined,
  path: string,
  field: FieldSpec,
): Scalarish | undefined {
  if (!parse.plain(node, path)) {
    return undefined;
  }
  const raw = field.name.startsWith(RAW_ARGUMENTS_PREFIX);
  if (!isScalar(node)) {
    parse.at("invalid_type", path, node, "value must be a single value");
    return undefined;
  }
  const { value } = node;
  if (typeof value === "string") {
    if (value.length > POLICY_LIMITS.textLength) {
      parse.at(
        "invalid_value",
        path,
        node,
        `value is longer than ${String(POLICY_LIMITS.textLength)} characters`,
      );
      return undefined;
    }
    if (field.values !== undefined && !field.values.includes(value)) {
      parse.at(
        "invalid_value",
        path,
        node,
        `${field.name} is one of: ${list(field.values)}; got ${shown(value)}`,
      );
      return undefined;
    }
    return value;
  }
  // Canonical fields are text. Only a host's own arguments hold other scalars.
  if (raw && (typeof value === "boolean" || Number.isFinite(value))) {
    return value as number | boolean;
  }
  parse.at(
    "invalid_type",
    path,
    node,
    raw
      ? "value must be a string, a number or a boolean"
      : `${field.name} is text: quote the value`,
  );
  return undefined;
}

function readCondition(
  parse: Parse,
  node: Node | null,
  path: string,
): PolicyCondition | undefined {
  const entries = parse.map(
    node,
    path,
    ["field", "operator", "value"],
    "a condition",
  );
  if (entries === undefined) {
    return undefined;
  }

  const fieldNode = entries.get("field");
  let fieldName: string | undefined;
  if (entries.has("field")) {
    fieldName = parse.text(
      fieldNode,
      `${path}.field`,
      "field",
      POLICY_LIMITS.nameLength,
    );
  } else {
    parse.at("missing_key", path, node, "a condition needs a field");
  }
  const field = fieldName === undefined ? undefined : fieldSpec(fieldName);
  if (fieldName !== undefined && field === undefined) {
    parse.at(
      "unknown_field",
      `${path}.field`,
      fieldNode,
      `unknown field ${shown(fieldName)}; a rule can be written about: ${list(addressableFieldNames())}`,
    );
  }

  const operatorNode = entries.get("operator");
  let operator: PolicyOperator | undefined;
  if (!entries.has("operator")) {
    parse.at("missing_key", path, node, "a condition needs an operator");
  } else if (
    isScalar(operatorNode) &&
    typeof operatorNode.value === "string" &&
    !(POLICY_OPERATORS as readonly string[]).includes(operatorNode.value)
  ) {
    parse.at(
      "unknown_operator",
      `${path}.operator`,
      operatorNode,
      `unknown operator ${shown(operatorNode.value)}; the operators are: ${list(POLICY_OPERATORS)}`,
    );
  } else {
    operator = parse.oneOf(
      operatorNode,
      `${path}.operator`,
      "operator",
      POLICY_OPERATORS,
    );
  }

  if (field === undefined || operator === undefined) {
    return undefined;
  }

  const valuePath = `${path}.value`;
  const valueNode = entries.get("value");
  switch (operator) {
    case "exists":
      if (entries.has("value")) {
        parse.at(
          "invalid_value",
          valuePath,
          valueNode,
          "exists takes no value",
        );
        return undefined;
      }
      return { field: field.name, operator };

    case "equals":
    case "not_equals": {
      if (!entries.has("value")) {
        parse.at("missing_key", path, node, `${operator} needs a value`);
        return undefined;
      }
      const value = readScalarValue(parse, valueNode, valuePath, field);
      return value === undefined
        ? undefined
        : { field: field.name, operator, value };
    }

    case "in": {
      if (!entries.has("value")) {
        parse.at("missing_key", path, node, "in needs a list of values");
        return undefined;
      }
      if (!parse.plain(valueNode, valuePath)) {
        return undefined;
      }
      if (!isSeq(valueNode) || valueNode.items.length === 0) {
        parse.at(
          "invalid_type",
          valuePath,
          valueNode,
          "in needs a non-empty list of values",
        );
        return undefined;
      }
      if (valueNode.items.length > POLICY_LIMITS.listValues) {
        parse.at(
          "too_many",
          valuePath,
          valueNode,
          `a list holds at most ${String(POLICY_LIMITS.listValues)} values`,
        );
        return undefined;
      }
      const before = parse.issues.length;
      const values = valueNode.items.map((item, index) =>
        readScalarValue(
          parse,
          item as Node | null,
          `${valuePath}[${String(index)}]`,
          field,
        ),
      );
      return parse.issues.length > before
        ? undefined
        : { field: field.name, operator, value: values };
    }

    case "starts_with":
    case "matches": {
      if (!entries.has("value")) {
        parse.at("missing_key", path, node, `${operator} needs a value`);
        return undefined;
      }
      if (field.kind !== "text") {
        parse.at(
          "invalid_value",
          `${path}.operator`,
          operatorNode,
          `${operator} works on text; ${field.name} is one of a fixed set, use equals or in`,
        );
        return undefined;
      }
      const value = parse.text(
        valueNode,
        valuePath,
        "value",
        POLICY_LIMITS.textLength,
      );
      return value === undefined
        ? undefined
        : { field: field.name, operator, value };
    }
  }
}

function readRule(
  parse: Parse,
  node: Node | null,
  path: string,
  seenIds: Map<string, number>,
): PolicyRule | undefined {
  const entries = parse.map(
    node,
    path,
    ["id", "name", "effect", "mandatory", "conditions"],
    "a rule",
  );
  if (entries === undefined) {
    return undefined;
  }
  for (const key of ["id", "name", "effect", "conditions"]) {
    if (!entries.has(key)) {
      parse.at("missing_key", path, node, `a rule needs ${key}`);
    }
  }

  const idNode = entries.get("id");
  let id = entries.has("id")
    ? parse.text(idNode, `${path}.id`, "id", POLICY_LIMITS.nameLength)
    : undefined;
  if (id !== undefined && !RULE_ID.test(id)) {
    parse.at(
      "invalid_value",
      `${path}.id`,
      idNode,
      "id must be lower-case letters, digits, dots, hyphens or underscores, at most 64, starting with a letter or a digit",
    );
    id = undefined;
  }
  if (id !== undefined) {
    const firstLine = seenIds.get(id);
    if (firstLine !== undefined) {
      parse.at(
        "duplicate_id",
        `${path}.id`,
        idNode,
        `rule id ${shown(id)} is already used on line ${String(firstLine)}`,
      );
    } else {
      seenIds.set(id, parse.lineOf(idNode));
    }
  }

  const name = entries.has("name")
    ? parse.text(
        entries.get("name"),
        `${path}.name`,
        "name",
        POLICY_LIMITS.nameLength,
      )
    : undefined;

  const effectNode = entries.get("effect");
  const effect: DecisionEffect | undefined = entries.has("effect")
    ? parse.oneOf(effectNode, `${path}.effect`, "effect", DECISION_EFFECTS)
    : undefined;

  let mandatory: boolean | undefined;
  if (entries.has("mandatory")) {
    const mandatoryNode = entries.get("mandatory");
    if (
      parse.plain(mandatoryNode, `${path}.mandatory`) &&
      isScalar(mandatoryNode) &&
      typeof mandatoryNode.value === "boolean"
    ) {
      mandatory = mandatoryNode.value;
    } else {
      parse.at(
        "invalid_type",
        `${path}.mandatory`,
        mandatoryNode,
        "mandatory must be true or false",
      );
    }
    // ADR-004 §2: a floor of allow is no floor.
    if (mandatory === true && effect === "allow") {
      parse.at(
        "invalid_value",
        `${path}.mandatory`,
        mandatoryNode,
        "an allow rule cannot be mandatory: mandatory sets a floor that nothing can go under, and only deny and ask are floors",
      );
    }
  }

  let conditions: PolicyCondition[] | undefined;
  if (entries.has("conditions")) {
    const conditionsNode = entries.get("conditions");
    const conditionsPath = `${path}.conditions`;
    if (!parse.plain(conditionsNode, conditionsPath)) {
      // reported
    } else if (!isSeq(conditionsNode) || conditionsNode.items.length === 0) {
      // A rule with no condition matches everything. Say that with
      // `defaults.unresolved`, where it cannot be mistaken for a rule.
      parse.at(
        "invalid_type",
        conditionsPath,
        conditionsNode,
        "conditions must be a non-empty list; a rule that matches everything is what defaults.unresolved is for",
      );
    } else if (conditionsNode.items.length > POLICY_LIMITS.conditionsPerRule) {
      parse.at(
        "too_many",
        conditionsPath,
        conditionsNode,
        `a rule holds at most ${String(POLICY_LIMITS.conditionsPerRule)} conditions`,
      );
    } else {
      const before = parse.issues.length;
      const read = conditionsNode.items.map((item, index) =>
        readCondition(
          parse,
          item as Node | null,
          `${conditionsPath}[${String(index)}]`,
        ),
      );
      if (parse.issues.length === before) {
        conditions = read.filter(
          (condition): condition is PolicyCondition => condition !== undefined,
        );
      }
    }
  }

  if (
    id === undefined ||
    name === undefined ||
    effect === undefined ||
    conditions === undefined
  ) {
    return undefined;
  }
  return {
    id,
    name,
    effect,
    ...(mandatory === undefined ? {} : { mandatory }),
    conditions,
  };
}

export function parsePolicy(source: string): PolicyParseResult {
  const lines = new LineCounter();
  const parse = new Parse(lines);

  if (Buffer.byteLength(source, "utf8") > POLICY_LIMITS.sourceBytes) {
    parse.at(
      "too_large",
      "",
      0,
      `a policy file holds at most ${String(POLICY_LIMITS.sourceBytes / 1024)} KiB`,
    );
    return { ok: false, issues: parse.issues };
  }

  // `parseDocument` silently reads the first of several documents. A second
  // one would be a policy that exists in the file and is never enforced.
  const documents = parseAllDocuments(source, {
    lineCounter: lines,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: "1.2",
    schema: "core",
    merge: false,
    logLevel: "silent",
  });
  const [document, second] = Array.isArray(documents) ? documents : [];
  if (document === undefined) {
    parse.at(
      "invalid_type",
      "",
      0,
      "a policy must be a mapping with the keys: version, defaults, rules",
    );
    return { ok: false, issues: parse.issues };
  }
  if (second !== undefined) {
    parse.at(
      "unsupported_yaml",
      "",
      second.range[0],
      "a policy file holds exactly one YAML document; remove the --- separator and what follows it",
    );
    return { ok: false, issues: parse.issues };
  }
  for (const problem of [...document.errors, ...document.warnings]) {
    parse.at("invalid_yaml", "", problem.pos[0], problem.message);
  }
  if (parse.issues.length > 0) {
    return { ok: false, issues: parse.issues };
  }

  const root = parse.map(
    document.contents,
    "",
    ["version", "defaults", "rules"],
    "a policy",
  );
  if (root === undefined) {
    return { ok: false, issues: parse.issues };
  }

  const versionNode = root.get("version");
  if (!root.has("version")) {
    parse.at("missing_key", "", document.contents, "a policy needs version: 1");
  } else if (
    !parse.plain(versionNode, "version") ||
    !isScalar(versionNode) ||
    versionNode.value !== 1
  ) {
    parse.at(
      "invalid_value",
      "version",
      versionNode,
      "version must be the number 1, the only policy format there is",
    );
  }

  let unresolved: PolicyUnresolvedDefault | undefined;
  if (root.has("defaults")) {
    const defaults = parse.map(
      root.get("defaults"),
      "defaults",
      ["unresolved"],
      "defaults",
    );
    if (defaults !== undefined) {
      if (defaults.has("unresolved")) {
        unresolved = parse.oneOf(
          defaults.get("unresolved"),
          "defaults.unresolved",
          "unresolved",
          UNRESOLVED_DEFAULTS,
        );
      } else {
        parse.at(
          "missing_key",
          "defaults",
          root.get("defaults"),
          "defaults needs unresolved; leave defaults out to declare nothing",
        );
      }
    }
  }

  const rules: PolicyRule[] = [];
  const rulesNode = root.get("rules");
  if (!root.has("rules")) {
    parse.at(
      "missing_key",
      "",
      document.contents,
      "a policy needs rules, which may be an empty list",
    );
  } else if (parse.plain(rulesNode, "rules")) {
    if (!isSeq(rulesNode)) {
      parse.at("invalid_type", "rules", rulesNode, "rules must be a list");
    } else if (rulesNode.items.length > POLICY_LIMITS.rules) {
      parse.at(
        "too_many",
        "rules",
        rulesNode,
        `a policy holds at most ${String(POLICY_LIMITS.rules)} rules`,
      );
    } else {
      const seenIds = new Map<string, number>();
      rulesNode.items.forEach((item, index) => {
        const rule = readRule(
          parse,
          item as Node | null,
          `rules[${String(index)}]`,
          seenIds,
        );
        if (rule !== undefined) {
          rules.push(rule);
        }
      });
    }
  }

  if (parse.issues.length > 0) {
    return { ok: false, issues: parse.issues };
  }
  return {
    ok: true,
    document: {
      version: 1,
      ...(unresolved === undefined ? {} : { defaults: { unresolved } }),
      rules,
    },
  };
}
