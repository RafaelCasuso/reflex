import type { CanonicalAction } from "@reflex/contracts";
import { describe, expect, it } from "vitest";

import { generateSecret } from "./corpus.test-support.js";
import { PLACEHOLDER, SECRET_KINDS } from "./patterns.js";
import { createRedactor } from "./redact.js";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const redactor = createRedactor({ key: KEY });

const github = generateSecret("github-token", 1);
const aws = generateSecret("aws-access-key", 2);

describe("RFX-031 the redactor", () => {
  it("replaces a value with a placeholder that names the kind and fingerprints the value", () => {
    const { text, hits } = redactor.redactText(`GITHUB_TOKEN=${github}`);
    expect(text).toMatch(
      /^GITHUB_TOKEN=\[REDACTED:github-token:[0-9a-f]{8}\]$/,
    );
    expect(hits).toEqual([
      {
        kind: "github-token",
        fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/) as string,
      },
    ]);
    expect(text).not.toContain(github);
  });

  it("gives the same secret the same placeholder under the same key, and another under another key", () => {
    const once = redactor.redactText(github).text;
    const again = redactor.redactText(`token: ${github}`).text;
    expect(again).toContain(once);
    const elsewhere = createRedactor({ key: OTHER_KEY }).redactText(
      github,
    ).text;
    expect(elsewhere).not.toBe(once);
    expect(
      redactor.redactText(generateSecret("github-token", 3)).text,
    ).not.toBe(once);
  });

  it("keeps the frame and replaces only the value", () => {
    const { text } = redactor.redactText(
      `curl -H 'Authorization: Bearer ${github}' https://api.github.com/user`,
    );
    expect(text).toContain("curl -H 'Authorization: Bearer [REDACTED:");
    expect(text).toContain("https://api.github.com/user");
  });

  it("replaces every value once and whole when several overlap or repeat", () => {
    const { text, hits } = redactor.redactText(
      `AWS_ACCESS_KEY_ID=${aws} GITHUB_TOKEN=${github} again ${aws}`,
    );
    expect(text).not.toContain(aws);
    expect(text).not.toContain(github);
    expect(hits).toHaveLength(3);
    expect(text.match(/\[REDACTED:/g)).toHaveLength(3);
    expect(hits[0]?.fingerprint).toBe(hits[2]?.fingerprint);
  });

  it("passes text with nothing to redact through untouched", () => {
    const plain = "git status --short && pnpm test --filter web";
    expect(redactor.redactText(plain)).toEqual({ text: plain, hits: [] });
  });

  it("walks values deeply and leaves keys, numbers and booleans alone", () => {
    const { value, hits } = redactor.redactValue({
      command: `deploy --token ${github}`,
      nested: { list: [aws, 3, true, null], password: "not-long" },
    });
    expect(JSON.stringify(value)).not.toContain(github);
    expect(JSON.stringify(value)).not.toContain(aws);
    expect(value).toMatchObject({
      nested: {
        list: [expect.any(String) as string, 3, true, null],
        password: "not-long",
      },
    });
    expect(hits).toHaveLength(2);
  });

  it("replaces a value too big to scan whole, rather than sending it", () => {
    const huge = "x".repeat(300_000);
    const { text, hits } = createRedactor({
      key: KEY,
      maxScanLength: 1_000,
    }).redactText(huge);
    expect(text).toMatch(PLACEHOLDER);
    expect(hits).toEqual([
      { kind: "encoded", fingerprint: expect.any(String) as string },
    ]);
  });

  it("produces a placeholder that no pattern reads as a secret", () => {
    for (const kind of SECRET_KINDS) {
      const secret = generateSecret(kind, 11);
      const once = redactor.redactText(secret).text;
      const twice = redactor.redactText(once).text;
      expect(twice, kind).toBe(once);
    }
  });

  it("redacts an action into a branded view, every text field included, and never the raw one", () => {
    const action: CanonicalAction = {
      id: "act_00000000000000000000000000000001",
      agent: { host: "claude-code" },
      tool: { name: "Bash", description: `uses ${github}` },
      operation: `run with ${aws}`,
      arguments: {
        command: `GITHUB_TOKEN=${github} gh api user`,
        nested: { key: aws },
      },
      operands: {
        command: { raw: `GITHUB_TOKEN=${github} gh api user` },
        paths: ["/work/project/x"],
      },
      resource: {
        environment: "local",
        identifier: `db://app:${generateSecret("url-credentials", 4)}@host`,
      },
      sideEffectClass: "unknown",
      userObjective: `use ${github} to fetch`,
      taskSummary: `set ${aws}`,
      priorActions: [
        {
          toolName: "Bash",
          operation: `echo ${github}`,
          occurredAt: "2026-09-23T10:00:00.000Z",
        },
      ],
      cwd: "/work/project",
      createdAt: "2026-09-23T10:00:00.000Z",
    };
    const redacted = redactor.redactAction(action);
    const text = JSON.stringify(redacted);
    expect(redacted.__redacted).toBe(true);
    expect(text).not.toContain(github);
    expect(text).not.toContain(aws);
    expect("cwd" in redacted).toBe(false);
    expect("id" in redacted).toBe(false);
    expect("agent" in redacted).toBe(false);
    expect(redacted.hits.length).toBeGreaterThanOrEqual(8);
    expect(redacted.sideEffectClass).toBe("unknown");
    expect(redacted.operands?.paths).toEqual(["/work/project/x"]);
  });

  it("refuses a key that is too short", () => {
    expect(() => createRedactor({ key: Buffer.alloc(16, 1) })).toThrow(
      RangeError,
    );
  });
});
