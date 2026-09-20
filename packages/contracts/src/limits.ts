/**
 * Size limits that are part of the contract.
 *
 * They exist so that validation work, log lines, metric labels and stored rows
 * are bounded by the contract and not by an attacker. Transport-level limits
 * (HTTP body size) belong to the gateway and come on top of these.
 *
 * Loosening a limit is an additive change. Tightening one is breaking
 * (ADR-009). They are deliberately generous.
 */
export const CONTRACT_LIMITS = {
  /**
   * Names used as policy match keys and metric labels: tool name, namespace,
   * operation, provider, rule ID.
   */
  nameLength: 256,
  /** Free text: objectives, summaries, descriptions, feedback notes. */
  textLength: 8_192,
  /** Paths and resource identifiers. Matches PATH_MAX on Linux. */
  pathLength: 4_096,
  /** Content hashes and cache keys. */
  hashLength: 256,

  priorActions: 100,
  policyMatches: 256,
  reasonCodes: 64,

  /** Nesting depth of `arguments` and `adapterMetadata`. */
  jsonDepth: 64,
  /** Total values in `arguments` or `adapterMetadata`. Bounds validation CPU. */
  jsonNodes: 100_000,

  /**
   * A shell command as one string (v1.2). Far larger than other text because a
   * command can carry a whole file in a here-document.
   */
  commandLength: 1_048_576,
  /** Entries of an operand list: argument vector, paths, network hosts (v1.2). */
  operandItems: 1_024,
} as const;
