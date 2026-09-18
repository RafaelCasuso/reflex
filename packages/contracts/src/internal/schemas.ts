import { z } from "zod";

import { isOpaqueId, type IdPrefix, type OpaqueId } from "../ids.js";
import { CONTRACT_LIMITS } from "../limits.js";
import type { ValidationIssueCode } from "../validation.js";
import { findJsonViolation, type JsonViolationReason } from "./json.js";

/**
 * Zod building blocks shared by the contract schemas.
 *
 * Zod stays inside `@reflex/contracts`: nothing from this file is part of the
 * public surface (see index.ts). Every custom check attaches `ReflexIssueParams`
 * so that issue mapping relies on structured data this package wrote, never on
 * a third party's message text.
 */
export interface ReflexIssueParams {
  readonly reflexCode: ValidationIssueCode;
  /** Completes the sentence "Expected …". Must not contain input values. */
  readonly expected: string;
}

function customIssue(
  input: unknown,
  params: ReflexIssueParams,
  path: readonly (string | number)[] = [],
): z.core.$ZodRawIssue {
  return { code: "custom", input, path: [...path], params: { ...params } };
}

/** No control characters or line separators anywhere. */
const NO_CONTROL_CHARACTERS = /^[^\p{Cc}\p{Zl}\p{Zp}]*$/u;

/**
 * Names are policy match keys and metric labels. Padding a name with
 * whitespace, or hiding a control character in it, must not produce a second
 * spelling of the same tool that an explicit rule fails to match.
 */
const NAME = /^(?!\s)[^\p{Cc}\p{Zl}\p{Zp}]*(?<!\s)$/u;

const HASH = /^[A-Za-z0-9._:=+/-]*$/;

function patternedString(
  pattern: RegExp,
  bounds: { readonly min: number; readonly max: number },
  expected: string,
) {
  return z
    .string()
    .min(bounds.min)
    .max(bounds.max)
    .check((context) => {
      if (!pattern.test(context.value)) {
        context.issues.push(
          customIssue(context.value, {
            reflexCode: "invalid_format",
            expected,
          }),
        );
      }
    });
}

export const nameSchema = patternedString(
  NAME,
  { min: 1, max: CONTRACT_LIMITS.nameLength },
  "a name without control characters or surrounding whitespace",
);

export const pathSchema = patternedString(
  NO_CONTROL_CHARACTERS,
  { min: 1, max: CONTRACT_LIMITS.pathLength },
  "a path or identifier without control characters",
);

export const hashSchema = patternedString(
  HASH,
  { min: 1, max: CONTRACT_LIMITS.hashLength },
  "a hash or key made of letters, digits and . _ : = + / -",
);

/** Free text is bounded, not filtered. Display layers sanitize on output. */
export const textSchema = z.string().max(CONTRACT_LIMITS.textLength);

/** ISO 8601 UTC with a `Z` suffix. Offsets and impossible dates are rejected. */
export const timestampSchema = z.iso.datetime().max(64);

/** Integer `0..100`. */
export const scoreSchema = z.int().min(0).max(100);

/** Float `0..1`. */
export const confidenceSchema = z.number().min(0).max(1);

/** Non-negative integer milliseconds. */
export const durationMsSchema = z.int().min(0);

export function opaqueIdSchema<Prefix extends IdPrefix>(prefix: Prefix) {
  return z.custom<OpaqueId<Prefix>>().check((context) => {
    if (!isOpaqueId(prefix, context.value)) {
      context.issues.push(
        customIssue(context.value, {
          reflexCode: "invalid_format",
          expected: `an opaque ID of the form ${prefix}_<letters, digits, _ or ->`,
        }),
      );
    }
  });
}

const JSON_EXPECTATIONS: Readonly<Record<JsonViolationReason, string>> = {
  not_plain_object: "a plain JSON object",
  unsupported_value:
    "only JSON values (no undefined, functions, symbols, bigints, dates or class instances)",
  non_finite_number: "finite numbers only",
  too_deep: `nesting no deeper than ${String(CONTRACT_LIMITS.jsonDepth)} levels`,
  too_large: `no more than ${String(CONTRACT_LIMITS.jsonNodes)} values in total`,
};

/**
 * `arguments` and `adapterMetadata`: a plain, bounded JSON object, passed
 * through by reference. Its contents are untrusted and are not interpreted.
 */
export const jsonObjectSchema = z
  .custom<Readonly<Record<string, unknown>>>()
  .check((context) => {
    const violation = findJsonViolation(context.value);
    if (violation !== undefined) {
      context.issues.push(
        customIssue(
          context.value,
          {
            reflexCode: "invalid_json",
            expected: JSON_EXPECTATIONS[violation.reason],
          },
          violation.path,
        ),
      );
    }
  });
