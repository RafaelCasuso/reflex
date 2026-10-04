import type {
  CanonicalAction,
  DecisionRequest,
  FailureMode,
  ReflexMode,
  SemanticAssessment,
  SideEffectClass,
} from "@reflex-control/contracts";
import {
  compilePolicySet,
  parsePolicy,
  type CompiledPolicySet,
  type PolicySourceDocument,
} from "@reflex-control/policy-engine";
import {
  createFakeProvider,
  type FakeBehavior,
  type FakeProvider,
} from "@reflex-control/semantic-provider";

import type {
  Aggregation,
  ContextCompiler,
  RiskAggregator,
  SemanticStage,
} from "./semantic-stage.js";

export const HOME = "/home/dev";
export const PROJECT = "/work/project";

const base = {
  id: "act_00000000000000000000000000000001",
  agent: { host: "claude-code" },
  sideEffectClass: "unknown",
  cwd: PROJECT,
  repository: { root: PROJECT },
  createdAt: "2026-09-22T10:00:00.000Z",
} as const;

export function shell(command: string): CanonicalAction {
  return {
    ...base,
    tool: { name: "Bash" },
    arguments: { command },
    operands: { command: { raw: command } },
  };
}

export function fileTool(name: string, path: string): CanonicalAction {
  return {
    ...base,
    tool: { name },
    arguments: { file_path: path },
    operands: { paths: [path] },
  };
}

export function mcp(
  namespace: string,
  name: string,
  args: Record<string, unknown> = {},
): CanonicalAction {
  return { ...base, tool: { name, namespace }, arguments: args };
}

/** An action the adapter already classed. The engine may raise it, never lower it. */
export function classed(
  action: CanonicalAction,
  sideEffectClass: SideEffectClass,
): CanonicalAction {
  return { ...action, sideEffectClass };
}

export function request(
  action: CanonicalAction,
  overrides: Partial<Omit<DecisionRequest, "action">> = {},
): DecisionRequest {
  return {
    action,
    mode: "autopilot" satisfies ReflexMode,
    failureMode: "fail-ask" satisfies FailureMode,
    ...overrides,
  };
}

export function policyDocument(yaml: string) {
  const parsed = parsePolicy(yaml);
  if (!parsed.ok) {
    throw new Error(
      parsed.issues
        .map((issue) => `${String(issue.line)}: ${issue.message}`)
        .join("\n"),
    );
  }
  return parsed.document;
}

export const local = (yaml: string): PolicySourceDocument => ({
  source: "local",
  trusted: true,
  document: policyDocument(yaml),
});

export const untrustedProject = (yaml: string): PolicySourceDocument => ({
  source: "project",
  trusted: false,
  document: policyDocument(yaml),
});

export function compiled(
  ...sources: readonly PolicySourceDocument[]
): CompiledPolicySet {
  const result = compilePolicySet(sources);
  if (!result.ok) {
    throw new Error(result.problems.join("\n"));
  }
  return result.set;
}

/** Nothing decides: every action reaches whatever comes after policy. */
export const SEMANTIC_ONLY = `
version: 1
defaults:
  unresolved: semantic
rules: []
`;

export const ASK_BY_DEFAULT = `
version: 1
defaults:
  unresolved: ask
rules: []
`;

export const DENY_BY_DEFAULT = `
version: 1
defaults:
  unresolved: deny
rules: []
`;

export function assessment(
  overrides: Partial<SemanticAssessment> = {},
): SemanticAssessment {
  const score = (value: number) => ({ value, confidence: 0.9 });
  return {
    objectiveAlignment: score(90),
    destructiveRisk: score(5),
    reversibility: score(95),
    externalSideEffect: { value: false, confidence: 0.9 },
    privilegeEscalation: score(0),
    secretAccess: score(0),
    sensitiveDataExposure: score(0),
    financialConsequence: score(0),
    productionMutation: score(0),
    unusualScope: score(5),
    untrustedInput: score(5),
    provider: "fake",
    model: "fake-1",
    latencyMs: 1,
    ...overrides,
  };
}

/** Selects the fields by name, as the G5 compiler will; no redaction here. */
export const passThroughCompiler: ContextCompiler = {
  compile(action, budget) {
    return {
      action: {
        tool: action.tool,
        arguments: action.arguments,
        sideEffectClass: action.sideEffectClass,
        ...(action.userObjective === undefined
          ? {}
          : { userObjective: action.userObjective }),
      },
      maxInputTokens: budget.maxInputTokens,
      deadlineMs: budget.deadlineMs,
    };
  },
};

export function fixedAggregator(
  aggregation: Partial<Aggregation> = {},
): RiskAggregator {
  return {
    aggregate: () => ({
      effect: "allow",
      risk: 10,
      confidence: 0.9,
      reasonCodes: [],
      ...aggregation,
    }),
  };
}

export interface StageHarness {
  readonly stage: SemanticStage;
  readonly provider: FakeProvider;
}

/** The fake answers a fixed assessment unless told to misbehave. */
export function stage(
  behavior: FakeBehavior = { kind: "fixed", assessment: assessment() },
  overrides: Partial<Omit<SemanticStage, "provider">> = {},
): StageHarness {
  const provider = createFakeProvider({ behavior });
  return {
    provider,
    stage: {
      provider,
      compiler: passThroughCompiler,
      aggregator: fixedAggregator(),
      maxInputTokens: 600,
      ...overrides,
    },
  };
}
