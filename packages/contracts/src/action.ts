import type {
  ActionId,
  AgentId,
  OrganizationId,
  ProjectId,
  SessionId,
} from "./ids.js";
import type {
  DecisionEffect,
  EnvironmentKind,
  HostKind,
  IsoTimestamp,
  SideEffectClass,
} from "./primitives.js";

/**
 * The canonical action model. ADR-001 defines what belongs here, what does
 * not, and what `adapterMetadata` may never be used for. Read it before
 * changing this file.
 */
export interface AgentIdentity {
  id?: AgentId;
  name?: string;
  host: HostKind;
  hostVersion?: string;
  model?: string;
}

export interface ActionTool {
  name: string;
  /** For example an MCP server name. */
  namespace?: string;
  description?: string;
}

export interface ActionResource {
  type?: string;
  identifier?: string;
  environment: EnvironmentKind;
  /** Read through `resolveEnvironment()`, never directly. */
  isProduction?: boolean;
}

export interface ActionRepository {
  root?: string;
  branch?: string;
  remoteHost?: string;
}

/** A bounded summary. Prior arguments are never carried forward. */
export interface PriorActionSummary {
  actionId?: ActionId;
  toolName: string;
  operation?: string;
  effect?: DecisionEffect;
  occurredAt: IsoTimestamp;
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
   * Untrusted. Must be redacted before crossing a trust boundary.
   * Never log this object before redaction.
   */
  arguments: Readonly<Record<string, unknown>>;

  resource?: ActionResource;
  sideEffectClass: SideEffectClass;

  cwd?: string;
  repository?: ActionRepository;

  priorActions?: readonly PriorActionSummary[];

  /**
   * Opaque to domain logic (ADR-001 §3). Information, never influence.
   * Untrusted, like `arguments`.
   */
  adapterMetadata?: Readonly<Record<string, unknown>>;

  createdAt: IsoTimestamp;
}

/**
 * The environment an action must be judged under (ADR-001 §4).
 *
 * `resource.environment` and `resource.isProduction` are two sources for one
 * fact. Validation does not repair a contradiction between them; this reader
 * resolves it toward the more dangerous interpretation. Domain code reads the
 * environment through this function and nowhere else.
 *
 * - no resource: `unknown`, and unknown is never safe
 * - either field says production: `production`
 */
export function resolveEnvironment(
  action: Pick<CanonicalAction, "resource">,
): EnvironmentKind {
  const { resource } = action;
  if (resource === undefined) {
    return "unknown";
  }
  if (resource.isProduction === true || resource.environment === "production") {
    return "production";
  }
  return resource.environment;
}
