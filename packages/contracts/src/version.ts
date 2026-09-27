/**
 * Version of the canonical contracts (ADR-009).
 *
 * - `major` changes on a breaking change. It is the `v1` in `/v1/decisions`.
 * - `minor` changes on every additive change. Each minor freezes a fixture set
 *   under `fixtures/`, and every frozen set must keep parsing forever within
 *   the same major.
 */
export const CONTRACT_VERSION = { major: 1, minor: 4 } as const;

export type ContractVersion = typeof CONTRACT_VERSION;
