import { createHmac } from "node:crypto";

import type {
  ActionOperands,
  ActionRepository,
  ActionResource,
  ActionTool,
  CanonicalAction,
  PriorActionSummary,
  SideEffectClass,
} from "@reflex-control/contracts";

import {
  PLACEHOLDER_ANYWHERE,
  SECRET_PATTERNS,
  type SecretKind,
  type SecretPattern,
} from "./patterns.js";

/**
 * RFX-031 — the redactor (ADR-006).
 *
 * Raw values exist in the daemon's memory and nowhere else. Everything that
 * is written or sent goes through here first and comes out as a
 * `RedactedAction`, a different type from `CanonicalAction`, so that a
 * stage which reads the wrong view is a compile error.
 *
 * A redacted value becomes `[REDACTED:<kind>:<fingerprint>]`. The
 * fingerprint is the first 8 hexadecimal digits of an HMAC-SHA-256 of the
 * value under the installation's key (ADR-006 §4): the same secret gives
 * the same placeholder on the same machine, so repetition is visible
 * without content, and without the key nothing can be confirmed by
 * guessing.
 *
 * Encoded text is decoded and scanned too: a base64 or percent-encoded run
 * that decodes to a secret is replaced whole, as kind `encoded` (RFX-035).
 */
export const REDACTION_KEY_BYTES = 32;
export const FINGERPRINT_HEX = 8;

export interface RedactionHit {
  readonly kind: SecretKind;
  readonly fingerprint: string;
}

export interface RedactedText {
  readonly text: string;
  readonly hits: readonly RedactionHit[];
}

/** A redacted view. The brand is what keeps it apart from the raw action. */
export interface RedactedAction {
  readonly __redacted: true;
  readonly tool: ActionTool;
  readonly operation?: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly operands?: ActionOperands;
  readonly resource?: ActionResource;
  readonly sideEffectClass: SideEffectClass;
  readonly repository?: ActionRepository;
  readonly userObjective?: string;
  readonly taskSummary?: string;
  readonly priorActions?: readonly PriorActionSummary[];
  /** Every value replaced, in the order found. Kinds and fingerprints only. */
  readonly hits: readonly RedactionHit[];
}

export interface Redactor {
  redactText(text: string): RedactedText;
  redactValue(value: unknown): {
    readonly value: unknown;
    readonly hits: readonly RedactionHit[];
  };
  redactAction(action: CanonicalAction): RedactedAction;
}

export interface RedactorOptions {
  /** `REDACTION_KEY_BYTES` random bytes, from `~/.reflex`, mode 0600. */
  readonly key: Uint8Array;
  /** Beyond this, a string is scanned for nothing but replaced whole. */
  readonly maxScanLength?: number;
}

const DEFAULT_MAX_SCAN_LENGTH = 256 * 1024;
const BASE64_RUN = /[A-Za-z0-9+/]{24,}={0,2}/g;
/** A URL-ish run with at least four escapes in it; unreserved characters stay. */
const PERCENT_RUN = /[A-Za-z0-9_.~%-]{12,}/g;
const PERCENT_ESCAPES = /%[0-9A-Fa-f]{2}/g;
const MAX_DECODE_DEPTH = 2;

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly kind: SecretKind;
  readonly value: string;
  /** Position of the pattern that found it: lower is more specific. */
  readonly rank: number;
}

function findMatches(
  text: string,
  pattern: SecretPattern,
  rank: number,
): Replacement[] {
  const found: Replacement[] = [];
  pattern.regex.lastIndex = 0;
  for (const match of text.matchAll(pattern.regex)) {
    const whole = match[0];
    const value = match[pattern.group];
    if (value === undefined || value === "") {
      continue;
    }
    const offset = pattern.group === 0 ? 0 : whole.indexOf(value);
    if (offset < 0) {
      continue;
    }
    const start = match.index + offset;
    found.push({
      start,
      end: start + value.length,
      kind: pattern.kind,
      value,
      rank,
    });
  }
  return found;
}

function decodeBase64(run: string): string | undefined {
  try {
    const decoded = Buffer.from(run, "base64").toString("utf8");
    // A real decoding is mostly printable; binary noise is not a secret we
    // can read, and re-scanning it would only cost time.
    return /^[\x20-\x7e\s]*$/.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function decodePercent(run: string): string | undefined {
  if ((run.match(PERCENT_ESCAPES) ?? []).length < 4) {
    return undefined;
  }
  try {
    return decodeURIComponent(run);
  } catch {
    return undefined;
  }
}

/** Where placeholders already are: a second pass must not read them. */
function placeholderSpans(text: string): readonly [number, number][] {
  PLACEHOLDER_ANYWHERE.lastIndex = 0;
  return [...text.matchAll(PLACEHOLDER_ANYWHERE)].map((match) => [
    match.index,
    match.index + match[0].length,
  ]);
}

function insidePlaceholder(
  spans: readonly [number, number][],
  start: number,
  end: number,
): boolean {
  return spans.some(([from, to]) => start < to && end > from);
}

export function createRedactor(options: RedactorOptions): Redactor {
  if (options.key.length < REDACTION_KEY_BYTES) {
    throw new RangeError(
      `a redaction key needs ${String(REDACTION_KEY_BYTES)} bytes`,
    );
  }
  const maxScanLength = options.maxScanLength ?? DEFAULT_MAX_SCAN_LENGTH;

  const fingerprint = (value: string): string =>
    createHmac("sha256", options.key)
      .update(value, "utf8")
      .digest("hex")
      .slice(0, FINGERPRINT_HEX);

  const placeholder = (kind: SecretKind, value: string): string =>
    `[REDACTED:${kind}:${fingerprint(value)}]`;

  /** Does any pattern, or any decoding of a run, hit inside `text`? */
  function containsSecret(text: string, depth: number): boolean {
    for (const [rank, pattern] of SECRET_PATTERNS.entries()) {
      if (findMatches(text, pattern, rank).length > 0) {
        return true;
      }
    }
    if (depth >= MAX_DECODE_DEPTH) {
      return false;
    }
    for (const [regex, decode] of [
      [BASE64_RUN, decodeBase64],
      [PERCENT_RUN, decodePercent],
    ] as const) {
      regex.lastIndex = 0;
      for (const match of text.matchAll(regex)) {
        const decoded = decode(match[0]);
        if (
          decoded !== undefined &&
          decoded !== match[0] &&
          containsSecret(decoded, depth + 1)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function redactText(text: string): RedactedText {
    if (text.length > maxScanLength) {
      // Too big to scan on the hot path, and a value that size is content,
      // not an argument a decision needs to read.
      return {
        text: placeholder("encoded", text),
        hits: [{ kind: "encoded", fingerprint: fingerprint(text) }],
      };
    }
    const spans = placeholderSpans(text);
    const replacements: Replacement[] = [];
    for (const [rank, pattern] of SECRET_PATTERNS.entries()) {
      replacements.push(
        ...findMatches(text, pattern, rank).filter(
          (found) => !insidePlaceholder(spans, found.start, found.end),
        ),
      );
    }
    for (const [regex, decode] of [
      [BASE64_RUN, decodeBase64],
      [PERCENT_RUN, decodePercent],
    ] as const) {
      regex.lastIndex = 0;
      for (const match of text.matchAll(regex)) {
        const decoded = decode(match[0]);
        if (
          decoded !== undefined &&
          decoded !== match[0] &&
          !insidePlaceholder(
            spans,
            match.index,
            match.index + match[0].length,
          ) &&
          containsSecret(decoded, 1)
        ) {
          replacements.push({
            start: match.index,
            end: match.index + match[0].length,
            kind: "encoded",
            value: match[0],
            rank: SECRET_PATTERNS.length,
          });
        }
      }
    }
    if (replacements.length === 0) {
      return { text, hits: [] };
    }
    // Earliest first, and at the same place the most specific pattern; an
    // overlap keeps the first and drops the rest, so that a value is
    // replaced once and whole.
    replacements.sort(
      (a, b) => a.start - b.start || a.rank - b.rank || b.end - a.end,
    );
    const hits: RedactionHit[] = [];
    let out = "";
    let cursor = 0;
    for (const replacement of replacements) {
      if (replacement.start < cursor) {
        continue;
      }
      out += text.slice(cursor, replacement.start);
      out += placeholder(replacement.kind, replacement.value);
      hits.push({
        kind: replacement.kind,
        fingerprint: fingerprint(replacement.value),
      });
      cursor = replacement.end;
    }
    out += text.slice(cursor);
    return { text: out, hits };
  }

  function redactValue(value: unknown): {
    value: unknown;
    hits: readonly RedactionHit[];
  } {
    const hits: RedactionHit[] = [];
    const walk = (node: unknown, depth: number): unknown => {
      if (typeof node === "string") {
        const redacted = redactText(node);
        hits.push(...redacted.hits);
        return redacted.text;
      }
      if (depth > 64) {
        // Deeper than the contract allows (ADR-009 limits): not walked, and
        // not passed through either. The whole subtree becomes one value.
        const text = JSON.stringify(node);
        hits.push(...redactText(text).hits);
        return placeholder("encoded", text);
      }
      if (Array.isArray(node)) {
        return node.map((item) => walk(item, depth + 1));
      }
      if (typeof node === "object" && node !== null) {
        const out: Record<string, unknown> = {};
        for (const [key, member] of Object.entries(node)) {
          out[key] = walk(member, depth + 1);
        }
        return out;
      }
      return node;
    };
    return { value: walk(value, 0), hits };
  }

  function redactOptionalText(
    text: string | undefined,
    hits: RedactionHit[],
  ): string | undefined {
    if (text === undefined) {
      return undefined;
    }
    const redacted = redactText(text);
    hits.push(...redacted.hits);
    return redacted.text;
  }

  function redactAction(action: CanonicalAction): RedactedAction {
    const hits: RedactionHit[] = [];
    const args = redactValue(action.arguments);
    hits.push(...args.hits);
    const operands =
      action.operands === undefined
        ? undefined
        : (redactValue(action.operands).value as ActionOperands);
    if (action.operands !== undefined) {
      hits.push(...redactValue(action.operands).hits);
    }
    const description = redactOptionalText(action.tool.description, hits);
    const operation = redactOptionalText(action.operation, hits);
    const objective = redactOptionalText(action.userObjective, hits);
    const summary = redactOptionalText(action.taskSummary, hits);
    const identifier = redactOptionalText(action.resource?.identifier, hits);
    const priorActions = action.priorActions?.map((prior) => ({
      ...prior,
      ...(prior.operation === undefined
        ? {}
        : { operation: redactOptionalText(prior.operation, hits) ?? "" }),
    }));

    return {
      __redacted: true,
      tool: {
        name: action.tool.name,
        ...(action.tool.namespace === undefined
          ? {}
          : { namespace: action.tool.namespace }),
        ...(description === undefined ? {} : { description }),
      },
      ...(operation === undefined ? {} : { operation }),
      arguments: args.value as Readonly<Record<string, unknown>>,
      ...(operands === undefined ? {} : { operands }),
      ...(action.resource === undefined
        ? {}
        : {
            resource: {
              ...action.resource,
              ...(identifier === undefined ? {} : { identifier }),
            },
          }),
      sideEffectClass: action.sideEffectClass,
      ...(action.repository === undefined
        ? {}
        : { repository: action.repository }),
      ...(objective === undefined ? {} : { userObjective: objective }),
      ...(summary === undefined ? {} : { taskSummary: summary }),
      ...(priorActions === undefined ? {} : { priorActions }),
      hits,
    };
  }

  return { redactText, redactValue, redactAction };
}
