/**
 * @reflex-control/core — Decision orchestration and domain logic.
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
  SEMANTIC_CACHEABLE_CLASSES,
  isCacheable,
  isSemanticCacheable,
  type CacheabilityInput,
  type CachedDecision,
  type DecisionCacheOptions,
} from "./cache.js";
export {
  createDecisionEngine,
  type DeadlineOptions,
  type DecisionEngine,
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
export {
  DEFAULT_OVERRIDE_OPTIONS,
  OverrideStore,
  type OverrideCounters,
  type OverrideGrant,
  type OverrideRefusal,
  type OverrideResult,
  type OverrideStoreOptions,
  type RememberedDecision,
} from "./overrides.js";
export { DETERMINISTIC_RISK, reasonForClass, riskOf } from "./risk.js";
export {
  DEFAULT_AGGREGATOR_CONFIG,
  REASON_BY_DIMENSION,
  RISK_DIMENSIONS,
  SAFETY_DIMENSIONS,
  createRiskAggregator,
  type AggregatorConfig,
  type Band,
  type LowConfidenceRule,
  type RiskDimension,
  type SafetyDimension,
  type ScoredDimension,
} from "./risk-aggregator.js";
export type {
  Aggregation,
  AggregationInput,
  AggregationPolicyInput,
  ContextBudget,
  ContextCompiler,
  RiskAggregator,
  DecisionObservation,
  DecisionObserver,
  PrimaryEvaluation,
  SemanticStage,
  ShadowObservation,
  ShadowObserver,
  ShadowProvider,
  ShadowSample,
} from "./semantic-stage.js";
