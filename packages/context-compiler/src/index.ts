/**
 * @reflex/context-compiler — minimal semantic context, redacted locally.
 *
 * The redactor (ADR-006), the relevant-history selector, the token budget
 * and the compiler that puts them together. Raw values enter; only a
 * redacted, bounded `SemanticDecisionRequest` leaves. No I/O anywhere in
 * this package: the key, the clock and the history are given to it.
 */
export {
  PLACEHOLDER,
  SECRET_KINDS,
  SECRET_PATTERNS,
  type SecretKind,
  type SecretPattern,
} from "./patterns.js";
export {
  FINGERPRINT_HEX,
  REDACTION_KEY_BYTES,
  createRedactor,
  type RedactedAction,
  type RedactedText,
  type RedactionHit,
  type Redactor,
  type RedactorOptions,
} from "./redact.js";
export {
  DEFAULT_HISTORY_LIMITS,
  DEFAULT_MEMORY_LIMITS,
  SessionMemory,
  historyEntryOf,
  selectRelevantHistory,
  type HistoryEntry,
  type HistoryLimits,
  type MemoryLimits,
} from "./history.js";
export {
  BYTES_PER_TOKEN,
  TRUNCATION_MARK,
  TRUNCATION_STEPS,
  enforceBudget,
  estimateTokens,
  stateOf,
  type BudgetReport,
  type TruncationStep,
} from "./token-budget.js";
export {
  createContextCompiler,
  type CompileReport,
  type CompilerOptions,
  type ContextBudget,
  type SemanticContextCompiler,
} from "./compile.js";
