/**
 * RFX-031 — what a secret looks like.
 *
 * Shapes, not entropy: a detector that fires on any random-looking string
 * would redact commit hashes and file names and teach nothing. Every kind
 * names a family of credentials with a recognizable prefix or a
 * recognizable frame (a header, an assignment, a key block, a URL with a
 * password in it). What each regex captures is the value to replace; the
 * frame around it stays so that a reader still knows what was there.
 *
 * The list is the golden corpus's contract (`corpus/secrets-v1.json`): every
 * kind here has cases there, generated at test time from the same shapes so
 * that no secret-shaped literal exists in the repository.
 */
export const SECRET_KINDS = [
  "aws-access-key",
  "aws-secret-key",
  "github-token",
  "slack-token",
  "stripe-key",
  "google-api-key",
  "openai-key",
  "anthropic-key",
  "typesafe-key",
  "jwt",
  "private-key",
  "authorization-header",
  "url-credentials",
  "assignment",
  "encoded",
] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export interface SecretPattern {
  readonly kind: SecretKind;
  /** Global and sticky-free: run with `matchAll` on a fresh `lastIndex`. */
  readonly regex: RegExp;
  /** Which capture group is the value. 0 is the whole match. */
  readonly group: number;
}

const flags = "g";

/**
 * In order of specificity: a token with a distinctive prefix is named by its
 * family before a generic assignment can claim it. The value group is what
 * becomes the placeholder.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    kind: "private-key",
    regex: new RegExp(
      "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----",
      flags,
    ),
    group: 0,
  },
  {
    kind: "aws-access-key",
    regex: new RegExp("\\b((?:AKIA|ASIA)[0-9A-Z]{16})\\b", flags),
    group: 1,
  },
  {
    kind: "aws-secret-key",
    regex: new RegExp(
      "(?:aws_?secret_?access_?key|aws_?secret)[\"'\\s]*[:=][\"'\\s]*([A-Za-z0-9/+=]{40})\\b",
      `${flags}i`,
    ),
    group: 1,
  },
  {
    kind: "github-token",
    regex: new RegExp(
      "\\b(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\\b",
      flags,
    ),
    group: 1,
  },
  {
    kind: "slack-token",
    regex: new RegExp("\\b(xox[abprs]-[A-Za-z0-9-]{10,})\\b", flags),
    group: 1,
  },
  {
    kind: "stripe-key",
    regex: new RegExp("\\b([sr]k_(?:live|test)_[A-Za-z0-9]{16,})\\b", flags),
    group: 1,
  },
  {
    kind: "google-api-key",
    regex: new RegExp("\\b(AIza[0-9A-Za-z_-]{35})\\b", flags),
    group: 1,
  },
  {
    kind: "anthropic-key",
    regex: new RegExp("\\b(sk-ant-[A-Za-z0-9_-]{20,})\\b", flags),
    group: 1,
  },
  {
    kind: "openai-key",
    // The house fake `sk-live-<12 hex>` is a member on purpose: it is what
    // adversarial tests plant, and it must be redacted like the real thing.
    regex: new RegExp(
      "\\b(sk-(?:proj-|svcacct-|live-|test-)?[A-Za-z0-9_-]{12,})\\b",
      flags,
    ),
    group: 1,
  },
  {
    kind: "typesafe-key",
    regex: new RegExp("\\b(apikey_[A-Za-z0-9]{16,})\\b", flags),
    group: 1,
  },
  {
    kind: "jwt",
    regex: new RegExp(
      "\\b(eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,})\\b",
      flags,
    ),
    group: 1,
  },
  {
    kind: "authorization-header",
    regex: new RegExp(
      "\\b(?:authorization|proxy-authorization)\\b[\"']?\\s*[:=]\\s*[\"']?\\s*(?:bearer|basic|token|digest)\\s+([^\\s\"'&,;]+)",
      `${flags}i`,
    ),
    group: 1,
  },
  {
    kind: "url-credentials",
    // scheme://user:PASSWORD@host
    regex: new RegExp(
      "\\b[a-z][a-z0-9+.-]*://[^/\\s:@]+:([^@\\s/]+)@",
      `${flags}i`,
    ),
    group: 1,
  },
  {
    kind: "assignment",
    // NAME_WITH_SECRET_WORD = value, in an env line, a URL query, a JSON
    // member or a flag. Only the value goes.
    regex: new RegExp(
      "\\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key)[A-Za-z0-9_.-]*[\"']?\\s*[:=]\\s*[\"']?([^\\s\"'&,;]{8,})",
      `${flags}i`,
    ),
    group: 1,
  },
];

/** What the placeholder must never look like: another secret. */
export const PLACEHOLDER = /^\[REDACTED:[a-z-]+:[0-9a-f]{8}\]$/;
/** The same, anywhere in a text: a pass over redacted text must skip these. */
export const PLACEHOLDER_ANYWHERE = /\[REDACTED:[a-z-]+:[0-9a-f]{8}\]/g;
