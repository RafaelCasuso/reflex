import type {
  DecisionFallback,
  DecisionLatency,
  ReasonCode,
} from "./decision.js";
import type { DecisionFeedback } from "./feedback.js";
import type {
  ActionId,
  AgentId,
  DecisionId,
  KeyId,
  OrganizationId,
  ProjectId,
  SessionId,
} from "./ids.js";
import type { ActionOutcome } from "./outcome.js";
import type {
  Confidence,
  DecisionEffect,
  EnvironmentKind,
  HostKind,
  IsoTimestamp,
  ReflexMode,
  RiskScore,
  SideEffectClass,
} from "./primitives.js";
import type { DecisionRecord } from "./record.js";

/**
 * The control plane's wire contracts (ADR-019, v1.6): what a claimed
 * installation uploads, and how it is claimed.
 *
 * A summary is a decision **by name**: the ids, the host and tool names,
 * the operation, the class, the environment, the branch and remote host,
 * and what REFLEX decided. It has no field for an argument, a path or a
 * working directory, and its parser is strict, so a summary that carries
 * one does not parse. The redacted request travels only inside the
 * `DecisionRecord` of ADR-016 §4, where the never-stored list of ADR-008
 * §3 already applies.
 */
export const CLOUD_KEY_SCOPES = ["ingest", "read", "admin"] as const;
export type CloudKeyScope = (typeof CLOUD_KEY_SCOPES)[number];

/** Why the control plane did not keep an entry. Dropped, never retried. */
export const INGEST_REJECTION_REASONS = [
  /** The entry did not parse, or contradicted itself. */
  "invalid",
  /** The project is not claimed by this organization. */
  "unknown-project",
  /** The key's agent is not the entry's agent. */
  "not-claimed",
  /** The second redaction pass found what the first should have. */
  "content-refused",
] as const;
export type IngestRejectionReason = (typeof INGEST_REJECTION_REASONS)[number];

/** What an action was, without its content. */
export interface ActionSummary {
  host: HostKind;
  hostVersion?: string;
  toolName: string;
  toolNamespace?: string;
  operation?: string;
  sideEffectClass: SideEffectClass;
  environment: EnvironmentKind;
  branch?: string;
  remoteHost?: string;
}

export interface DecisionSummary {
  decisionId: DecisionId;
  actionId: ActionId;
  agentId: AgentId;
  projectId: ProjectId;
  sessionId?: SessionId;
  decidedAt: IsoTimestamp;
  action: ActionSummary;
  effect: DecisionEffect;
  effectiveEffect: DecisionEffect;
  mode: ReflexMode;
  risk: RiskScore;
  confidence: Confidence;
  reasonCodes: readonly ReasonCode[];
  matchedRuleIds: readonly string[];
  policySetHash?: string;
  cached: boolean;
  fallback?: DecisionFallback;
  /** The primary provider and model, when one answered. */
  provider?: string;
  model?: string;
  latency: DecisionLatency;
}

export interface DecisionIngestEntry {
  kind: "decision";
  summary: DecisionSummary;
  record?: DecisionRecord;
}

export interface OutcomeIngestEntry {
  kind: "outcome";
  projectId: ProjectId;
  outcome: ActionOutcome;
}

export interface FeedbackIngestEntry {
  kind: "feedback";
  projectId: ProjectId;
  feedback: DecisionFeedback;
}

export type IngestEntry =
  DecisionIngestEntry | OutcomeIngestEntry | FeedbackIngestEntry;

/** `POST /v1/ingest`, with an `ingest` key. Strict: an input to storage. */
export interface IngestRequest {
  agentId: AgentId;
  sentAt: IsoTimestamp;
  entries: readonly IngestEntry[];
}

export interface IngestRejection {
  /** Index into `entries`. */
  index: number;
  reason: IngestRejectionReason;
}

/** The answer. Tolerant: read by daemons older than the control plane. */
export interface IngestResult {
  accepted: number;
  /** Entries the control plane already had, by id. Not an error. */
  duplicates: number;
  rejected: readonly IngestRejection[];
}

/** `POST /v1/claims`, with a claim code. Strict. */
export interface ClaimRequest {
  code: string;
  agent: {
    id: AgentId;
    createdAt: IsoTimestamp;
  };
  project: {
    id: ProjectId;
    name: string;
  };
  hosts: readonly HostKind[];
  requestedAt: IsoTimestamp;
}

/** The answer. Tolerant. The project id is the one that was sent. */
export interface ClaimResult {
  organization: {
    id: OrganizationId;
    name: string;
  };
  project: {
    id: ProjectId;
  };
  key: {
    id: KeyId;
    /** `rfk_<key id>_<secret>`, shown once; the control plane keeps a hash. */
    secret: string;
    scope: CloudKeyScope;
  };
  claimedAt: IsoTimestamp;
}

/** The form of a presented key, so that a client can refuse to send junk. */
export const CLOUD_KEY_FORM = /^rfk_key_[0-9a-f]{16}_[A-Za-z0-9_-]{32,64}$/;

/** The form of a claim code as typed; case and the dashes are forgiven. */
export const CLAIM_CODE_FORM = /^RFX(?:-?[A-Z0-9]{4}){3}$/i;
