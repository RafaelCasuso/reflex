import type { CanonicalAction } from "@reflex-control/contracts";
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

/** What the mutation check found untested (RFX-111). Boundaries, mostly. */
describe("RFX-111 boundaries of the redactor", () => {
  const key = Buffer.alloc(32, 7);

  it("leaves a long hexadecimal or alphanumeric run alone when it decodes to nothing secret", () => {
    const sha = "3f9a1c20e4b8d7f6a5c4b3a2918273645f6e7d8c";
    const { text, hits } = redactor.redactText(
      `git checkout ${sha} && echo ${"Q".repeat(40)}`,
    );
    expect(text).toContain(sha);
    expect(hits).toEqual([]);
  });

  it("redacts a doubly encoded secret and counts a triply encoded one as beyond its reach", () => {
    const once = Buffer.from(github, "utf8").toString("base64");
    const twice = Buffer.from(once, "utf8").toString("base64");
    const thrice = Buffer.from(twice, "utf8").toString("base64");
    expect(redactor.redactText(twice).text).not.toContain(twice);
    // Two levels deep, on purpose: each level costs a decode of every run.
    expect(redactor.redactText(thrice).text).toBe(thrice);
  });

  it("needs at least four percent escapes before it decodes a run, and four is enough", () => {
    const three = `k=%73%6B%5Fabc_${"x".repeat(20)}`;
    expect(redactor.redactText(three).text).toBe(three);
    // The token with exactly four of its characters escaped decodes to the
    // token, and the run goes.
    const four = github.replace(
      /^(.)(.)(.)(.)/,
      (_all, a: string, b: string, c: string, d: string) =>
        [a, b, c, d]
          .map((char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
          .join(""),
    );
    expect(four.match(/%[0-9A-F]{2}/g)).toHaveLength(4);
    // Not behind `token=`: the assignment pattern would take the value
    // whole and say nothing about the decoding.
    expect(redactor.redactText(`see ${four} here`).text).not.toContain(four);
    expect(redactor.redactText(`see ${four} here`).text).toContain(
      "[REDACTED:encoded:",
    );
  });

  it("counts a match that touches a placeholder as outside it, on either side", () => {
    const placeholder = redactor.redactText(aws).text;
    const after = redactor.redactText(`${placeholder}${github}`).text;
    expect(after.match(/\[REDACTED:/g)).toHaveLength(2);
    expect(after).not.toContain(github);
    const before = redactor.redactText(`${github}${placeholder}`).text;
    expect(before.match(/\[REDACTED:/g)).toHaveLength(2);
    expect(before).not.toContain(github);
  });

  it("scans a value exactly at the limit and replaces one past it", () => {
    const at = createRedactor({ key, maxScanLength: 40 });
    const exact = `GITHUB_TOKEN=${github}`.slice(0, 40).padEnd(40, "x");
    expect(at.redactText(exact).text.length).toBeLessThanOrEqual(
      exact.length + 40,
    );
    expect(at.redactText(exact).text).not.toMatch(/^\[REDACTED:encoded/);
    expect(at.redactText(`${exact}y`).text).toMatch(/^\[REDACTED:encoded/);
  });

  it("walks a value nested exactly as deep as the contract allows, and keeps its shape", () => {
    // The root is depth 0; the object that holds the token sits at depth 64,
    // the last one walked. One deeper is replaced whole (below).
    let deep: unknown = { token: github };
    for (let level = 0; level < 64; level += 1) {
      deep = { next: deep };
    }
    const { value, hits } = redactor.redactValue(deep);
    let cursor = value as { next?: unknown; token?: string };
    for (let level = 0; level < 64; level += 1) {
      cursor = cursor.next as { next?: unknown; token?: string };
    }
    expect(cursor.token).toMatch(/^\[REDACTED:github-token:/);
    expect(hits).toEqual([
      { kind: "github-token", fingerprint: expect.any(String) as string },
    ]);
  });

  it("replaces a subtree nested deeper than the contract allows, whole", () => {
    for (const levels of [65, 70]) {
      let deep: unknown = { token: github };
      for (let level = 0; level < levels; level += 1) {
        deep = { next: deep };
      }
      const { value, hits } = redactor.redactValue(deep);
      const text = JSON.stringify(value);
      expect(text).not.toContain(github);
      expect(text).toContain("[REDACTED:encoded:");
      expect(text).not.toContain('"token"');
      expect(hits.some((hit) => hit.kind === "github-token")).toBe(true);
    }
  });

  it("carries the operation, the identifier and the summary into the view when present", () => {
    const password = generateSecret("url-credentials", 5);
    const redacted = redactor.redactAction({
      id: "act_00000000000000000000000000000001",
      agent: { host: "claude-code" },
      tool: { name: "Bash" },
      operation: "run",
      arguments: {},
      resource: {
        environment: "local",
        identifier: `postgres://app:${password}@db/app`,
      },
      sideEffectClass: "unknown",
      taskSummary: "a summary",
      createdAt: "2026-09-23T10:00:00.000Z",
    });
    expect(redacted.operation).toBe("run");
    expect(redacted.resource?.identifier).toContain(
      "[REDACTED:url-credentials:",
    );
    expect(redacted.resource?.identifier).not.toContain(password);
    expect(redacted.taskSummary).toBe("a summary");
  });
});

describe("RFX-111 the objective on the view", () => {
  it("keeps the objective, redacted, and leaves it off when the action has none", () => {
    const base = {
      id: "act_00000000000000000000000000000001",
      agent: { host: "claude-code" },
      tool: { name: "Bash" },
      arguments: { command: "ls" },
      sideEffectClass: "local-read",
      createdAt: "2026-09-23T12:00:00.000Z",
    } as const satisfies CanonicalAction;
    const withObjective = redactor.redactAction({
      ...base,
      userObjective: `Rotate the token ${github} before the release`,
    });
    expect(withObjective.userObjective).toMatch(
      /^Rotate the token \[REDACTED:github-token:[0-9a-f]{8}\] before the release$/,
    );
    expect(withObjective.hits.map((hit) => hit.kind)).toEqual(["github-token"]);
    const without = redactor.redactAction(base);
    expect("userObjective" in without).toBe(false);
  });
});
