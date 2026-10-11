/**
 * `@reflex-control/decision-gateway/cloud` — what the CLI shares with the
 * daemon about a claimed installation (ADR-019): the record `rfx claim`
 * writes and the daemon reads, the consent statement and its digest, and
 * where a control plane may be.
 */
export {
  CLOUD_RECORD_VERSION,
  DEFAULT_UPLOAD_INTERVAL_MS,
  MIN_UPLOAD_INTERVAL_MS,
  UNCLAIMED,
  classifyEndpoint,
  cloudConsentCovers,
  cloudConsentDigest,
  cloudConsentStatement,
  cloudPath,
  createUploader,
  parseCloudRecord,
  postIngest,
  readCloudRecord,
  serializeCloud,
  type ClaimedProject,
  type CloudRecord,
  type CloudState,
  type IngestFetcher,
  type IngestOutcome,
  type TickOutcome,
  type Uploader,
  type UploaderOptions,
} from "./orchestration/cloud.js";
