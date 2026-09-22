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

/**
 * What an action operates on, in a shape that is the same for every host
 * (ADR-011, contract v1.2).
 *
 * `arguments` is host-shaped: one host calls a shell command `command`,
 * another delivers an argument vector under another key. A policy written
 * against `arguments` means something different on every host, which is the
 * failure ADR-001 exists to prevent. Operands are what a policy is written
 * against instead.
 *
 * The adapter fills what the host tells it, without interpreting it: it copies
 * the command string, it does not parse it. An operand the adapter cannot fill
 * is absent, and absent is unknown, never safe (ADR-001 §4).
 */
export interface CommandOperand {
  /** The command as one string, exactly as the shell will receive it. */
  raw?: string;
  /** The command as an argument vector, for hosts that run it without a shell. */
  argv?: readonly string[];
}

export interface ActionOperands {
  /** At least one of `raw` and `argv`. */
  command?: CommandOperand;
  /** File-system paths the host says the action touches. */
  paths?: readonly string[];
  /** Hosts the host says the action contacts. */
  networkHosts?: readonly string[];
}

export interface CanonicalAction {
  /**
   * The idempotency key of a decision (RFX-120, a clarification under
   * ADR-009 that changes no wire shape). A gateway decides an id once: the
   * same id sent again with the same content, adapter metadata and deadline
   * aside, returns the decision already made and is not counted again; the
   * same id with different content is rejected, not re-decided. An adapter
   * that retries must therefore keep the id, and must give a new call a new
   * id.
   */
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
  /** Host-agnostic operands, for policy to be written against (v1.2). */
  operands?: ActionOperands;

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
