import type { SideEffectClass } from "@reflex-control/contracts";
import { describe, expect, it } from "vitest";

import { classifyArgv, classifyCommand } from "./classify.js";

/**
 * RFX-111 — what the mutation check found untested in the classifier: the
 * git subcommands read one word at a time, the request method of curl and
 * httpie, the areas of gh, the words that run nothing, the paths that skip
 * a mode or an owner, the redirections read as files, and the host:path
 * form that only a remote shell names.
 */
const classOf = (command: string): SideEffectClass =>
  classifyCommand(command).sideEffectClass;
const pathsOf = (command: string): readonly string[] | undefined =>
  classifyCommand(command).segments[0]?.paths;
const hostsOf = (command: string): readonly string[] | undefined =>
  classifyCommand(command).segments[0]?.networkHosts;

describe("git, one word at a time", () => {
  it.each<[string, SideEffectClass]>([
    ["git stash", "local-write"],
    ["git stash push -m wip", "local-write"],
    ["git stash pop", "local-write"],
    ["git stash list", "local-read"],
    ["git stash show -p", "local-read"],
    ["git stash drop", "destructive"],
    ["git stash clear", "destructive"],
    ["git remote", "local-read"],
    ["git remote -v", "local-read"],
    ["git remote show origin", "local-read"],
    ["git remote get-url origin", "local-read"],
    [
      "git remote add upstream https://example.test/org/repo.git",
      "local-write",
    ],
    [
      "git remote set-url origin https://example.test/org/repo.git",
      "local-write",
    ],
    ["git remote remove upstream", "local-write"],
    ["git config user.name", "local-read"],
    ["git config --get user.name", "local-read"],
    ["git config user.name Dev", "local-write"],
    ["git reflog", "local-read"],
    ["git reflog show", "local-read"],
    ["git reflog expire --expire=now --all", "destructive"],
    ["git reflog delete HEAD@{1}", "destructive"],
    ["git checkout -- src/date.ts", "destructive"],
    ["git checkout .", "destructive"],
    ["git checkout -f main", "destructive"],
    ["git checkout main", "local-write"],
  ])("%s is %s", (command, expected) => {
    expect(classOf(command)).toBe(expected);
  });

  it("names the paths after `--` and nothing before it", () => {
    expect(pathsOf("git add -A")).toEqual([]);
    expect(pathsOf("git checkout -- date.ts")).toEqual(["date.ts"]);
    expect(pathsOf("git restore --staged -- date.ts")).toEqual(["date.ts"]);
  });
});

describe("the request method", () => {
  it("is read wherever curl is given it", () => {
    expect(classOf("curl -s --request GET https://example.test/x")).toBe(
      "external-read",
    );
    expect(classOf("curl -s -X GET https://example.test/x")).toBe(
      "external-read",
    );
    expect(classOf("curl https://example.test/x --request DELETE")).toBe(
      "external-write",
    );
    expect(classOf("curl -XDELETE https://example.test/x")).toBe(
      "external-write",
    );
  });

  it("is httpie's first word, when there is a URL after it", () => {
    expect(classOf("http POST https://example.test/api name=x")).toBe(
      "external-write",
    );
    expect(classOf("https DELETE example.test/api/1")).toBe("external-write");
    expect(classOf("http https://example.test/api")).toBe("external-read");
    expect(classOf("https example.test/api")).toBe("external-read");
  });
});

describe("gh, by area and verb", () => {
  it.each<[string, SideEffectClass]>([
    ["gh auth status", "external-read"],
    ["gh auth login", "external-write"],
    ["gh auth token", "credential"],
    ["gh repo view org/repo", "external-read"],
    ["gh repo delete org/repo --yes", "destructive"],
    ["gh release delete v1 --yes", "external-write"],
    ["gh api repos/org/repo/issues", "external-read"],
    ["gh api -X POST repos/org/repo/issues -f title=x", "external-write"],
    ["gh api --method DELETE repos/org/repo/issues/1", "external-write"],
    ["gh api repos/org/repo/issues -f title=x", "external-write"],
    ["gh", "external-read"],
  ])("%s is %s", (command, expected) => {
    expect(classOf(command)).toBe(expected);
  });
});

describe("publishing", () => {
  it.each([
    "npm publish",
    "pnpm publish",
    "yarn publish",
    "bun publish",
    "cargo publish",
  ])("%s is an external write", (command) => {
    expect(classOf(command)).toBe("external-write");
  });

  it("is only what a package manager does with the word", () => {
    expect(classOf("npx publish")).toBe("unknown");
    expect(classOf("pnpm run publish")).toBe("unknown");
  });
});

describe("words that run nothing", () => {
  it.each(["cd packages", ":", "true", "false"])(
    "%s does nothing",
    (command) => {
      const classified = classifyCommand(command);
      expect(classified.sideEffectClass).toBe("none");
      expect(classified.segments[0]?.sideEffectClass).toBe("none");
    },
  );

  it("reads a bare `set` as printing the environment, and `set -e` as a shell option", () => {
    expect(classOf("set")).toBe("credential");
    expect(classOf("set -e")).toBe("unknown");
  });
});

describe("indirect only when what runs is defined elsewhere", () => {
  it.each([
    "git status",
    "curl https://example.test/x",
    "gh pr view 42",
    "stripe customers list",
    "chmod 600 notes.txt",
    "rm -rf dist",
    "ssh deploy@prod.example.test uptime",
    "find . -name x",
    "sed -n 1p notes.txt",
    "grep x notes.txt",
    "ls",
    "touch notes.txt",
    "no-such-program --flag",
    'bash -c "ls"',
  ])("%s is not indirect", (command) => {
    const classified = classifyCommand(command);
    expect(classified.segments.length).toBeGreaterThan(0);
    for (const entry of classified.segments) {
      expect(entry.indirect, entry.segment.text).toBe(false);
    }
  });
});

describe("paths", () => {
  it("skips the mode or the owner, and names the rest", () => {
    expect(pathsOf("chmod 600 notes.txt")).toEqual(["notes.txt"]);
    expect(pathsOf("chown dev notes.txt")).toEqual(["notes.txt"]);
    expect(pathsOf("chgrp staff notes.txt")).toEqual(["notes.txt"]);
  });

  it("names sed's files, and never an empty word", () => {
    expect(pathsOf("sed -n 1p notes.txt")).toEqual(["notes.txt"]);
    expect(classOf("sed -n 1p notes.txt")).toBe("local-read");
    // The macOS in-place idiom: an empty backup suffix is not a file.
    const inPlace = pathsOf("sed -i '' -e 's/a/b/' notes.txt");
    expect(inPlace).toContain("notes.txt");
    expect(inPlace).not.toContain("");
  });

  it("names what a remote shell copies only when it is written like a path", () => {
    expect(
      pathsOf("scp build.tgz deploy@files.example.test:/srv/"),
    ).not.toContain("build.tgz");
    expect(
      pathsOf("scp ./build.tgz deploy@files.example.test:/srv/"),
    ).toContain("./build.tgz");
  });

  it("names a search root only when it is written like a path", () => {
    expect(pathsOf("find src -name x")).toEqual([]);
    expect(pathsOf("find ./src -name x")).toEqual(["./src"]);
    expect(pathsOf("find . -path ./node_modules -prune")).toEqual([
      ".",
      "./node_modules",
    ]);
  });
});

describe("redirections", () => {
  it("reads a numeric target as a file unless the operator duplicates a descriptor", () => {
    expect(classifyCommand("echo hi > 1")).toMatchObject({
      sideEffectClass: "destructive",
      segments: [{ paths: ["1"] }],
    });
    expect(pathsOf("ls 2>&1")).toEqual([]);
  });

  it("reads an input redirection as a read of the file", () => {
    const classified = classifyCommand("cat < notes.txt");
    expect(classified.sideEffectClass).toBe("local-read");
    expect(classified.segments[0]?.paths).toEqual(["notes.txt"]);
  });
});

describe("hosts", () => {
  it("reads host:path only for a remote shell", () => {
    expect(hostsOf("echo see localhost: ok")).toEqual([]);
    expect(hostsOf("rsync -a src/ backup.example.test:/srv/")).toEqual([
      "backup.example.test",
    ]);
  });

  it("names no host for ssh with nothing to connect to", () => {
    expect(hostsOf("ssh -V")).toEqual([]);
    expect(hostsOf("ssh")).toEqual([]);
  });
});

describe("a command given as an argument vector", () => {
  it("reads -c as a script only for a shell", () => {
    const classified = classifyArgv(["ls", "-c"]);
    expect(classified.sideEffectClass).toBe("local-read");
    expect(classified.segments[0]?.segment.name).toBe("ls");
  });

  it("marks its one segment understood, since nothing in it was expanded", () => {
    expect(
      classifyArgv(["rm", "-rf", "$HOME"]).segments[0]?.segment.understood,
    ).toBe(true);
  });
});
