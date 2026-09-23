import type { SemanticDecisionRequest } from "@reflex/contracts";

/**
 * RFX-034 — the token budget.
 *
 * `CLAUDE.md` principle 9: median semantic input under 600 tokens. The
 * budget applies to the state the provider is given (the questions are
 * the provider package's own fixed cost). Tokens are estimated from bytes,
 * conservatively, and the estimate is held against a named tokenizer in
 * tests (`docs/context-compiler.md` §3).
 *
 * When the request is over budget, optional context goes first and in a
 * fixed order; the required fields never do: the tool, the operation, the
 * side-effect class and the resource are what a decision is about, and a
 * provider that does not see them cannot assess anything.
 */
export const BYTES_PER_TOKEN = 4;

export function estimateTokens(value: unknown): number {
  const text =
    typeof value === "string"
      ? value
      : value === undefined
        ? ""
        : JSON.stringify(value);
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

export const TRUNCATION_MARK = "…[truncated]";

export const TRUNCATION_STEPS = [
  "policyHints",
  "priorActions",
  "taskSummary",
  "userObjective",
  "toolDescription",
  "arguments",
] as const;
export type TruncationStep = (typeof TRUNCATION_STEPS)[number];

export interface BudgetReport {
  readonly request: SemanticDecisionRequest;
  readonly estimatedTokens: number;
  readonly truncated: readonly TruncationStep[];
}

/** The longest an optional text may be after a cut, in characters. */
const SHORT_TEXT = 200;
/** Argument values longer than this are cut to it, longest first. */
const ARGUMENT_FLOOR = 120;

function cut(text: string, length: number): string {
  return text.length <= length
    ? text
    : `${text.slice(0, length)}${TRUNCATION_MARK}`;
}

function cutArguments(
  args: Readonly<Record<string, unknown>>,
  length: number,
): Readonly<Record<string, unknown>> {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return cut(node, length);
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (typeof node === "object" && node !== null) {
      return Object.fromEntries(
        Object.entries(node).map(([key, value]) => [key, walk(value)]),
      );
    }
    return node;
  };
  return walk(args) as Readonly<Record<string, unknown>>;
}

/** What the estimate counts: the state, not the whole request envelope. */
export function stateOf(request: SemanticDecisionRequest): unknown {
  return { action: request.action, policyHints: request.policyHints };
}

export function enforceBudget(
  request: SemanticDecisionRequest,
  maxTokens: number,
): BudgetReport {
  let current = request;
  const truncated: TruncationStep[] = [];
  const over = (): boolean => estimateTokens(stateOf(current)) > maxTokens;

  if (!over()) {
    return {
      request,
      estimatedTokens: estimateTokens(stateOf(request)),
      truncated,
    };
  }
  for (const step of TRUNCATION_STEPS) {
    const next = apply(step, current);
    if (next !== current) {
      current = next;
      truncated.push(step);
    }
    if (!over()) {
      break;
    }
  }
  return {
    request: current,
    estimatedTokens: estimateTokens(stateOf(current)),
    truncated,
  };
}

function apply(
  step: TruncationStep,
  request: SemanticDecisionRequest,
): SemanticDecisionRequest {
  const { action } = request;
  switch (step) {
    case "policyHints": {
      if (request.policyHints === undefined) {
        return request;
      }
      const rest = { ...request };
      delete rest.policyHints;
      return rest;
    }
    case "priorActions": {
      if (action.priorActions === undefined) {
        return request;
      }
      const actionRest = { ...action };
      delete actionRest.priorActions;
      return { ...request, action: actionRest };
    }
    case "taskSummary":
      return action.taskSummary === undefined ||
        action.taskSummary.length <= SHORT_TEXT
        ? request
        : {
            ...request,
            action: {
              ...action,
              taskSummary: cut(action.taskSummary, SHORT_TEXT),
            },
          };
    case "userObjective":
      return action.userObjective === undefined ||
        action.userObjective.length <= SHORT_TEXT
        ? request
        : {
            ...request,
            action: {
              ...action,
              userObjective: cut(action.userObjective, SHORT_TEXT),
            },
          };
    case "toolDescription": {
      if (action.tool.description === undefined) {
        return request;
      }
      const tool = { ...action.tool };
      delete tool.description;
      return { ...request, action: { ...action, tool } };
    }
    case "arguments": {
      const shortened = cutArguments(action.arguments, ARGUMENT_FLOOR);
      return JSON.stringify(shortened) === JSON.stringify(action.arguments)
        ? request
        : { ...request, action: { ...action, arguments: shortened } };
    }
  }
}
