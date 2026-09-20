import { describe, expect, it } from "vitest";

import { isWithin, normalizePath, resolveRoot } from "./paths.js";

/** RFX-097 — normalization and containment. */
const context = {
  cwd: "/work/project",
  home: "/home/dev",
  projectRoot: "/work/project",
};

describe("RFX-097 path normalization", () => {
  it.each([
    ["src/date.ts", "/work/project/src/date.ts"],
    ["./src/../src/./date.ts", "/work/project/src/date.ts"],
    ["/work/project/", "/work/project"],
    ["/work//project///src", "/work/project/src"],
    ["~", "/home/dev"],
    ["~/.ssh/id_ed25519", "/home/dev/.ssh/id_ed25519"],
    ["..", "/work"],
    ["../../..", "/"],
    ["/../../etc/passwd", "/etc/passwd"],
    [".", "/work/project"],
  ])("%s becomes %s", (path, expected) => {
    expect(normalizePath(path, context)).toBe(expected);
  });

  it("does not guess what it cannot know", () => {
    expect(normalizePath("src/date.ts", {})).toBeUndefined();
    expect(normalizePath("~/x", {})).toBeUndefined();
    expect(normalizePath("~root/x", context)).toBeUndefined();
  });

  it("resolves the placeholders a rule may use", () => {
    expect(resolveRoot("${project}/src", context)).toBe("/work/project/src");
    expect(resolveRoot("${home}/.config", context)).toBe("/home/dev/.config");
    expect(resolveRoot("~/code", context)).toBe("/home/dev/code");
    expect(resolveRoot("${project}", {})).toBeUndefined();
    expect(resolveRoot("${home}", { projectRoot: "/x" })).toBeUndefined();
  });
});

describe("RFX-097 containment", () => {
  const within = (path: string, ignoreCase = false): boolean => {
    const normalized = normalizePath(path, context);
    return (
      normalized !== undefined &&
      isWithin(normalized, "/work/project", ignoreCase)
    );
  };

  it("holds for the root and for what is under it", () => {
    expect(within("/work/project")).toBe(true);
    expect(within("/work/project/")).toBe(true);
    expect(within("src/date.ts")).toBe(true);
    expect(within("/work/project/a/b/c")).toBe(true);
  });

  // The acceptance: traversal, case and trailing-separator tricks cannot make
  // a path outside the root match.
  it.each([
    ["traversal out of the root", "/work/project/../../etc/passwd"],
    ["traversal from a relative path", "../../etc/passwd"],
    [
      "traversal that comes back beside the root",
      "/work/project/../project-evil/x",
    ],
    ["a sibling that shares the prefix", "/work/project-evil/x"],
    [
      "a sibling that shares the prefix, with a separator trick",
      "/work/project-evil//x/",
    ],
    ["the parent", "/work"],
    ["the home directory", "~/.ssh/id_ed25519"],
    ["a path that only matches by case", "/WORK/Project/src"],
  ])("%s is outside", (_label, path) => {
    expect(within(path)).toBe(false);
  });

  // For a restrictive rule the safe mistake is the other one.
  it("ignores case when asked, for rules that restrict", () => {
    expect(within("/WORK/Project/src", true)).toBe(true);
    expect(within("/WORK/Project-evil/src", true)).toBe(false);
  });

  it("treats composed and decomposed Unicode as the same name", () => {
    const composed = normalizePath(
      `/work/project/caf${String.fromCodePoint(0xe9)}`,
      context,
    );
    const decomposed = normalizePath(
      `/work/project/cafe${String.fromCodePoint(0x301)}`,
      context,
    );
    expect(composed).toBe(decomposed);
  });
});
