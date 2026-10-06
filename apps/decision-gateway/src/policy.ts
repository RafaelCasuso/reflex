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
  type ActionPlace,
  type ProjectPolicyComposer,
  type ProjectPolicyComposerOptions,
  type ProjectPolicyReading,
  type TrustRecord,
  type TrustedPolicy,
} from "./orchestration/project-policy.js";
export {
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  MIN_SNAPSHOT_INTERVAL_MS,
  SUBSCRIPTION_RECORD_VERSION,
  classifyLocation,
  createSubscriptionHolder,
  parseSubscriptionRecord,
  serializeSubscription,
  snapshotCachePath,
  subscriptionPath,
  type RefreshOutcome,
  type SubscriptionHolder,
  type SubscriptionRecord,
  type SubscriptionState,
} from "./orchestration/subscription.js";
export { readGitFacts, type GitFacts } from "./orchestration/git-facts.js";
export {
  createPolicyHolder,
  readPolicyFiles,
  type PolicyHolder,
  type PolicyLoadResult,
  type PolicyState,
} from "./orchestration/policy-source.js";
