import { describe, expect, it } from "vitest";

import {
  CONTEXT,
  compiled,
  fileTool,
  local,
  shell,
} from "./engine.test-support.js";
import { evaluatePolicy } from "./evaluator.js";

/**
 * RFX-148 — what the evaluation says the classifier saw: one entry per
 * subject with its class and its normalized paths, and the project root.
 * A stage that decides after policy reads these instead of re-parsing the
 * command, so that `rm -rf dist coverage` and `rm -rf ~` are told apart by
 * evidence a model cannot fake.
 */
const EMPTY = compiled(
  local(`version: 1
defaults:
  unresolved: semantic
rules: []
`),
);

describe("RFX-148 the subjects the evaluation reports", () => {
  it("reports one subject per segment, with its class and its normalized paths", () => {
    const result = evaluatePolicy(
      EMPTY,
      shell("rm -rf dist coverage"),
      CONTEXT,
    );
    expect(result.projectRoot).toBe("/work/project");
    expect(result.subjects).toEqual([
      {
        sideEffectClass: "destructive",
        paths: ["/work/project/dist", "/work/project/coverage"],
        understood: true,
      },
    ]);
  });

  it("keeps the segments apart: the harmless one and the one that points home", () => {
    const result = evaluatePolicy(
      EMPTY,
      shell("git status; rm -rf ~"),
      CONTEXT,
    );
    expect(result.subjects.map((subject) => subject.sideEffectClass)).toEqual([
      "local-read",
      "destructive",
    ]);
    expect(result.subjects[1]?.paths).toEqual(["/home/dev"]);
    expect(result.subjects.every((subject) => subject.understood)).toBe(true);
  });

  it("normalizes a path that climbs out of the project, and never past the root", () => {
    const result = evaluatePolicy(EMPTY, shell("rm -rf ../../"), CONTEXT);
    expect(result.subjects[0]?.paths).toEqual(["/"]);
    const inside = evaluatePolicy(
      EMPTY,
      shell("rm -rf dist/../coverage"),
      CONTEXT,
    );
    expect(inside.subjects[0]?.paths).toEqual(["/work/project/coverage"]);
  });

  it("marks a segment whose arguments it could not read as not understood", () => {
    const result = evaluatePolicy(EMPTY, shell("rm -rf $DIR"), CONTEXT);
    expect(result.subjects).toHaveLength(1);
    expect(result.subjects[0]?.understood).toBe(false);
    expect(result.subjects[0]?.paths).toEqual([]);
    // A glob is an open list too: what it expands to is not known.
    const glob = evaluatePolicy(EMPTY, shell("rm -rf dist/*"), CONTEXT);
    expect(glob.subjects[0]?.understood).toBe(false);
  });

  it("keeps a path as written when it cannot be made absolute, and says so", () => {
    const copy: Record<string, unknown> = { ...shell("rm -rf dist") };
    delete copy.cwd;
    delete copy.repository;
    const result = evaluatePolicy(
      EMPTY,
      copy as unknown as ReturnType<typeof shell>,
      { home: "/home/dev" },
    );
    expect(result.subjects[0]?.paths).toEqual(["dist"]);
    expect(result.subjects[0]?.understood).toBe(false);
    expect(result.projectRoot).toBeUndefined();
  });

  it("takes the project root from the context before the action", () => {
    const fromAction = evaluatePolicy(EMPTY, shell("ls"), {
      home: "/home/dev",
    });
    expect(fromAction.projectRoot).toBe("/work/project");
    const fromContext = evaluatePolicy(EMPTY, shell("ls"), {
      home: "/home/dev",
      projectRoot: "/elsewhere",
    });
    expect(fromContext.projectRoot).toBe("/elsewhere");
  });

  it("reports a tool call as one subject with the paths it declares", () => {
    const result = evaluatePolicy(
      EMPTY,
      fileTool("Write", "/work/project/src/date.ts"),
      CONTEXT,
    );
    expect(result.subjects).toHaveLength(1);
    expect(result.subjects[0]?.paths).toEqual(["/work/project/src/date.ts"]);
    expect(result.subjects[0]?.understood).toBe(true);
    expect(result.subjects[0]?.sideEffectClass).toBe(result.sideEffectClass);
  });
});
