import type { CanonicalAction, PolicyDocument } from "@reflex/contracts";

import {
  compilePolicySet,
  evaluatePolicy,
  type CompiledPolicySet,
  type PolicyEvaluationResult,
  type PolicySourceDocument,
} from "./evaluator.js";
import { parsePolicy } from "./parser.js";

export const CONTEXT = { home: "/home/dev", projectRoot: "/work/project" };

const base = {
  id: "act_00000000000000000000000000000001",
  agent: { host: "claude-code" },
  sideEffectClass: "unknown",
  cwd: "/work/project",
  repository: { root: "/work/project" },
  createdAt: "2026-09-20T10:00:00.000Z",
} as const;

export function shell(command: string): CanonicalAction {
  return {
    ...base,
    tool: { name: "Bash" },
    arguments: { command },
    operands: { command: { raw: command } },
  };
}

export function fileTool(
  name: string,
  path: string,
  namespace?: string,
): CanonicalAction {
  return {
    ...base,
    tool: namespace === undefined ? { name } : { name, namespace },
    arguments: { file_path: path },
    operands: { paths: [path] },
  };
}

export function mcp(
  namespace: string,
  name: string,
  args: Record<string, unknown>,
): CanonicalAction {
  return { ...base, tool: { name, namespace }, arguments: args };
}

export function policy(yaml: string): PolicyDocument {
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

export function compiled(
  ...sources: readonly PolicySourceDocument[]
): CompiledPolicySet {
  const result = compilePolicySet(sources);
  if (!result.ok) {
    throw new Error(result.problems.join("\n"));
  }
  return result.set;
}

export const local = (yaml: string): PolicySourceDocument => ({
  source: "local",
  trusted: true,
  document: policy(yaml),
});

export function decide(
  set: CompiledPolicySet,
  action: CanonicalAction,
): PolicyEvaluationResult {
  return evaluatePolicy(set, action, CONTEXT);
}

/** The effect, or `unresolved`. */
export const effectOf = (
  set: CompiledPolicySet,
  action: CanonicalAction,
): string => decide(set, action).evaluation.effect ?? "unresolved";
