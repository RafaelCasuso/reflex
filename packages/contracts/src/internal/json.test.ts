import { describe, expect, it } from "vitest";

import { findJsonViolation } from "./json.js";

describe("bounded JSON walker", () => {
  it("accepts ordinary JSON objects", () => {
    expect(findJsonViolation({})).toBeUndefined();
    expect(
      findJsonViolation({
        text: "x",
        count: 3,
        ratio: -0.5,
        flag: false,
        nothing: null,
        list: [1, "two", [3], { four: 4 }],
        nested: { deeper: { deepest: [] } },
      }),
    ).toBeUndefined();
    expect(findJsonViolation(Object.create(null))).toBeUndefined();
  });

  it.each([
    ["an array", []],
    ["a string", "{}"],
    ["null", null],
    ["undefined", undefined],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    [
      "a class instance",
      new (class Payload {
        readonly kind = "payload";
      })(),
    ],
    ["a function", () => ({})],
  ])("rejects %s as the root", (_label, root) => {
    expect(findJsonViolation(root)).toEqual({
      path: [],
      reason: "not_plain_object",
    });
  });

  it.each([
    ["undefined", undefined],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a bigint", 10n],
    ["a Date", new Date(0)],
    ["a Map", new Map([["k", "v"]])],
    ["a Set", new Set([1])],
    ["a RegExp", /x/],
    [
      "a class instance",
      new (class Secret {
        readonly kind = "secret";
      })(),
    ],
    ["a boxed string", new String("x")],
  ])("rejects %s as a value and reports where", (_label, value) => {
    expect(findJsonViolation({ outer: { list: ["ok", value] } })).toEqual({
      path: ["outer", "list", 1],
      reason: "unsupported_value",
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects the non-finite number %d",
    (value) => {
      expect(findJsonViolation({ amount: value })).toEqual({
        path: ["amount"],
        reason: "non_finite_number",
      });
    },
  );

  it("rejects array holes, which JSON would silently turn into null", () => {
    const sparse: unknown[] = ["a"];
    sparse[2] = "c";
    expect(findJsonViolation({ sparse })).toEqual({
      path: ["sparse", 1],
      reason: "unsupported_value",
    });
  });

  // Adversarial: the walker runs on every request, on input the agent shapes.
  it("survives a nesting bomb without touching the call stack", () => {
    let bomb: unknown = "core";
    for (let depth = 0; depth < 200_000; depth += 1) {
      bomb = [bomb];
    }
    expect(findJsonViolation({ bomb })?.reason).toBe("too_deep");
  });

  it("terminates on a cyclic object", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(findJsonViolation(cyclic)?.reason).toBe("too_deep");
  });

  it("bounds total work on a wide payload", () => {
    const wide = { items: Array.from({ length: 200_000 }, () => 0) };
    expect(findJsonViolation(wide)?.reason).toBe("too_large");
  });

  it("enforces exactly the configured depth", () => {
    const limits = { maxDepth: 3, maxNodes: 1_000 };
    expect(findJsonViolation({ a: { b: { c: 1 } } }, limits)).toBeUndefined();
    expect(findJsonViolation({ a: { b: { c: { d: 1 } } } }, limits)).toEqual({
      path: ["a", "b", "c"],
      reason: "too_deep",
    });
  });

  it("treats a __proto__ key as data and pollutes nothing", () => {
    const hostile: unknown = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}',
    );
    expect(findJsonViolation(hostile)).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
