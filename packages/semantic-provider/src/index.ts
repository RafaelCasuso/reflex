/**
 * @reflex-control/semantic-provider — the provider interface (ADR-005).
 *
 * Behavior lives here; the shapes an assessment is made of stay in
 * `@reflex-control/contracts`, because an assessment is part of a decision and
 * crosses the wire. Jev, a local inference server and the hosted gateway
 * are providers behind this interface; core depends on nothing else.
 */
export {
  PROVIDER_ERROR_KINDS,
  fallbackReasonOf,
  isRetryable,
  providerError,
  type ProviderError,
  type ProviderErrorKind,
  type ProviderResult,
  type SemanticDecisionProvider,
} from "./provider.js";
export {
  FAKE_MODEL,
  FAKE_PROVIDER_NAME,
  assessmentForClass,
  createFakeProvider,
  type FakeBehavior,
  type FakeProvider,
  type FakeProviderOptions,
} from "./fake.js";
export {
  PROVIDER_IDS,
  createProviderRegistry,
  fakeProviderConstructor,
  isProviderId,
  type ConfigurableProviderId,
  type ProviderConfig,
  type ProviderConstruction,
  type ProviderConstructor,
  type ProviderId,
  type ProviderRegistry,
} from "./registry.js";
export {
  CONSENT_RECORD_VERSION,
  REMOTE_PROVIDERS,
  consentCovers,
  consentDigest,
  consentRecord,
  consentStatement,
  isRemoteProvider,
  parseConsentRecord,
  type ConsentRecord,
} from "./consent.js";
