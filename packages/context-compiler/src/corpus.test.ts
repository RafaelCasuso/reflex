import { describe, expect, it } from "vitest";

import {
  ADVERSARIAL,
  GOLDEN,
  generateSecret,
  render,
  type AdversarialCase,
  type Encoding,
  type GoldenCase,
} from "./corpus.test-support.js";
import { SECRET_KINDS } from "./patterns.js";
import { createRedactor } from "./redact.js";

const redactor = createRedactor({ key: Buffer.alloc(32, 5) });

const isAdversarial = (
  entry: GoldenCase | AdversarialCase,
): entry is AdversarialCase => "encoding" in entry;

/** RFX-031: the golden corpus confirms secrets never survive redaction. */
describe("RFX-031 golden corpus", () => {
  it("covers every kind the redactor knows, except the one that only decoding produces", () => {
    const covered = new Set(GOLDEN.map((entry) => entry.kind));
    for (const kind of SECRET_KINDS) {
      if (kind === "encoded") {
        continue;
      }
      expect(covered.has(kind), kind).toBe(true);
    }
  });

  it.each(GOLDEN.map((entry) => [entry.id, entry] as const))(
    "%s: the secret does not survive",
    (_id, entry) => {
      for (const seed of [1, 2, 3]) {
        const secret = generateSecret(entry.kind, seed);
        const input = render(entry.template, secret);
        expect(input).toContain(secret);
        const { text, hits } = redactor.redactText(input);
        expect(text, entry.id).not.toContain(secret);
        // The frame's own words stay: the reader knows what was there.
        expect(text).toContain("[REDACTED:");
        expect(hits.length).toBeGreaterThanOrEqual(1);
        expect(
          hits.some((hit) => hit.kind === entry.kind),
          `${entry.id}: named ${hits.map((hit) => hit.kind).join(",")}`,
        ).toBe(true);
      }
    },
  );

  it("gives the same secret the same fingerprint in every frame", () => {
    const secret = generateSecret("github-token", 21);
    const fingerprints = new Set(
      GOLDEN.filter((entry) => entry.kind === "github-token").map(
        (entry) =>
          redactor.redactText(render(entry.template, secret)).hits[0]
            ?.fingerprint,
      ),
    );
    expect(fingerprints.size).toBe(1);
  });
});

/** RFX-035: encoded, quoted and embedded secrets. Zero raw known secrets after the redactor. */
describe("RFX-035 adversarial corpus", () => {
  const expectedToHold = ADVERSARIAL.filter(
    (entry) => entry.expect !== "survives",
  );
  const expectedToSurvive = ADVERSARIAL.filter(
    (entry) => entry.expect === "survives",
  );

  it.each(expectedToHold.map((entry) => [entry.id, entry] as const))(
    "%s: neither the secret nor its encoding survives",
    (_id, entry) => {
      for (const seed of [4, 5]) {
        const secret = generateSecret(entry.kind, seed);
        const input = render(entry.template, secret, entry.encoding);
        const { text } = redactor.redactText(input);
        expect(text, entry.id).not.toContain(secret);
        if (
          entry.encoding === "base64" ||
          entry.encoding === "percent" ||
          entry.encoding === "base64x2"
        ) {
          // The encoded run itself is gone, not only the decoded value.
          const encoded = input.replace(
            entry.template.split("{encoded}")[0] ?? "",
            "",
          );
          expect(text, `${entry.id}: encoded run`).not.toContain(
            encoded.slice(0, 24),
          );
        }
        expect(text).toContain("[REDACTED:");
      }
    },
  );

  it("counts, and does not hide, what no single-string redactor can catch", () => {
    expect(expectedToSurvive.map((entry) => entry.id)).toEqual([
      "split-across-continuation",
    ]);
    for (const entry of expectedToSurvive) {
      const secret = generateSecret(entry.kind, 6);
      const input = render(entry.template, secret, entry.encoding);
      expect(input).not.toContain(secret);
      expect(entry.note).toBeTypeOf("string");
    }
  });

  it("reports zero raw known secrets over the whole corpus", () => {
    let survivors = 0;
    let cases = 0;
    for (const entry of [...GOLDEN, ...ADVERSARIAL]) {
      if (isAdversarial(entry) && entry.expect === "survives") {
        continue;
      }
      const secret = generateSecret(entry.kind, 7);
      const encoding: Encoding = isAdversarial(entry)
        ? entry.encoding
        : "plain";
      const { text } = redactor.redactText(
        render(entry.template, secret, encoding),
      );
      cases += 1;
      if (text.includes(secret)) {
        survivors += 1;
      }
    }
    expect(cases).toBeGreaterThanOrEqual(35);
    expect(survivors).toBe(0);
  });
});
