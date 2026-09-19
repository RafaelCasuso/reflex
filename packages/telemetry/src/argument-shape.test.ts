import { describe, expect, it } from "vitest";

import { describeShape } from "./argument-shape.js";

/** RFX-086 — keys, types and sizes, never a raw argument value. */
describe("RFX-086 argument shape", () => {
  it("describes a Bash call without its command", () => {
    expect(
      describeShape({
        command: "git status",
        description: "Show working tree status",
        timeout: 120_000,
        run_in_background: false,
      }),
    ).toEqual({
      type: "object",
      otherKeys: 0,
      keys: {
        command: { type: "string", length: 10 },
        description: { type: "string", length: 24 },
        timeout: { type: "number" },
        run_in_background: { type: "boolean" },
      },
    });
  });

  it("describes nested structures by their first item", () => {
    expect(
      describeShape({
        edits: [
          { old_string: "a", new_string: "bb" },
          { old_string: "ccc", new_string: "" },
        ],
        tags: [],
        nothing: null,
      }),
    ).toEqual({
      type: "object",
      otherKeys: 0,
      keys: {
        edits: {
          type: "array",
          length: 2,
          items: {
            type: "object",
            otherKeys: 0,
            keys: {
              old_string: { type: "string", length: 1 },
              new_string: { type: "string", length: 2 },
            },
          },
        },
        tags: { type: "array", length: 0 },
        nothing: { type: "null" },
      },
    });
  });

  // Adversarial: the whole point of a shape is that no value survives it.
  it("never contains a value, at any depth", () => {
    const secret = "sk-live-9f3a1c7e2b4d";
    const shape = describeShape({
      command: `curl -H 'Authorization: Bearer ${secret}' https://api.example.com`,
      env: { API_KEY: secret, nested: { token: secret } },
      list: [secret, [secret], { value: secret }],
      number: 4242424242,
      flag: true,
    });
    const serialized = JSON.stringify(shape);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("9f3a1c7e2b4d");
    expect(serialized).not.toContain("api.example.com");
    expect(serialized).not.toContain("4242424242");
  });

  it("counts keys that look like data instead of writing them", () => {
    const shape = describeShape({
      file_path: "/tmp/x",
      "alice@example.com": 1,
      "/Users/alice/secret plans.txt": 2,
      "sk-live-9f3a1c7e2b4d": 3,
      "a sentence used as a key": 4,
      "": 5,
      ghp_16C7e42F292c6912E7710c838347Ae178B4a: 6,
      AKIA1234567890EXAMPLE: 7,
      "550e8400-e29b-41d4-a716-446655440000": 8,
      a_very_long_identifier_that_no_tool_schema_would_use: 9,
    });

    expect(shape).toEqual({
      type: "object",
      otherKeys: 9,
      keys: { file_path: { type: "string", length: 6 } },
    });
    const serialized = JSON.stringify(shape);
    for (const leaked of ["alice", "sk-live", "ghp_", "AKIA", "550e8400"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("writes key names only near the top, where tool schemas define them", () => {
    const shape = describeShape({
      filters: { status: "open", labels: { team_name: "x", owner: "y" } },
    });
    expect(shape).toEqual({
      type: "object",
      otherKeys: 0,
      keys: {
        filters: {
          type: "object",
          otherKeys: 0,
          keys: {
            status: { type: "string", length: 4 },
            // Third level: counted, not named.
            labels: { type: "object", otherKeys: 2, keys: {} },
          },
        },
      },
    });
  });

  it("bounds the number of keys it writes per object", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `key_${String(index)}`,
        index,
      ]),
    );
    const shape = describeShape(wide);
    expect(shape.type).toBe("object");
    if (shape.type === "object") {
      expect(Object.keys(shape.keys)).toHaveLength(32);
      expect(shape.otherKeys).toBe(468);
    }
  });

  it("stays small and terminates on a nesting bomb or a cycle", () => {
    let objects: unknown = "core";
    let arrays: unknown = "core";
    for (let depth = 0; depth < 100_000; depth += 1) {
      objects = { next: objects };
      arrays = [arrays];
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    // Objects stop being described below the named levels.
    expect(JSON.stringify(describeShape(objects)).length).toBeLessThan(300);
    expect(JSON.stringify(describeShape(cyclic)).length).toBeLessThan(300);
    // Arrays carry no names, so the depth limit is what stops them.
    const nested = JSON.stringify(describeShape(arrays));
    expect(nested).toContain('"truncated"');
    expect(nested.length).toBeLessThan(300);
  });

  it("marks what JSON cannot carry as unsupported, without reading it", () => {
    class Payload {
      readonly secret = "sk-live-9f3a1c7e2b4d";
    }
    const shape = describeShape({
      when: new Date(0),
      instance: new Payload(),
      missing: undefined,
      big: 10n,
      fn: () => "sk-live-9f3a1c7e2b4d",
    });

    expect(shape).toEqual({
      type: "object",
      otherKeys: 0,
      keys: {
        when: { type: "unsupported" },
        instance: { type: "unsupported" },
        missing: { type: "unsupported" },
        big: { type: "unsupported" },
        fn: { type: "unsupported" },
      },
    });
  });

  it("treats a __proto__ key as a key and pollutes nothing", () => {
    const hostile: unknown = JSON.parse(
      '{"__proto__": {"polluted": "yes"}, "command": "ls"}',
    );
    const shape = describeShape(hostile);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(shape.type).toBe("object");
    if (shape.type === "object") {
      expect(Object.keys(shape.keys).sort()).toEqual(["__proto__", "command"]);
      expect(Object.getPrototypeOf(shape.keys)).toBe(Object.prototype);
    }
  });

  it.each([
    ["a string", "hello", { type: "string", length: 5 }],
    ["a number", 3.14, { type: "number" }],
    ["NaN", Number.NaN, { type: "number" }],
    ["null", null, { type: "null" }],
    [
      "an array",
      [1, 2, 3],
      { type: "array", length: 3, items: { type: "number" } },
    ],
  ])("describes %s at the root", (_label, value, expected) => {
    expect(describeShape(value)).toEqual(expected);
  });
});
