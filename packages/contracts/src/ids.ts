/**
 * Prefixed opaque IDs.
 *
 * An ID is `<prefix>_<body>`. The prefix says what the ID identifies; the body
 * is opaque and carries no meaning. Template-literal types make IDs of
 * different kinds mutually unassignable at compile time, and a plain `string`
 * unassignable to any of them.
 *
 * This map is the registry of prefixes. Adding one is an additive contract
 * change (ADR-009).
 */
export const ID_PREFIXES = {
  decision: "dec",
  action: "act",
  agent: "agt",
  project: "prj",
  organization: "org",
  policy: "pol",
  session: "ses",
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

export type OpaqueId<Prefix extends IdPrefix> = `${Prefix}_${string}`;

export type DecisionId = OpaqueId<"dec">;
export type ActionId = OpaqueId<"act">;
export type AgentId = OpaqueId<"agt">;
export type ProjectId = OpaqueId<"prj">;
export type OrganizationId = OpaqueId<"org">;
export type PolicyId = OpaqueId<"pol">;
export type SessionId = OpaqueId<"ses">;

/** Longest permitted ID body. Generous enough for UUIDs, ULIDs and nanoids. */
export const ID_BODY_MAX_LENGTH = 128;

/**
 * IDs end up in log lines, metric labels, URLs, file names and cache keys.
 * The body is therefore restricted to characters that are inert in all of
 * them: no separators, no whitespace, no dots, no control characters.
 */
const ID_PATTERNS: Readonly<Record<IdPrefix, RegExp>> = Object.fromEntries(
  Object.values(ID_PREFIXES).map((prefix) => [
    prefix,
    new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,${String(ID_BODY_MAX_LENGTH)}}$`),
  ]),
) as Record<IdPrefix, RegExp>;

/** Runtime guard. The only way an untrusted string becomes a typed ID. */
export function isOpaqueId<Prefix extends IdPrefix>(
  prefix: Prefix,
  value: unknown,
): value is OpaqueId<Prefix> {
  return typeof value === "string" && ID_PATTERNS[prefix].test(value);
}
