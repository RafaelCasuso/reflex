/* REFLEX canonical contracts — initial proposal.
 * These contracts intentionally contain no host- or provider-specific types.
 */

export type OpaqueId<Prefix extends string> = `${Prefix}_${string}`;

export type DecisionId = OpaqueId<"dec">;
export type ActionId = OpaqueId<"act">;
export type AgentId = OpaqueId<"agt">;
export type ProjectId = OpaqueId<"prj">;
export type OrganizationId = OpaqueId<"org">;
export type PolicyId = OpaqueId<"pol">;
export type SessionId = OpaqueId<"ses">;

export type DecisionEffect = "allow" | "ask" | "deny";
export type ReflexMode = "observe" | "assist" | "autopilot";
export type FailureMode = "fail-open" | "fail-ask" | "fail-closed";

export type HostKind =
  "claude-code" | "codex" | "mcp" | "sdk-typescript" | "sdk-python" | "http";

export type EnvironmentKind =
  "local" | "development" | "test" | "staging" | "production" | "unknown";

export type SideEffectClass =
  | "none"
  | "local-read"
  | "local-write"
  | "external-read"
  | "external-write"
  | "destructive"
  | "financial"
  | "privilege"
  | "credential"
  | "unknown";

export type ReasonCode =
  | "explicit_allow"
  | "explicit_ask"
  | "explicit_deny"
  | "off_task"
  | "destructive"
  | "irreversible"
  | "external_side_effect"
  | "privilege_escalation"
  | "secret_access"
  | "sensitive_data"
  | "financial_action"
  | "production_mutation"
  | "unusual_scope"
  | "untrusted_input"
  | "policy_violation"
  | "low_confidence"
  | "provider_unavailable"
  | "decision_timeout"
  | "unsupported_action"
  | "unknown_risk";

export interface AgentIdentity {
  id?: AgentId;
  name?: string;
  host: HostKind;
  hostVersion?: string;
  model?: string;
}

export interface ActionTool {
  name: string;
  namespace?: string;
  description?: string;
}

export interface ActionResource {
  type?: string;
  identifier?: string;
  environment: EnvironmentKind;
  isProduction?: boolean;
}

export interface PriorActionSummary {
  actionId?: ActionId;
  toolName: string;
  operation?: string;
  effect?: DecisionEffect;
  occurredAt: string;
}

export interface CanonicalAction {
  id: ActionId;
  organizationId?: OrganizationId;
  projectId?: ProjectId;
  sessionId?: SessionId;

  agent: AgentIdentity;

  userObjective?: string;
  taskSummary?: string;

  tool: ActionTool;
  operation?: string;

  /**
   * Must be redacted before crossing a trust boundary.
   * Never log this object before redaction.
   */
  arguments: Readonly<Record<string, unknown>>;

  resource?: ActionResource;
  sideEffectClass: SideEffectClass;

  cwd?: string;
  repository?: {
    root?: string;
    branch?: string;
    remoteHost?: string;
  };

  priorActions?: readonly PriorActionSummary[];

  adapterMetadata?: Readonly<Record<string, unknown>>;

  createdAt: string;
}

export interface DecisionRequest {
  action: CanonicalAction;
  mode: ReflexMode;
  failureMode: FailureMode;
  policySetHash?: string;
  deadlineMs?: number;
}

export interface SemanticSignal<T> {
  value: T;
  confidence: number; // 0..1
}

export interface SemanticAssessment {
  objectiveAlignment: SemanticSignal<number>; // 0..100, higher = aligned
  destructiveRisk: SemanticSignal<number>; // 0..100
  reversibility: SemanticSignal<number>; // 0..100, higher = easier to reverse
  externalSideEffect: SemanticSignal<boolean>;
  privilegeEscalation: SemanticSignal<number>;
  secretAccess: SemanticSignal<number>;
  sensitiveDataExposure: SemanticSignal<number>;
  financialConsequence: SemanticSignal<number>;
  productionMutation: SemanticSignal<number>;
  unusualScope: SemanticSignal<number>;
  untrustedInput: SemanticSignal<number>;

  provider: string;
  model?: string;
  latencyMs: number;
}

export interface PolicyMatch {
  policyId?: PolicyId;
  ruleId: string;
  ruleName?: string;
  effect: DecisionEffect;
  mandatory: boolean;
  precedence: number;
}

export interface ReflexDecision {
  id: DecisionId;
  actionId: ActionId;

  effect: DecisionEffect;
  effectiveEffect: DecisionEffect;
  mode: ReflexMode;

  risk: number; // integer 0..100
  confidence: number; // 0..1

  reasonCodes: readonly ReasonCode[];
  policyMatches: readonly PolicyMatch[];

  semanticAssessment?: SemanticAssessment;

  policySetHash?: string;

  cached: boolean;
  cacheKey?: string;

  fallback?: {
    used: boolean;
    reason?: "timeout" | "provider-error" | "gateway-error" | "invalid-input";
    configuredMode?: FailureMode;
  };

  latency: {
    totalMs: number;
    policyMs: number;
    contextMs?: number;
    semanticMs?: number;
    aggregationMs?: number;
  };

  decidedAt: string;
}

export interface SemanticDecisionRequest {
  action: Pick<
    CanonicalAction,
    | "userObjective"
    | "taskSummary"
    | "tool"
    | "operation"
    | "arguments"
    | "resource"
    | "sideEffectClass"
    | "repository"
    | "priorActions"
  >;
  policyHints?: readonly string[];
  maxInputTokens: number;
  deadlineMs: number;
}

export interface SemanticDecisionProvider {
  readonly providerName: string;

  evaluate(
    request: SemanticDecisionRequest,
    signal?: AbortSignal,
  ): Promise<SemanticAssessment>;
}

export type PolicyOperator =
  "equals" | "not_equals" | "starts_with" | "matches" | "in" | "exists";

export interface PolicyCondition {
  field: string;
  operator: PolicyOperator;
  value?: unknown;
}

export interface PolicyRule {
  id: string;
  name: string;
  effect: DecisionEffect;
  mandatory?: boolean;
  conditions: readonly PolicyCondition[];
}

export interface PolicyDocument {
  version: 1;
  defaults: {
    unresolved: "semantic" | "ask" | "deny";
  };
  rules: readonly PolicyRule[];
}

export interface PolicyEvaluation {
  resolved: boolean;
  effect?: DecisionEffect;
  matches: readonly PolicyMatch[];
  latencyMs: number;
}

export type DecisionFeedbackValue =
  "correct" | "should-allow" | "should-ask" | "should-deny";

export interface DecisionFeedback {
  decisionId: DecisionId;
  value: DecisionFeedbackValue;
  actorId?: string;
  note?: string;
  createdAt: string;
}

export interface DecisionEngine {
  decide(
    request: DecisionRequest,
    signal?: AbortSignal,
  ): Promise<ReflexDecision>;
}
