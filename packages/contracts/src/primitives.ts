/**
 * Primitive vocabulary shared by every contract.
 *
 * Each closed set is declared once as a readonly tuple. The union type and the
 * runtime validator both derive from it, so they cannot drift apart.
 *
 * Adding a member to any of these sets changes what REFLEX can express.
 * See ADR-009 for which additions are compatible and which are not.
 */

/** Decision precedence is `deny > ask > allow` (CLAUDE.md). */
export const DECISION_EFFECTS = ["allow", "ask", "deny"] as const;
export type DecisionEffect = (typeof DECISION_EFFECTS)[number];

export const REFLEX_MODES = ["observe", "assist", "autopilot"] as const;
export type ReflexMode = (typeof REFLEX_MODES)[number];

export const FAILURE_MODES = ["fail-open", "fail-ask", "fail-closed"] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

/** Host identity is a value from this set, never a host-shaped structure. */
export const HOST_KINDS = [
  "claude-code",
  "codex",
  "mcp",
  "sdk-typescript",
  "sdk-python",
  "http",
] as const;
export type HostKind = (typeof HOST_KINDS)[number];

export const ENVIRONMENT_KINDS = [
  "local",
  "development",
  "test",
  "staging",
  "production",
  "unknown",
] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

/**
 * `unknown` is a first-class value and is never safe. An adapter that cannot
 * classify an action says so; it does not default to a benign class
 * (ADR-001 §4).
 */
export const SIDE_EFFECT_CLASSES = [
  "none",
  "local-read",
  "local-write",
  "external-read",
  "external-write",
  "destructive",
  "financial",
  "privilege",
  "credential",
  "unknown",
] as const;
export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number];

/**
 * Integer `0..100`. What "high" means is defined by the field that uses it.
 */
export type Score = number;

/** Integer `0..100`, higher is more dangerous. */
export type RiskScore = Score;

/** Float `0..1`. */
export type Confidence = number;

/** ISO 8601, UTC, `Z` suffix. Offsets are not accepted at service boundaries. */
export type IsoTimestamp = string;

/** Non-negative integer milliseconds. */
export type DurationMs = number;
