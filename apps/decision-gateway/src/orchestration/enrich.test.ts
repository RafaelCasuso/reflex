import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionRequest } from "@reflex-control/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createProjectPolicyComposer,
  policyHashOf,
  withTrust,
} from "./project-policy.js";

/**
 * RFX-084 — before a decision, the daemon fills in what the host did not
 * say: the repository's branch and remote, read from git's files, and the
 * environment, from the project's `environments` mapping (ADR-018). What
 * the host said is kept; an untrusted mapping may only raise.
 */
const PROJECT_POLICY = `
version: 1
rules: []
environments:
  production:
    branches: [main]
    remotes: ["github.com/acme/.*"]
  development:
    branches: ["feature/.*"]
`;

let root: string;
let home: string;
let project: string;
let trustFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-enrich-"));
  home = join(root, "home");
  project = join(home, "work", "api");
  trustFile = join(home, ".reflex", "trust.json");
  await mkdir(join(project, ".reflex"), { recursive: true });
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(home, ".reflex"), { recursive: true });
  await writeFile(join(project, ".reflex", "policy.yaml"), PROJECT_POLICY);
  await writeFile(
    join(project, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:acme/api.git\n',
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function checkout(branch: string): Promise<void> {
  await writeFile(join(project, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
}

async function trust(): Promise<void> {
  const path = join(project, ".reflex", "policy.yaml");
  const { readFile } = await import("node:fs/promises");
  const record = withTrust(
    { version: 1, trusted: [] },
    path,
    policyHashOf(await readFile(path, "utf8")),
    new Date(),
  );
  await writeFile(trustFile, JSON.stringify(record));
}

function request(
  cwd: string,
  extra: Partial<DecisionRequest["action"]> = {},
): DecisionRequest {
  const action: DecisionRequest["action"] = {
    id: "act_enrich",
    agent: { host: "claude-code" },
    tool: { name: "Bash" },
    operation: "execute",
    sideEffectClass: "unknown",
    arguments: { command: "git status" },
    cwd,
    createdAt: "2026-10-06T10:00:00.000Z",
    ...extra,
  };
  return { mode: "autopilot", failureMode: "fail-ask", action };
}

function composer() {
  return createProjectPolicyComposer({
    home,
    trustFile,
    userSources: () => [],
    lookupTtlMs: 0,
  });
}

describe("RFX-084 enriching an action", () => {
  it("adds the repository's root, branch and remote host, and the mapped environment", async () => {
    await trust();
    await checkout("main");
    const enriched = composer().enrich(request(join(project, "src")));
    expect(enriched.action.repository).toEqual({
      root: project,
      branch: "main",
      remoteHost: "github.com",
    });
    expect(enriched.action.resource).toEqual({ environment: "production" });
  });

  it("keeps what the host said, and consults the mapping only where it said nothing", async () => {
    await trust();
    await checkout("main");
    const said = composer().enrich(
      request(project, {
        resource: { environment: "test" },
        repository: { branch: "release/1", root: project },
      }),
    );
    expect(said.action.resource).toEqual({ environment: "test" });
    expect(said.action.repository).toEqual({
      root: project,
      branch: "release/1",
      remoteHost: "github.com",
    });
  });

  it("maps a development branch when trusted, and leaves it unknown when the mapping is untrusted", async () => {
    // Branches only: a remote that maps to production would decide first.
    await writeFile(
      join(project, ".reflex", "policy.yaml"),
      'version: 1\nrules: []\nenvironments:\n  production:\n    branches: [main]\n  development:\n    branches: ["feature/.*"]\n',
    );
    await checkout("feature/x");
    const untrusted = composer().enrich(request(project));
    expect(untrusted.action.resource).toBeUndefined();
    expect(untrusted.action.repository?.branch).toBe("feature/x");
    await trust();
    const trusted = composer().enrich(request(project));
    expect(trusted.action.resource).toEqual({ environment: "development" });
  });

  // Adversarial: a hostile clone cannot make its production branch look
  // like development, but its claim to production is honoured untrusted.
  it("lets an untrusted mapping raise to production and never lower", async () => {
    await writeFile(
      join(project, ".reflex", "policy.yaml"),
      'version: 1\nrules: []\nenvironments:\n  development:\n    branches: [".*"]\n  production:\n    remotes: ["github.com/acme/.*"]\n',
    );
    await checkout("main");
    const enriched = composer().enrich(request(project));
    expect(enriched.action.resource).toEqual({ environment: "production" });
  });

  it("returns the request untouched outside any repository, and explains the place either way", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    const given = request(elsewhere);
    const c = composer();
    expect(c.enrich(given)).toBe(given);
    expect(c.placeOf(given.action)).toEqual({
      environment: { environment: "unknown", by: "none" },
    });
    await trust();
    await checkout("main");
    expect(c.placeOf(request(project).action)).toEqual({
      repository: {
        root: project,
        branch: "main",
        remote: "github.com/acme/api",
        remoteHost: "github.com",
      },
      environment: {
        environment: "production",
        by: "mapping",
        matched: "production",
      },
    });
  });
});
