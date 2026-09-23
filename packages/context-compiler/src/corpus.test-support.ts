import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SecretKind } from "./patterns.js";

/**
 * Secrets are generated here, at test time, from each kind's shape. No
 * secret-shaped literal exists in the repository (`corpus/README.md`).
 */
export interface GoldenCase {
  readonly id: string;
  readonly kind: SecretKind;
  readonly template: string;
}

export type Encoding =
  "plain" | "base64" | "base64x2" | "percent" | "json-string" | "split";

export interface AdversarialCase extends GoldenCase {
  readonly encoding: Encoding;
  readonly expect?: "survives";
  readonly note?: string;
}

interface CorpusFile<Case> {
  readonly version: 1;
  readonly cases: readonly Case[];
}

function read(name: string): unknown {
  const file = JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../corpus/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as CorpusFile<unknown>;
  return file.cases;
}

export const GOLDEN = read("secrets-v1.json") as readonly GoldenCase[];
export const ADVERSARIAL = read(
  "adversarial-v1.json",
) as readonly AdversarialCase[];

/** A small deterministic generator: the corpus must read the same every run. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function pick(random: () => number, alphabet: string, length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += alphabet[Math.floor(random() * alphabet.length)] ?? "a";
  }
  return out;
}

const UPPER_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const BASE64ISH = `${ALNUM}+/`;
const URLSAFE = `${ALNUM}_-`;

/** A value of the kind's shape. The prefixes are assembled, never written. */
export function generateSecret(kind: SecretKind, seed: number): string {
  const random = seeded(seed);
  switch (kind) {
    case "aws-access-key":
      return `${["AK", "IA"].join("")}${pick(random, UPPER_DIGITS, 16)}`;
    case "aws-secret-key":
      return pick(random, BASE64ISH, 40);
    case "github-token":
      return `${["gh", "p_"].join("")}${pick(random, ALNUM, 36)}`;
    case "slack-token":
      return `${["xo", "xb-"].join("")}${pick(random, "0123456789", 12)}-${pick(random, ALNUM, 24)}`;
    case "stripe-key":
      return `${["sk_", "live_"].join("")}${pick(random, ALNUM, 24)}`;
    case "google-api-key":
      return `${["AI", "za"].join("")}${pick(random, URLSAFE, 35)}`;
    case "openai-key":
      return `${["sk-", "proj-"].join("")}${pick(random, URLSAFE, 32)}`;
    case "anthropic-key":
      return `${["sk-", "ant-"].join("")}${pick(random, URLSAFE, 40)}`;
    case "typesafe-key":
      return `${["api", "key_"].join("")}${pick(random, ALNUM, 32)}`;
    case "jwt":
      return `${["ey", "J"].join("")}${pick(random, URLSAFE, 20)}.${["ey", "J"].join("")}${pick(random, URLSAFE, 40)}.${pick(random, URLSAFE, 43)}`;
    case "private-key": {
      const begin = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
      const end = ["-----END ", "PRIVATE KEY-----"].join("");
      const body = Array.from({ length: 4 }, () =>
        pick(random, BASE64ISH, 64),
      ).join("\n");
      return `${begin}\n${body}\n${end}`;
    }
    case "authorization-header":
      return pick(random, BASE64ISH, 32);
    case "url-credentials":
      return pick(random, ALNUM, 20);
    case "assignment":
      return pick(random, ALNUM, 24);
    case "encoded":
      return pick(random, ALNUM, 24);
  }
}

export function encode(secret: string, encoding: Encoding): string {
  switch (encoding) {
    case "plain":
    case "split":
      return secret;
    case "base64":
      return Buffer.from(secret, "utf8").toString("base64");
    case "base64x2":
      return Buffer.from(
        Buffer.from(secret, "utf8").toString("base64"),
        "utf8",
      ).toString("base64");
    case "percent":
      return encodeURIComponent(secret).replaceAll(
        /[A-Za-z0-9]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      );
    case "json-string":
      return JSON.stringify(secret).slice(1, -1);
  }
}

export function render(
  template: string,
  secret: string,
  encoding: Encoding = "plain",
): string {
  if (encoding === "split") {
    const half = Math.floor(secret.length / 2);
    return template.replace(
      "{secret}",
      `${secret.slice(0, half)}\\\n${secret.slice(half)}`,
    );
  }
  return template
    .replace("{secret}", secret)
    .replace("{encoded}", encode(secret, encoding));
}
