import type {
  CanonicalAction,
  DurationMs,
  SemanticDecisionRequest,
} from "@reflex/contracts";

import {
  DEFAULT_HISTORY_LIMITS,
  selectRelevantHistory,
  type HistoryEntry,
  type HistoryLimits,
} from "./history.js";
import type { RedactionHit, Redactor } from "./redact.js";
import { enforceBudget, type TruncationStep } from "./token-budget.js";

/**
 * RFX-033 — the semantic context compiler.
 *
 * From the raw action, in the daemon's memory, to the least a provider can
 * be given (`CLAUDE.md` principle 9): the fields `SemanticDecisionRequest`
 * selects by name, redacted (ADR-006), with the relevant history and the
 * policy hints, under the token budget (RFX-034). The compiler is the only
 * thing that turns a raw action into something that leaves the process,
 * and it has no path that skips the redactor.
 */
export interface ContextBudget {
  readonly maxInputTokens: number;
  readonly deadlineMs: DurationMs;
}

/** Structurally what `packages/core` expects of its `ContextCompiler` seam. */
export interface SemanticContextCompiler {
  compile(
    action: CanonicalAction,
    budget: ContextBudget,
  ): SemanticDecisionRequest;
  /** The same, with what happened on the way: for tests and records. */
  compileWithReport(
    action: CanonicalAction,
    budget: ContextBudget,
  ): CompileReport;
}

export interface CompileReport {
  readonly request: SemanticDecisionRequest;
  readonly estimatedTokens: number;
  readonly truncated: readonly TruncationStep[];
  readonly redactions: readonly RedactionHit[];
  readonly historyItems: number;
}

export interface CompilerOptions {
  readonly redactor: Redactor;
  /** The session's history, newest last, when the daemon keeps one. */
  readonly history?: (action: CanonicalAction) => readonly HistoryEntry[];
  /** Policy hints for the action: rule names, never rule bodies. */
  readonly policyHints?: (action: CanonicalAction) => readonly string[];
  readonly historyLimits?: HistoryLimits;
  readonly clock?: () => Date;
}

export function createContextCompiler(
  options: CompilerOptions,
): SemanticContextCompiler {
  const clock = options.clock ?? (() => new Date());
  const historyLimits = options.historyLimits ?? DEFAULT_HISTORY_LIMITS;

  function compileWithReport(
    action: CanonicalAction,
    budget: ContextBudget,
  ): CompileReport {
    const history = options.history?.(action) ?? [];
    const selected = selectRelevantHistory(
      history,
      action,
      clock(),
      historyLimits,
    );
    const withHistory: CanonicalAction =
      selected.length === 0 ? action : { ...action, priorActions: selected };
    const redacted = options.redactor.redactAction(withHistory);
    const redactions = [...redacted.hits];
    // A hint comes from policy, and a rule about a specific secret names it.
    const hints = options.policyHints?.(action).map((hint) => {
      const clean = options.redactor.redactText(hint);
      redactions.push(...clean.hits);
      return clean.text;
    });
    // The repository's root is a path on this machine; the branch and the
    // remote are what say which project this is.
    const repository =
      redacted.repository === undefined
        ? undefined
        : {
            ...(redacted.repository.branch === undefined
              ? {}
              : { branch: redacted.repository.branch }),
            ...(redacted.repository.remoteHost === undefined
              ? {}
              : { remoteHost: redacted.repository.remoteHost }),
          };

    const request: SemanticDecisionRequest = {
      action: {
        ...(redacted.userObjective === undefined
          ? {}
          : { userObjective: redacted.userObjective }),
        ...(redacted.taskSummary === undefined
          ? {}
          : { taskSummary: redacted.taskSummary }),
        tool: redacted.tool,
        ...(redacted.operation === undefined
          ? {}
          : { operation: redacted.operation }),
        arguments: redacted.arguments,
        ...(redacted.resource === undefined
          ? {}
          : { resource: redacted.resource }),
        sideEffectClass: redacted.sideEffectClass,
        ...(repository === undefined || Object.keys(repository).length === 0
          ? {}
          : { repository }),
        ...(redacted.priorActions === undefined
          ? {}
          : { priorActions: redacted.priorActions }),
      },
      ...(hints === undefined || hints.length === 0
        ? {}
        : { policyHints: hints }),
      maxInputTokens: budget.maxInputTokens,
      deadlineMs: budget.deadlineMs,
    };
    const budgeted = enforceBudget(request, budget.maxInputTokens);
    return {
      request: budgeted.request,
      estimatedTokens: budgeted.estimatedTokens,
      truncated: budgeted.truncated,
      redactions,
      historyItems: selected.length,
    };
  }

  return {
    compile: (action, budget) => compileWithReport(action, budget).request,
    compileWithReport,
  };
}
