/**
 * @reflex-control/provider-local — the local inference server behind the provider
 * interface (ADR-016 §1).
 *
 * The server speaks the canonical contract: `POST /v1/assess` with a
 * `SemanticDecisionRequest` in and a `SemanticAssessment` out. RDM and Laya
 * are checkpoints behind it; this package knows neither. Nothing it is
 * given leaves the machine: the endpoint is loopback, by construction.
 */
export {
  LOCAL_DEFAULT_ENDPOINT,
  LOCAL_PROVIDER_NAME,
  createLocalProvider,
  isLoopbackEndpoint,
  type LocalProviderOptions,
  type LocalUsage,
} from "./client.js";
