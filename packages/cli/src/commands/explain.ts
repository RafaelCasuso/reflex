import type {
  CanonicalAction,
  DecisionEffect,
  PolicyMatch,
  ReflexMode,
} from "@reflex-control/contracts";
import { effectiveEffectOf } from "@reflex-control/core";
import type { ProjectPolicyReading } from "@reflex-control/decision-gateway/policy.js";
import {
  evaluatePolicy,
  POLICY_SOURCES,
  precedenceOf,
  type PolicyEvaluationResult,
  type PolicySource,
} from "@reflex-control/policy-engine";

import type { FileSystemPort } from "../backups/file-system.js";
import type { SupportedHost } from "../hosts.js";
import { reflexHome, type Environment } from "../state.js";
import { composerFor } from "./trust.js";

/**
 * RFX-099 — `rfx explain`: why an action would be allowed, asked or denied.
 *
 * The answer comes from the same evaluation the daemon performs: the same
 * policy set (the user's `policy.yaml`, the project's `.reflex/policy.yaml`
 * under the same trust, REFLEX's own rules), the same evaluator, the same
 * path context. Nothing is re-implemented here; this file builds the
 * action, calls the engine's evaluator and prints what it returned. Works
 * offline: no daemon, no provider. What a provider would say for an
 * unresolved action is not known here, and the output says so.
 */
export interface ExplainRequest {
  readonly host: SupportedHost;
  /** A shell command, as the agent would run it. */
  readonly command?: string;
  /** A file tool and its path, as the agent would call it. */
  readonly tool?: string;
  readonly path?: string;
}

export interface ExplainMatch {
  readonly ruleId: string;
  readonly effect: DecisionEffect;
  readonly mandatory: boolean;
  readonly precedence: number;
  /** Which source the precedence belongs to (ADR-004). */
  readonly source: PolicySource | "unknown";
  readonly decides: boolean;
}

export interface Explanation {
  readonly action: CanonicalAction;
  readonly projectRoot: string | undefined;
  readonly sideEffectClass: PolicyEvaluationResult["sideEffectClass"];
  readonly understood: boolean;
  readonly subjects: PolicyEvaluationResult["subjects"];
  readonly matches: readonly ExplainMatch[];
  /** The policy's effect, or `undefined` when nothing resolved it. */
  readonly effect: DecisionEffect | undefined;
  readonly unresolved: PolicyEvaluationResult["unresolved"];
  readonly floor: DecisionEffect | undefined;
  /** What the hook would answer in each mode, for the policy's part. */
  readonly byMode: Readonly<Record<ReflexMode, DecisionEffect>>;
  readonly policySetHash: string;
  readonly projectPolicy: ProjectPolicyReading | undefined;
}

const PRECEDENCE_SOURCE: ReadonlyMap<number, PolicySource> = new Map(
  POLICY_SOURCES.flatMap((source) => [
    [precedenceOf(source, false), source],
    [precedenceOf(source, true), source],
  ]),
);

export function sourceOf(match: PolicyMatch): PolicySource | "unknown" {
  return PRECEDENCE_SOURCE.get(match.precedence) ?? "unknown";
}

export function actionFor(
  request: ExplainRequest,
  environment: Environment,
): CanonicalAction {
  const base = {
    id: "act_explain00000000000000000000000" as const,
    agent: { host: request.host },
    cwd: environment.projectDir,
    repository: { root: environment.projectDir },
    sideEffectClass: "unknown" as const,
    createdAt: environment.now().toISOString(),
  };
  if (request.command !== undefined) {
    return {
      ...base,
      tool: { name: "Bash" },
      arguments: { command: request.command },
      operands: { command: { raw: request.command } },
    };
  }
  const tool = request.tool ?? "Read";
  const path = request.path ?? environment.projectDir;
  const field = tool === "NotebookEdit" ? "notebook_path" : "file_path";
  return {
    ...base,
    tool: { name: tool },
    arguments: { [field]: path },
    operands: { paths: [path] },
  };
}

export async function explain(
  request: ExplainRequest,
  environment: Environment,
  fileSystem: FileSystemPort,
): Promise<Explanation> {
  const composer = await composerFor(environment, fileSystem);
  const action = actionFor(request, environment);
  const set = composer.setFor(action);
  const result = evaluatePolicy(set, action, { home: environment.homeDir });
  const effect =
    result.evaluation.resolved && result.evaluation.effect !== undefined
      ? result.evaluation.effect
      : undefined;
  // What policy alone makes of it per mode: an unresolved action asks when
  // the default is ask or semantic (no provider is consulted here), denies
  // when the default is deny; a floor from an untrusted source holds.
  const policyEffect: DecisionEffect =
    effect ??
    (result.unresolved === "deny"
      ? "deny"
      : result.floor === "deny"
        ? "deny"
        : "ask");
  const matches = result.evaluation.matches.map(
    (match, index): ExplainMatch => ({
      ruleId: match.ruleId,
      effect: match.effect,
      mandatory: match.mandatory,
      precedence: match.precedence,
      source: sourceOf(match),
      decides: index === 0 && effect !== undefined,
    }),
  );
  return {
    action,
    projectRoot: result.projectRoot,
    sideEffectClass: result.sideEffectClass,
    understood: result.understood,
    subjects: result.subjects,
    matches,
    effect,
    unresolved: result.unresolved,
    floor: result.floor,
    byMode: {
      observe: effectiveEffectOf("observe", policyEffect),
      assist: effectiveEffectOf("assist", policyEffect),
      autopilot: effectiveEffectOf("autopilot", policyEffect),
    },
    policySetHash: set.hash,
    projectPolicy: composer.inspect(environment.projectDir),
  };
}

export function renderExplanation(
  explanation: Explanation,
  environment: Environment,
): string {
  const { action } = explanation;
  const what =
    action.operands?.command !== undefined
      ? `Bash: ${action.operands.command.raw ?? ""}`
      : `${action.tool.name}: ${action.operands?.paths?.[0] ?? ""}`;
  const lines = [
    `Action       ${what}`,
    `Project      ${explanation.projectRoot ?? environment.projectDir}`,
    `Class        ${explanation.sideEffectClass}${explanation.understood ? "" : "  (not fully understood: no allow rule can match it)"}`,
  ];
  if (explanation.subjects.length > 1) {
    for (const subject of explanation.subjects) {
      lines.push(
        `             segment: ${subject.sideEffectClass}${subject.paths.length === 0 ? "" : ` on ${subject.paths.join(", ")}`}`,
      );
    }
  }
  const project = explanation.projectPolicy;
  lines.push(
    `Policy       user ${reflexHome(environment)}/policy.yaml; project ${
      project === undefined
        ? "none"
        : project.problems.length > 0
          ? `${project.path} (not loaded: ${project.problems[0] ?? "invalid"})`
          : `${project.path} (${project.trusted ? "trusted" : `untrusted: its ${String(project.allowRules.length)} allow rule(s) are ignored, "rfx trust" to review`})`
    }; REFLEX's own rules`,
    `Set          ${explanation.policySetHash}`,
  );
  if (explanation.matches.length === 0) {
    lines.push("Matched      no rule");
  } else {
    lines.push("Matched");
    for (const match of explanation.matches) {
      lines.push(
        `  ${match.effect.padEnd(5)}  ${match.ruleId.padEnd(36)}  ${match.source.padEnd(12)} precedence ${String(match.precedence).padStart(3)}${match.mandatory ? "  mandatory" : ""}${match.decides ? "  <- decides" : ""}`,
      );
    }
  }
  if (explanation.effect === undefined) {
    lines.push(
      `Effect       unresolved: the policy default is "${explanation.unresolved}"${explanation.unresolved === "semantic" ? " (a provider would assess it; without one it asks)" : ""}${explanation.floor === undefined ? "" : `; an untrusted source holds it at "${explanation.floor}" or stricter`}`,
    );
  } else {
    lines.push(`Effect       ${explanation.effect}`);
  }
  lines.push(
    `By mode      observe: ${explanation.byMode.observe} (records only)  assist: ${explanation.byMode.assist}  autopilot: ${explanation.byMode.autopilot}`,
    "",
  );
  return lines.join("\n");
}
