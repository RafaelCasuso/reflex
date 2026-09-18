import type { z } from "zod";

import {
  MAX_VALIDATION_ISSUES,
  VALIDATION_ISSUE_CODES,
  type ValidationIssue,
  type ValidationIssueCode,
  type ValidationResult,
} from "../validation.js";

/**
 * Runs a schema and converts the outcome into REFLEX's own result type.
 *
 * Two properties matter more than convenience here:
 *
 * 1. It never throws. Validation sits on the hot path in front of every
 *    decision; hostile input must produce a typed failure, not a 500.
 * 2. Nothing taken from the input ends up in a message. Inputs carry secrets
 *    (CLAUDE.md: "never log raw tool arguments before redaction"), and a
 *    validation error is the first thing anyone logs. Messages are assembled
 *    from schema-side metadata only; input-derived key names appear in
 *    `path`, sanitized and truncated.
 */
export function validate<T>(
  schema: z.ZodType<T>,
  input: unknown,
): ValidationResult<T> {
  let result: z.ZodSafeParseResult<T>;
  try {
    result = schema.safeParse(input);
  } catch {
    return {
      ok: false,
      issues: [
        {
          path: "",
          code: "invalid_value",
          message: "Input could not be validated.",
        },
      ],
      truncated: false,
    };
  }

  if (result.success) {
    return { ok: true, value: result.data };
  }

  const issues: ValidationIssue[] = [];
  let total = 0;
  for (const zodIssue of result.error.issues) {
    for (const issue of toIssues(zodIssue, input)) {
      total += 1;
      if (issues.length < MAX_VALIDATION_ISSUES) {
        issues.push(issue);
      }
    }
  }

  return { ok: false, issues, truncated: total > issues.length };
}

type ZodIssue = z.core.$ZodIssue;
type PathSegment = PropertyKey;

function toIssues(issue: ZodIssue, input: unknown): ValidationIssue[] {
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({
      path: formatPath([...issue.path, key]),
      code: "unrecognized_field",
      message: "Field is not part of the contract.",
    }));
  }

  const path = formatPath(issue.path);
  const lookup = resolve(input, issue.path);

  if (!lookup.found) {
    return [
      { path, code: "missing_field", message: "Required field is missing." },
    ];
  }
  if (lookup.value === undefined) {
    return [
      {
        path,
        code: "invalid_type",
        message:
          "Field is set to undefined. Omit an optional field instead of setting it to undefined.",
      },
    ];
  }

  return [{ path, ...describe(issue) }];
}

function describe(
  issue: Exclude<ZodIssue, { code: "unrecognized_keys" }>,
): Pick<ValidationIssue, "code" | "message"> {
  switch (issue.code) {
    case "invalid_type":
      return {
        code: "invalid_type",
        message: `Expected ${typeName(issue.expected)}.`,
      };
    case "invalid_value":
      return {
        code: "invalid_value",
        message: `Expected one of: ${issue.values.map(String).join(", ")}.`,
      };
    case "too_big":
      return {
        code: "out_of_range",
        message: `Must be at most ${bound(issue.maximum, issue.origin)}.`,
      };
    case "too_small":
      return {
        code: "out_of_range",
        message: `Must be at least ${bound(issue.minimum, issue.origin)}.`,
      };
    case "invalid_format":
      return {
        code: "invalid_format",
        message:
          issue.format === "datetime"
            ? "Expected an ISO 8601 UTC timestamp ending in Z, for example 2026-01-31T12:00:00Z."
            : "Value does not have the required format.",
      };
    case "custom": {
      const params = readParams(issue.params);
      return params === undefined
        ? { code: "invalid_value", message: "Value is not permitted." }
        : { code: params.code, message: `Expected ${params.expected}.` };
    }
    case "not_multiple_of":
    case "invalid_union":
    case "invalid_key":
    case "invalid_element":
      return { code: "invalid_value", message: "Value is not permitted." };
  }
}

/** Zod's `expected` is a schema-side type name. Anything else is dropped. */
function typeName(expected: string): string {
  return /^[a-z]{1,16}$/.test(expected) ? expected : "a different type";
}

function bound(limit: number | bigint, origin: string): string {
  const unit =
    origin === "string"
      ? " characters"
      : origin === "array" || origin === "set"
        ? " items"
        : "";
  return `${String(limit)}${unit}`;
}

function readParams(
  params: unknown,
): { code: ValidationIssueCode; expected: string } | undefined {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const { reflexCode, expected } = params as Record<string, unknown>;
  const code = VALIDATION_ISSUE_CODES.find((known) => known === reflexCode);
  return code !== undefined && typeof expected === "string"
    ? { code, expected }
    : undefined;
}

interface Lookup {
  readonly found: boolean;
  readonly value: unknown;
}

/** Distinguishes "absent" from "present but wrong" without trusting Zod. */
function resolve(input: unknown, path: readonly PathSegment[]): Lookup {
  let current: unknown = input;
  for (const segment of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.hasOwn(current, segment)
    ) {
      return { found: false, value: undefined };
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return { found: true, value: current };
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_KEY_LENGTH = 64;

function formatPath(path: readonly PathSegment[]): string {
  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${String(segment)}]`;
    } else if (typeof segment === "symbol") {
      formatted += "[symbol]";
    } else if (IDENTIFIER.test(segment) && segment.length <= MAX_KEY_LENGTH) {
      formatted += formatted === "" ? segment : `.${segment}`;
    } else {
      formatted += `["${sanitizeKey(segment)}"]`;
    }
  }
  return formatted;
}

/**
 * Key names come from the input. They are useful for debugging and dangerous
 * in a log line, so only printable ASCII survives, and only a bounded amount.
 */
function sanitizeKey(key: string): string {
  const clipped = key.slice(0, MAX_KEY_LENGTH);
  const safe = clipped.replace(/[^\x20-\x21\x23-\x5b\x5d-\x7e]/g, "?");
  return key.length > MAX_KEY_LENGTH ? `${safe}...` : safe;
}
