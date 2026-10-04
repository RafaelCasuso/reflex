import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CanonicalAction } from "@reflex-control/contracts";
import { evaluatePolicy, parsePolicy } from "@reflex-control/policy-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createProjectPolicyComposer,
  findProjectPolicy,
  isTrusted,
  parseTrustRecord,
  policyHashOf,
  withTrust,
  withoutTrust,
} from "./project-policy.js";

/**
 * RFX-104 — a repository's policy is untrusted until the user trusts it:
 * it can tighten and cannot loosen; trust is bound to the content and lost
 * when the content changes; the composer finds it from the working
 * directory and never above the home.
 */
const USER_POLICY = `
version: 1
defaults:
  unresolved: ask
rules:
  - id: user.allow-ls
    name: ls is fine
    effect: allow
    conditions:
      - { field: command.name, operator: equals, value: ls }
`;

const PROJECT_POLICY = `
version: 1
rules:
  - id: repo.allow-touch
    name: The repository allows touch
    effect: allow
    conditions:
      - { field: command.name, operator: equals, value: touch }
  - id: repo.deny-ls
    name: The repository denies ls
    effect: deny
    conditions:
      - { field: command.name, operator: equals, value: ls }
`;

let root: string;
let home: string;
let project: string;
let trustFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-project-policy-"));
  home = join(root, "home");
  project = join(home, "work", "repo");
  trustFile = join(root, "reflex-home", "trust.json");
  await mkdir(join(project, ".reflex"), { recursive: true });
  await mkdir(join(root, "reflex-home"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function userSources() {
  const parsed = parsePolicy(USER_POLICY);
  if (!parsed.ok) {
    throw new Error("user policy");
  }
  return [
    { source: "local" as const, trusted: true, document: parsed.document },
  ];
}

function shell(command: string, cwd: string): CanonicalAction {
  return {
    id: "act_00000000000000000000000000000001",
    agent: { host: "claude-code" },
    tool: { name: "Bash" },
    arguments: { command },
    operands: { command: { raw: command } },
    sideEffectClass: "unknown",
    cwd,
    createdAt: "2026-10-04T10:00:00.000Z",
  };
}

async function trust(path: string, text: string): Promise<void> {
  await writeFile(
    trustFile,
    JSON.stringify(
      withTrust(
        parseTrustRecord(undefined),
        path,
        policyHashOf(text),
        new Date(),
      ),
    ),
  );
}

const effectOf = (
  composer: ReturnType<typeof createProjectPolicyComposer>,
  action: CanonicalAction,
) =>
  evaluatePolicy(composer.setFor(action), action, { home }).evaluation.effect;

describe("finding the project policy", () => {
  it("walks up from the working directory and stops before the home and at the root", () => {
    const exists = (path: string) =>
      path === join(project, ".reflex", "policy.yaml");
    expect(findProjectPolicy(join(project, "src", "deep"), home, exists)).toBe(
      join(project, ".reflex", "policy.yaml"),
    );
    const inHome = (path: string) =>
      path === join(home, ".reflex", "policy.yaml");
    expect(
      findProjectPolicy(join(home, "work", "other"), home, inHome),
    ).toBeUndefined();
    expect(findProjectPolicy("/", undefined, () => false)).toBeUndefined();
    expect(
      findProjectPolicy(join(root, "elsewhere"), home, () => false),
    ).toBeUndefined();
  });
});

describe("trust records", () => {
  it("binds trust to the path and the content, and reads a damaged file as trusting nothing", () => {
    const path = "/work/repo/.reflex/policy.yaml";
    const hash = policyHashOf("version: 1\nrules: []\n");
    const record = withTrust(
      parseTrustRecord(undefined),
      path,
      hash,
      new Date("2026-10-04T10:00:00Z"),
    );
    expect(isTrusted(record, path, hash)).toBe(true);
    expect(
      isTrusted(record, path, policyHashOf("version: 1\nrules: [ ]\n")),
    ).toBe(false);
    expect(isTrusted(record, "/other/.reflex/policy.yaml", hash)).toBe(false);
    expect(isTrusted(withoutTrust(record, path), path, hash)).toBe(false);
    expect(parseTrustRecord(JSON.stringify(record))).toEqual(record);
    for (const text of [
      "",
      "nope",
      "[]",
      JSON.stringify({
        version: 1,
        trusted: [{ path, policyHash: "md5:x", trustedAt: "t" }],
      }),
    ]) {
      expect(parseTrustRecord(text).trusted).toEqual([]);
    }
  });
});

describe("composing the set for an action", () => {
  // Adversarial: the hostile clone. Its allow is ignored; its deny applies.
  it("lets an untrusted project policy tighten and never loosen", async () => {
    await writeFile(join(project, ".reflex", "policy.yaml"), PROJECT_POLICY);
    const composer = createProjectPolicyComposer({
      home,
      trustFile,
      userSources,
    });
    expect(effectOf(composer, shell("touch a", project))).toBeUndefined();
    expect(effectOf(composer, shell("ls", project))).toBe("deny");
    expect(composer.inspect(project)).toMatchObject({
      trusted: false,
      problems: [],
      allowRules: [expect.objectContaining({ id: "repo.allow-touch" })],
    });
  });

  it("applies the allow once the user trusted this very content, and not after it changes", async () => {
    const path = join(project, ".reflex", "policy.yaml");
    await writeFile(path, PROJECT_POLICY);
    await trust(path, PROJECT_POLICY);
    const composer = createProjectPolicyComposer({
      home,
      trustFile,
      userSources,
      lookupTtlMs: 0,
    });
    expect(effectOf(composer, shell("touch a", join(project, "src")))).toBe(
      "allow",
    );
    expect(composer.inspect(project)?.trusted).toBe(true);

    // The repository changes its policy: trust is gone with the hash.
    const changed = PROJECT_POLICY.replace("value: touch", "value: rm");
    await writeFile(path, changed);
    const later = new Date(Date.now() + 5_000);
    await utimes(path, later, later);
    expect(effectOf(composer, shell("rm -rf x", project))).toBeUndefined();
    expect(composer.inspect(project)?.trusted).toBe(false);
  });

  it("uses the user's policy alone where there is no project policy", () => {
    const composer = createProjectPolicyComposer({
      home,
      trustFile,
      userSources,
    });
    const elsewhere = join(home, "work", "bare");
    expect(effectOf(composer, shell("ls", elsewhere))).toBe("allow");
    expect(composer.inspect(elsewhere)).toBeUndefined();
  });

  it("drops a project policy that does not parse, reports it, and keeps the user's", async () => {
    await writeFile(
      join(project, ".reflex", "policy.yaml"),
      "version: 1\nrules: [\n",
    );
    const composer = createProjectPolicyComposer({
      home,
      trustFile,
      userSources,
    });
    expect(effectOf(composer, shell("ls", project))).toBe("allow");
    expect(composer.problems()).toHaveLength(1);
    expect(composer.problems()[0]).toContain("policy.yaml");
    expect(composer.inspect(project)?.problems).toHaveLength(1);
  });

  it("serves the same compiled set object for the same inputs", async () => {
    await writeFile(join(project, ".reflex", "policy.yaml"), PROJECT_POLICY);
    const composer = createProjectPolicyComposer({
      home,
      trustFile,
      userSources,
    });
    const first = composer.setFor(shell("ls", project));
    const second = composer.setFor(shell("touch b", project));
    expect(second).toBe(first);
    expect(first.hash).not.toBe(
      composer.setFor(shell("ls", join(home, "work", "bare"))).hash,
    );
  });
});
