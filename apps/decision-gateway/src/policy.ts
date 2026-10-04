/**
 * `@reflex-control/decision-gateway/policy` — what the CLI shares with the daemon
 * about policies: how a project's policy is found and trusted (RFX-104),
 * how the user's files are read, and how a set is composed, so that
 * `rfx explain` and `rfx doctor` see exactly what the daemon decides with.
 */
export {
  PROJECT_POLICY_RELATIVE,
  TRUST_RECORD_VERSION,
  createProjectPolicyComposer,
  findProjectPolicy,
  isTrusted,
  parseTrustRecord,
  policyHashOf,
  trustFilePath,
  withTrust,
  withoutTrust,
  type ProjectPolicyComposer,
  type ProjectPolicyComposerOptions,
  type ProjectPolicyReading,
  type TrustRecord,
  type TrustedPolicy,
} from "./orchestration/project-policy.js";
export {
  createPolicyHolder,
  readPolicyFiles,
  type PolicyHolder,
  type PolicyLoadResult,
  type PolicyState,
} from "./orchestration/policy-source.js";
