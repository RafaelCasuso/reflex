/**
 * Typed validation outcomes.
 *
 * Validation failure is an expected domain outcome, so it is a value and not
 * an exception (CLAUDE.md). These types are REFLEX's own: whichever library
 * performs the validation is an implementation detail that never appears in
 * the public surface.
 */
export const VALIDATION_ISSUE_CODES = [
  /** A mandatory field is absent. */
  "missing_field",
  /** A field that is not part of the contract. Inputs are never repaired. */
  "unrecognized_field",
  /** Wrong JSON type. */
  "invalid_type",
  /** Right type, but not one of the permitted values. */
  "invalid_value",
  /** A string that does not have the required format (ID, timestamp, name). */
  "invalid_format",
  /** A number, string length or collection size outside its bounds. */
  "out_of_range",
  /** `arguments` or `adapterMetadata` is not a plain, bounded JSON object. */
  "invalid_json",
] as const;

export type ValidationIssueCode = (typeof VALIDATION_ISSUE_CODES)[number];

export interface ValidationIssue {
  /**
   * Where the problem is, in the same dotted notation policies use for
   * fields: `action.tool.name`, `priorActions[2].occurredAt`. The empty
   * string is the root. Key names taken from the input are sanitized.
   */
  readonly path: string;
  readonly code: ValidationIssueCode;
  /**
   * Safe to log and to return to a caller. It is built from the contract and
   * never contains a value taken from the input, because inputs carry
   * secrets.
   */
  readonly message: string;
}

export interface ValidationSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ValidationFailure {
  readonly ok: false;
  /** At most `MAX_VALIDATION_ISSUES` entries. */
  readonly issues: readonly ValidationIssue[];
  /** True when more issues existed than were reported. */
  readonly truncated: boolean;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

/** Bounds the size of a failure, whatever the size of the hostile input. */
export const MAX_VALIDATION_ISSUES = 20;
