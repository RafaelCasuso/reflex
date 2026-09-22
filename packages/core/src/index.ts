/**
 * @reflex/core — Decision orchestration and domain logic.
 *
 * The engine orders the stages of a decision (ADR-002), applies the failure
 * modes (ADR-003) and keeps the deterministic cache (RFX-106). It depends on
 * the policy engine and on the contracts, and on a provider only through its
 * interface (CLAUDE.md principle 3).
 */
export {
  DecisionCache,
  DEFAULT_CACHE_OPTIONS,
  NEVER_CACHED_CLASSES,
  isCacheable,
  type CacheabilityInput,
  type CachedDecision,
  type DecisionCacheOptions,
} from "./cache.js";
export {
  createDecisionEngine,
  type DeadlineOptions,
  type DecisionEngineOptions,
  type PathOptions,
  type ReflexDecisionEngine,
} from "./decision-engine.js";
export {
  DEFAULT_FAILURE_MODE,
  FAILURE_MODE_CEILING,
  fallbackEffect,
  fallbackReasonCode,
  resolveFailureMode,
  strictestFailureMode,
  type FailureModeInput,
} from "./fallback.js";
export {
  decisionCacheKey,
  fingerprintAction,
  type CacheKeyInput,
} from "./fingerprint.js";
export { effectiveEffectOf } from "./modes.js";
export { DETERMINISTIC_RISK, reasonForClass, riskOf } from "./risk.js";
export type {
  Aggregation,
  AggregationInput,
  AggregationPolicyInput,
  ContextBudget,
  ContextCompiler,
  RiskAggregator,
  SemanticStage,
} from "./semantic-stage.js";
