import { randomBytes } from "node:crypto";

import type {
  CanonicalAction,
  DecisionEffect,
  DecisionEngine,
  DecisionId,
  DecisionLatency,
  DecisionRequest,
  DurationMs,
  FailureMode,
  FallbackReason,
  PolicyMatch,
  ReasonCode,
  ReflexDecision,
  SemanticAssessment,
} from "@reflex/contracts";
import {
  evaluatePolicy,
  mostRestrictive,
  type CompiledPolicySet,
  type PolicyEvaluationResult,
} from "@reflex/policy-engine";

import { DecisionCache, isCacheable, type CachedDecision } from "./cache.js";
import {
  fallbackEffect,
  fallbackReasonCode,
  resolveFailureMode,
} from "./fallback.js";
import { decisionCacheKey, fingerprintAction } from "./fingerprint.js";
import { effectiveEffectOf } from "./modes.js";
import { reasonForClass, riskOf } from "./risk.js";
import type { SemanticStage } from "./semantic-stage.js";

/**
 * RFX-019 — the decision engine (ADR-002 §1).
 *
 * 1. Deterministic policy. If it resolves, that is the decision and nothing
 *    after it runs: the provider is not called at all.
 * 2. `defaults.unresolved`: `ask` and `deny` are final; `semantic` continues.
 *    With no semantic stage configured, `semantic` is read as `ask`.
 * 3. Semantic aggregation, inside the deadline (RFX-022).
 * 4. Fallback (ADR-003, RFX-020), when a stage that was needed could not
 *    complete.
 *
 * `effect` is computed the same way in every mode; the mode only sets
 * `effectiveEffect`. The engine reads the action and writes a decision. It
 * does no I/O of its own: the policy set, the clock and every remote thing
 * are given to it.
 */
export interface DeadlineOptions {
  /** When the request names none. */
  readonly defaultMs: DurationMs;
  /** A request may ask for less, never for more. */
  readonly maxMs: DurationMs;
}

export interface PathOptions {
  /** What `~` and `${home}` stand for in a policy. */
  readonly home?: string;
}

export interface DecisionEngineOptions {
  /**
   * The compiled set in force for this action, read per decision so that the
   * daemon can replace it between two calls and serve one project's policy
   * to that project. A set that failed to compile is the caller's concern
   * (ADR-003 §3): the last good one stays in force.
   */
  readonly policy: (action: CanonicalAction) => CompiledPolicySet;
  /** Absent means REFLEX has nothing to assess with (ADR-002 §1, stage 2). */
  readonly semantic?: SemanticStage;
  /** Resolved from configuration by the caller, like policy (ADR-003 §1). */
  readonly failureMode: FailureMode;
  readonly deadline: DeadlineOptions;
  readonly paths?: PathOptions;
  /** Absent means no caching (RFX-106). */
  readonly cache?: DecisionCache;
  readonly clock?: () => Date;
  /** Monotonic milliseconds, for latency and cache expiry. */
  readonly monotonic?: () => number;
  /** The fingerprint key (ADR-006). Random per engine when absent. */
  readonly fingerprintKey?: Uint8Array;
  readonly newDecisionId?: () => DecisionId;
}

export interface ReflexDecisionEngine extends DecisionEngine {
  /** The same keyed fingerprint the cache uses, for the caller's own keys. */
  fingerprint(action: CanonicalAction): string;
}

const NO_MATCHES: readonly PolicyMatch[] = [];

/** ADR-012: whatever decides after policy may not go under an untrusted `ask`. */
function raisedToFloor(
  effect: DecisionEffect,
  floor: DecisionEffect | undefined,
): DecisionEffect {
  return floor === undefined
    ? effect
    : (mostRestrictive([effect, floor]) ?? effect);
}

function newDecisionId(): DecisionId {
  return `dec_${randomBytes(16).toString("hex")}`;
}

function withClassReason(
  codes: readonly ReasonCode[],
  sideEffectClass: PolicyEvaluationResult["sideEffectClass"],
): readonly ReasonCode[] {
  const classReason = reasonForClass(sideEffectClass);
  return classReason === undefined || codes.includes(classReason)
    ? codes
    : [...codes, classReason];
}

interface Verdict {
  readonly effect: DecisionEffect;
  readonly risk: ReflexDecision["risk"];
  readonly confidence: ReflexDecision["confidence"];
  readonly reasonCodes: readonly ReasonCode[];
  readonly semanticAssessment?: SemanticAssessment;
  readonly fallback?: ReflexDecision["fallback"];
  readonly contextMs?: number;
  readonly semanticMs?: number;
  readonly aggregationMs?: number;
  /**
   * A pure function of the action and the policy set, and nothing else: what
   * the cache may keep (RFX-106). An `ask` for want of a provider is not,
   * because a provider can be configured while the daemon runs.
   */
  readonly cacheable: boolean;
}

type ProviderOutcome =
  | {
      readonly ok: true;
      readonly assessment: SemanticAssessment;
      readonly contextMs: number;
    }
  | {
      readonly ok: false;
      readonly reason: FallbackReason;
      readonly contextMs: number;
    };

export function createDecisionEngine(
  options: DecisionEngineOptions,
): ReflexDecisionEngine {
  const clock = options.clock ?? (() => new Date());
  const monotonic = options.monotonic ?? (() => performance.now());
  const key = options.fingerprintKey ?? randomBytes(32);
  const nextId = options.newDecisionId ?? newDecisionId;
  const semantic = options.semantic;
  const cache = options.cache;

  const fingerprint = (action: CanonicalAction): string =>
    fingerprintAction(action, key);

  const deadlineOf = (request: DecisionRequest): number =>
    Math.min(
      request.deadlineMs ?? options.deadline.defaultMs,
      options.deadline.maxMs,
    );

  async function assess(
    request: DecisionRequest,
    remainingMs: number,
    signal: AbortSignal | undefined,
    stage: SemanticStage,
  ): Promise<ProviderOutcome> {
    // Whole milliseconds, rounded down: a deadline is never extended.
    const budgetMs = Math.floor(remainingMs);
    if (budgetMs <= 0) {
      return { ok: false, reason: "timeout", contextMs: 0 };
    }
    const timeout = AbortSignal.timeout(budgetMs);
    const combined =
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const compileStarted = monotonic();
    let contextMs = 0;
    try {
      const compiled = stage.compiler.compile(request.action, {
        maxInputTokens: stage.maxInputTokens,
        deadlineMs: budgetMs,
      });
      contextMs = monotonic() - compileStarted;
      const assessment = await stage.provider.evaluate(compiled, combined);
      return { ok: true, assessment, contextMs };
    } catch {
      // ADR-005 §2: nothing the provider says is read. Aborted, by the
      // deadline or by the caller, is a timeout; anything else is the
      // provider's failure, a thrown exception included. A compiler that
      // throws is a bug of the same kind and ends the same way.
      return {
        ok: false,
        reason: combined.aborted ? "timeout" : "provider-error",
        contextMs,
      };
    }
  }

  async function verdictOf(
    request: DecisionRequest,
    evaluation: PolicyEvaluationResult,
    startedAt: number,
    signal: AbortSignal | undefined,
  ): Promise<Verdict> {
    const { sideEffectClass, floor } = evaluation;
    const risk = riskOf(sideEffectClass);

    // Stage 1: a rule decided.
    if (
      evaluation.evaluation.resolved &&
      evaluation.evaluation.effect !== undefined
    ) {
      const effect = evaluation.evaluation.effect;
      return {
        effect,
        risk,
        confidence: 1,
        reasonCodes: withClassReason([`explicit_${effect}`], sideEffectClass),
        cacheable: true,
      };
    }

    // Stage 2: the policy's own default for what no rule decided.
    if (evaluation.unresolved !== "semantic") {
      return {
        effect: raisedToFloor(evaluation.unresolved, floor),
        risk,
        confidence: 1,
        reasonCodes: withClassReason(["unknown_risk"], sideEffectClass),
        cacheable: true,
      };
    }

    if (semantic === undefined) {
      // ADR-002 §1: with no provider configured, `semantic` is read as `ask`.
      // Nothing failed, so this is not a fallback; nothing assessed the
      // action either, so the confidence is none.
      return {
        effect: "ask",
        risk,
        confidence: 0,
        reasonCodes: withClassReason(["unknown_risk"], sideEffectClass),
        cacheable: false,
      };
    }

    // Stage 3: the semantic stage, inside what is left of the deadline.
    const deadlineMs = deadlineOf(request);
    const semanticStarted = monotonic();
    const outcome = await assess(
      request,
      deadlineMs - (semanticStarted - startedAt),
      signal,
      semantic,
    );
    const semanticMs = monotonic() - semanticStarted;

    if (outcome.ok) {
      const aggregationStarted = monotonic();
      const aggregated = semantic.aggregator.aggregate({
        action: request.action,
        assessment: outcome.assessment,
        policy: {
          matches: evaluation.evaluation.matches,
          floor,
          sideEffectClass,
        },
      });
      return {
        effect: raisedToFloor(aggregated.effect, floor),
        risk: aggregated.risk,
        confidence: aggregated.confidence,
        reasonCodes: withClassReason(aggregated.reasonCodes, sideEffectClass),
        semanticAssessment: outcome.assessment,
        contextMs: outcome.contextMs,
        semanticMs,
        aggregationMs: monotonic() - aggregationStarted,
        cacheable: false,
      };
    }

    // Stage 4: the stage that was needed could not complete.
    const configuredMode = resolveFailureMode({
      requested: request.failureMode,
      configured: options.failureMode,
      sideEffectClass,
    });
    return {
      effect: raisedToFloor(fallbackEffect(configuredMode), floor),
      risk,
      confidence: 0,
      reasonCodes: withClassReason(
        [fallbackReasonCode(outcome.reason)],
        sideEffectClass,
      ),
      fallback: { used: true, reason: outcome.reason, configuredMode },
      contextMs: outcome.contextMs,
      semanticMs,
      cacheable: false,
    };
  }

  function fromCache(
    request: DecisionRequest,
    cached: CachedDecision,
    cacheKey: string,
    startedAt: number,
  ): ReflexDecision {
    return {
      id: nextId(),
      actionId: request.action.id,
      effect: cached.effect,
      effectiveEffect: effectiveEffectOf(request.mode, cached.effect),
      mode: request.mode,
      risk: cached.risk,
      confidence: cached.confidence,
      reasonCodes: cached.reasonCodes,
      policyMatches: cached.policyMatches,
      policySetHash: cached.policySetHash,
      cached: true,
      cacheKey,
      latency: { totalMs: Math.round(monotonic() - startedAt), policyMs: 0 },
      decidedAt: clock().toISOString(),
    };
  }

  return {
    fingerprint,

    async decide(request, signal): Promise<ReflexDecision> {
      const startedAt = monotonic();
      const set = options.policy(request.action);
      const action = request.action;

      let cacheKey: string | undefined;
      if (cache !== undefined) {
        cacheKey = decisionCacheKey({
          fingerprint: fingerprint(action),
          policySetHash: set.hash,
          ...(action.projectId === undefined
            ? {}
            : { projectId: action.projectId }),
          ...(action.resource === undefined
            ? {}
            : { environment: action.resource.environment }),
        });
        const hit = cache.get(cacheKey, startedAt);
        if (hit !== undefined) {
          return fromCache(request, hit, cacheKey, startedAt);
        }
      }

      const evaluation = evaluatePolicy(set, action, {
        ...(options.paths?.home === undefined
          ? {}
          : { home: options.paths.home }),
      });
      const verdict = await verdictOf(request, evaluation, startedAt, signal);
      const finishedAt = monotonic();

      const latency: DecisionLatency = {
        totalMs: Math.round(finishedAt - startedAt),
        policyMs: Math.round(evaluation.elapsedMs),
        ...(verdict.contextMs === undefined
          ? {}
          : { contextMs: Math.round(verdict.contextMs) }),
        ...(verdict.semanticMs === undefined
          ? {}
          : { semanticMs: Math.round(verdict.semanticMs) }),
        ...(verdict.aggregationMs === undefined
          ? {}
          : { aggregationMs: Math.round(verdict.aggregationMs) }),
      };

      const decision: ReflexDecision = {
        id: nextId(),
        actionId: action.id,
        effect: verdict.effect,
        effectiveEffect: effectiveEffectOf(request.mode, verdict.effect),
        mode: request.mode,
        risk: verdict.risk,
        confidence: verdict.confidence,
        reasonCodes: verdict.reasonCodes,
        policyMatches:
          evaluation.evaluation.matches.length === 0
            ? NO_MATCHES
            : evaluation.evaluation.matches,
        ...(verdict.semanticAssessment === undefined
          ? {}
          : { semanticAssessment: verdict.semanticAssessment }),
        policySetHash: set.hash,
        cached: false,
        ...(cacheKey === undefined ? {} : { cacheKey }),
        ...(verdict.fallback === undefined
          ? {}
          : { fallback: verdict.fallback }),
        latency,
        decidedAt: clock().toISOString(),
      };

      if (
        cache !== undefined &&
        cacheKey !== undefined &&
        verdict.cacheable &&
        isCacheable({
          sideEffectClass: evaluation.sideEffectClass,
          environment: action.resource?.environment,
        })
      ) {
        cache.set(
          cacheKey,
          {
            effect: decision.effect,
            risk: decision.risk,
            confidence: decision.confidence,
            reasonCodes: decision.reasonCodes,
            policyMatches: decision.policyMatches,
            policySetHash: set.hash,
            sideEffectClass: evaluation.sideEffectClass,
          },
          finishedAt,
        );
      }

      return decision;
    },
  };
}
