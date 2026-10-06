import { describe, expect, it } from "vitest";

import { branchOf, readGitFacts, remoteOf } from "./git-facts.js";

/**
 * RFX-084 — the repository's facts, read from git's own files, never by
 * running git.
 */
const CONFIG = (url: string) => `[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = ${url}
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
`;

describe("branchOf", () => {
  it("reads the checked-out branch, and nothing for a detached head", () => {
    expect(branchOf("ref: refs/heads/main\n")).toBe("main");
    expect(branchOf("ref: refs/heads/release/2026.10\n")).toBe(
      "release/2026.10",
    );
    expect(branchOf("3f786850e387550fdab836ed7e6dc881de23001b\n")).toBe(
      undefined,
    );
    expect(branchOf(undefined)).toBeUndefined();
    expect(branchOf("ref: refs/tags/v1\n")).toBeUndefined();
  });
});

describe("remoteOf", () => {
  it.each([
    ["git@github.com:acme/api.git", "github.com/acme/api"],
    ["git@GitHub.com:acme/api", "github.com/acme/api"],
    ["https://github.com/acme/api.git", "github.com/acme/api"],
    [
      "https://user@gitlab.example.com/group/sub/api/",
      "gitlab.example.com/group/sub/api",
    ],
    ["ssh://git@github.com/acme/api", "github.com/acme/api"],
    ["ssh://git@github.com:2222/acme/api.git", "github.com/acme/api"],
  ])("reads %s as %s", (url, remote) => {
    expect(remoteOf(CONFIG(url))?.remote).toBe(remote);
  });

  it("gives nothing for a local path, no origin, or a name with control characters", () => {
    expect(remoteOf(CONFIG("/srv/git/api.git"))).toBeUndefined();
    expect(remoteOf(CONFIG("../other"))).toBeUndefined();
    expect(remoteOf("[core]\n\tbare = false\n")).toBeUndefined();
    expect(remoteOf(CONFIG("git@github.com:acme/api\u0007"))).toBeUndefined();
    expect(remoteOf(undefined)).toBeUndefined();
  });

  it("reads origin and not another remote", () => {
    const config = `[remote "upstream"]\n\turl = git@github.com:other/api.git\n[remote "origin"]\n\turl = git@github.com:acme/api.git\n`;
    expect(remoteOf(config)?.remote).toBe("github.com/acme/api");
  });
});

describe("readGitFacts", () => {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const exists = (path: string): "directory" | "file" | undefined =>
    directories.has(path) ? "directory" : files.has(path) ? "file" : undefined;
  const read = (path: string) => files.get(path);

  function repository(root: string, head: string, url?: string): void {
    directories.add(`${root}/.git`);
    files.set(`${root}/.git/HEAD`, head);
    if (url !== undefined) {
      files.set(`${root}/.git/config`, CONFIG(url));
    }
  }

  it("finds the repository above the working directory and reads its facts", () => {
    repository(
      "/home/dev/work/api",
      "ref: refs/heads/main\n",
      "git@github.com:acme/api.git",
    );
    expect(
      readGitFacts("/home/dev/work/api/src/deep", {
        home: "/home/dev",
        exists,
        read,
      }),
    ).toEqual({
      root: "/home/dev/work/api",
      branch: "main",
      remote: "github.com/acme/api",
      remoteHost: "github.com",
    });
  });

  it("stops before the home, and gives nothing outside a repository", () => {
    repository("/home/dev", "ref: refs/heads/dotfiles\n");
    expect(
      readGitFacts("/home/dev/notes", { home: "/home/dev", exists, read }),
    ).toBeUndefined();
    expect(
      readGitFacts("/tmp/elsewhere", { home: "/home/dev", exists, read }),
    ).toBeUndefined();
  });

  it("follows a worktree's .git file and its common directory", () => {
    repository(
      "/home/dev/work/main",
      "ref: refs/heads/main\n",
      "git@github.com:acme/api.git",
    );
    files.set(
      "/home/dev/work/wt/.git",
      "gitdir: /home/dev/work/main/.git/worktrees/wt\n",
    );
    files.set(
      "/home/dev/work/main/.git/worktrees/wt/HEAD",
      "ref: refs/heads/feature/x\n",
    );
    files.set("/home/dev/work/main/.git/worktrees/wt/commondir", "../..\n");
    expect(
      readGitFacts("/home/dev/work/wt", { home: "/home/dev", exists, read }),
    ).toEqual({
      root: "/home/dev/work/wt",
      branch: "feature/x",
      remote: "github.com/acme/api",
      remoteHost: "github.com",
    });
  });

  it("reports a detached head as no branch, and no origin as no remote", () => {
    repository(
      "/home/dev/work/bare",
      "3f786850e387550fdab836ed7e6dc881de23001b\n",
    );
    expect(
      readGitFacts("/home/dev/work/bare", { home: "/home/dev", exists, read }),
    ).toEqual({
      root: "/home/dev/work/bare",
    });
  });
});
