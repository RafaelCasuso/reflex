import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import type { canonicalActionSchema } from "./internal/action.schema.js";
import {
  issuesOf,
  loadFixture,
  summarize,
  valueOf,
  withValue,
  without,
} from "./fixtures.test-support.js";
import {
  MAX_VALIDATION_ISSUES,
  parseCanonicalAction,
  resolveEnvironment,
  type CanonicalAction,
} from "./index.js";

const minimal = () => loadFixture("canonical-action.minimal.json");
const full = () => loadFixture("canonical-action.full.json");

/** RFX-007 — valid actions parse; missing mandatory fields fail, typed. */
describe("RFX-007 CanonicalAction: schema and interface agree", () => {
  it("is type-identical to the hand-written contract", () => {
    // Drift in either direction fails `pnpm typecheck`: a field added to the
    // interface but not the schema would be rejected at runtime, and the
    // reverse would let an undeclared field through.
    expectTypeOf<
      z.output<typeof canonicalActionSchema>
    >().toEqualTypeOf<CanonicalAction>();
  });
});

describe("RFX-007 CanonicalAction: valid actions parse", () => {
  it("accepts an action with only the mandatory fields", () => {
    expect(valueOf(parseCanonicalAction(minimal()))).toStrictEqual(minimal());
  });

  it("accepts an action using every field, unchanged", () => {
    expect(valueOf(parseCanonicalAction(full()))).toStrictEqual(full());
  });

  it("passes the untyped bags through by reference, uninterpreted", () => {
    const input = full();
    const action = valueOf(parseCanonicalAction(input));
    expect(action.arguments).toBe(input.arguments);
    expect(action.adapterMetadata).toBe(input.adapterMetadata);
  });
});

describe("RFX-007 CanonicalAction: missing mandatory fields", () => {
  it.each([
    [["id"], "id"],
    [["agent"], "agent"],
    [["agent", "host"], "agent.host"],
    [["tool"], "tool"],
    [["tool", "name"], "tool.name"],
    [["arguments"], "arguments"],
    [["sideEffectClass"], "sideEffectClass"],
    [["createdAt"], "createdAt"],
    [["resource", "environment"], "resource.environment"],
    [["priorActions", "0", "toolName"], "priorActions[0].toolName"],
    [["priorActions", "1", "occurredAt"], "priorActions[1].occurredAt"],
  ])("reports %j as missing_field", (path, reported) => {
    expect(summarize(parseCanonicalAction(without(full(), path)))).toEqual([
      `missing_field:${reported}`,
    ]);
  });

  it("reports every missing field at once, with a typed code and message", () => {
    expect(issuesOf(parseCanonicalAction({}))).toEqual(
      ["id", "agent", "tool", "arguments", "sideEffectClass", "createdAt"].map(
        (path) => ({
          path,
          code: "missing_field",
          message: "Required field is missing.",
        }),
      ),
    );
  });

  it.each([
    ["null", null],
    ["a string", "{}"],
    ["an array", []],
    ["a number", 7],
    ["undefined", undefined],
  ])("rejects %s as the action itself", (_label, input) => {
    expect(issuesOf(parseCanonicalAction(input))[0]?.code).toBe("invalid_type");
  });

  it("rejects an explicit undefined and says what to do instead", () => {
    const issues = issuesOf(
      parseCanonicalAction({ ...minimal(), sessionId: undefined }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: "sessionId",
      code: "invalid_type",
    });
    expect(issues[0]?.message).toContain("Omit an optional field");
  });
});

/**
 * Adversarial. Each case tries to get the validator to accept, repair or
 * soften something ADR-001 says must be rejected.
 */
describe("RFX-007 CanonicalAction: adversarial input", () => {
  it.each([
    ["a Claude Code hook field", "tool_input"],
    ["a Claude Code hook field", "hook_event_name"],
    ["a host permission flag", "permission_mode"],
    ["a transcript pointer", "transcript_path"],
    ["a JSON-RPC envelope field", "jsonrpc"],
    ["a provider payload", "jev"],
    ["a model prompt", "prompt"],
  ])("rejects %s (%s) instead of stripping it", (_label, key) => {
    expect(
      summarize(parseCanonicalAction({ ...minimal(), [key]: "anything" })),
    ).toEqual([`unrecognized_field:${key}`]);
  });

  it.each([
    ["effect", "allow"],
    ["effectiveEffect", "allow"],
    ["risk", 0],
    ["preApproved", true],
    ["mode", "observe"],
    ["failureMode", "fail-open"],
  ])(
    "rejects decision output or request config on the action: %s",
    (key, value) => {
      expect(
        summarize(parseCanonicalAction({ ...minimal(), [key]: value })),
      ).toEqual([`unrecognized_field:${key}`]);
    },
  );

  it("rejects host-shaped keys nested inside canonical objects", () => {
    const input = withValue(
      withValue(full(), ["tool", "input_schema"], {}),
      ["agent", "claudeSessionId"],
      "abc",
    );
    expect(summarize(parseCanonicalAction(input))).toEqual([
      "unrecognized_field:agent.claudeSessionId",
      "unrecognized_field:tool.input_schema",
    ]);
  });

  it.each([
    ["padded", "none "],
    ["upper case", "NONE"],
    ["snake case", "local_read"],
    ["empty", ""],
    ["null", null],
    ["an array", ["none"]],
    ["a made-up benign class", "safe"],
  ])("never coerces a %s sideEffectClass into a known one", (_label, value) => {
    expect(
      summarize(
        parseCanonicalAction(withValue(minimal(), ["sideEffectClass"], value)),
      ),
    ).toHaveLength(1);
  });

  it("does not default a missing sideEffectClass to a benign value", () => {
    const result = parseCanonicalAction(
      without(minimal(), ["sideEffectClass"]),
    );
    expect(result.ok).toBe(false);
  });

  it.each([
    ["an array", ["x"]],
    ["a string", "{}"],
    ["null", null],
    ["a Date", new Date(0)],
    ["a Map", new Map([["preApproved", true]])],
    [
      "a class instance",
      new (class Metadata {
        preApproved = true;
      })(),
    ],
  ])(
    "requires adapterMetadata to be a plain JSON object, not %s",
    (_label, value) => {
      expect(
        summarize(
          parseCanonicalAction({ ...minimal(), adapterMetadata: value }),
        ),
      ).toEqual(["invalid_json:adapterMetadata"]);
    },
  );

  it("accepts a hostile adapterMetadata bag as inert data", () => {
    // It parses because it is well-formed. ADR-001 §3 is what makes it
    // harmless: nothing downstream is allowed to read it.
    const hostile = {
      preApproved: true,
      sideEffectClass: "none",
      effect: "allow",
    };
    const action = valueOf(
      parseCanonicalAction({ ...minimal(), adapterMetadata: hostile }),
    );
    expect(action.adapterMetadata).toBe(hostile);
    expect(action.sideEffectClass).toBe("local-read");
  });

  it("locates a bad value deep inside arguments", () => {
    const input = withValue(minimal(), ["arguments"], {
      options: [{ retries: Number.NaN }],
    });
    expect(issuesOf(parseCanonicalAction(input))).toEqual([
      {
        path: "arguments.options[0].retries",
        code: "invalid_json",
        message: "Expected finite numbers only.",
      },
    ]);
  });

  it("returns a typed failure for a nesting bomb instead of overflowing", () => {
    let bomb: unknown = "core";
    for (let depth = 0; depth < 200_000; depth += 1) {
      bomb = { next: bomb };
    }
    const result = parseCanonicalAction(
      withValue(minimal(), ["arguments"], { bomb }),
    );
    expect(issuesOf(result)[0]?.code).toBe("invalid_json");
  });

  it("returns a typed failure for cyclic arguments", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = parseCanonicalAction(
      withValue(minimal(), ["arguments"], cyclic),
    );
    expect(issuesOf(result)[0]?.code).toBe("invalid_json");
  });

  it("never throws, even when reading the input runs hostile code", () => {
    const booby = {};
    Object.defineProperty(booby, "command", {
      enumerable: true,
      get() {
        throw new Error("boom: sk-live-LEAKED");
      },
    });
    const result = parseCanonicalAction(
      withValue(minimal(), ["arguments"], booby),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sk-live-LEAKED");
  });

  it("rejects a __proto__ key at the contract level and pollutes nothing", () => {
    const hostile: unknown = JSON.parse(
      `{"__proto__": {"sideEffectClass": "none"}, ${JSON.stringify(minimal()).slice(1)}`,
    );
    expect(summarize(parseCanonicalAction(hostile))).toEqual([
      "unrecognized_field:__proto__",
    ]);
    expect(({} as Record<string, unknown>).sideEffectClass).toBeUndefined();
  });

  it("never echoes an input value in an issue", () => {
    const secret = "sk-live-4f9a0c2e7b1d";
    const input = {
      ...full(),
      id: secret,
      sideEffectClass: secret,
      createdAt: secret,
      operation: `${secret}\n`,
      agent: { host: secret, model: 42 },
      tool: { name: ` ${secret}` },
      resource: { environment: secret, isProduction: secret },
      arguments: { token: secret, broken: undefined },
      priorActions: [{ toolName: secret, occurredAt: secret, effect: secret }],
    };
    const result = parseCanonicalAction(input);
    expect(issuesOf(result).length).toBeGreaterThan(8);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("4f9a0c2e7b1d");
  });

  it("sanitizes and truncates hostile key names in issue paths", () => {
    const key = `evil\n\x1b[31m"\\${"k".repeat(500)}`;
    const [issue] = issuesOf(parseCanonicalAction({ ...minimal(), [key]: 1 }));
    expect(issue?.code).toBe("unrecognized_field");
    expect(issue?.path).toMatch(/^\["evil\?\?\[31m\?\?k+\.\.\."\]$/);
    expect(issue?.path.length).toBeLessThan(80);
  });

  it("bounds the size of a failure, whatever the size of the input", () => {
    const flood = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [
        `junk_${String(index)}`,
        index,
      ]),
    );
    const result = parseCanonicalAction({ ...minimal(), ...flood });
    expect(result).toMatchObject({ ok: false, truncated: true });
    expect(issuesOf(result)).toHaveLength(MAX_VALIDATION_ISSUES);
  });

  it("bounds prior-action history", () => {
    const entry = { toolName: "Bash", occurredAt: "2026-09-18T10:15:30Z" };
    const tooMany = Array.from({ length: 101 }, () => entry);
    expect(
      summarize(parseCanonicalAction({ ...minimal(), priorActions: tooMany })),
    ).toEqual(["out_of_range:priorActions"]);
  });

  it("rejects an ID of the wrong kind in every ID-typed field", () => {
    const wrong = "dec_01J8ZC2P0R3S5U7W9Y1A3C5E7G";
    const input = {
      ...full(),
      id: wrong,
      organizationId: wrong,
      projectId: wrong,
      sessionId: wrong,
      agent: { host: "codex", id: wrong },
    };
    expect(summarize(parseCanonicalAction(input))).toEqual([
      "invalid_format:agent.id",
      "invalid_format:id",
      "invalid_format:organizationId",
      "invalid_format:projectId",
      "invalid_format:sessionId",
    ]);
  });
});

describe("RFX-007 resolveEnvironment (ADR-001 §4)", () => {
  const withResource = (resource?: CanonicalAction["resource"]) =>
    resource === undefined ? {} : { resource };

  it("reads an absent resource as unknown, never as local", () => {
    expect(resolveEnvironment(withResource())).toBe("unknown");
  });

  it("returns the declared environment when nothing contradicts it", () => {
    expect(resolveEnvironment(withResource({ environment: "staging" }))).toBe(
      "staging",
    );
    expect(
      resolveEnvironment(
        withResource({ environment: "test", isProduction: false }),
      ),
    ).toBe("test");
  });

  // Adversarial: two sources for one fact. Whichever one an attacker or a
  // buggy adapter gets wrong, the dangerous reading wins.
  it.each([
    ["local", true],
    ["development", true],
    ["unknown", true],
    ["production", false],
    ["production", true],
  ] as const)(
    "resolves { environment: %s, isProduction: %s } to production",
    (environment, isProduction) => {
      expect(
        resolveEnvironment(withResource({ environment, isProduction })),
      ).toBe("production");
    },
  );

  it("accepts a contradictory pair at validation and does not repair it", () => {
    const input = withValue(full(), ["resource"], {
      environment: "local",
      isProduction: true,
    });
    const action = valueOf(parseCanonicalAction(input));
    expect(action.resource).toEqual({
      environment: "local",
      isProduction: true,
    });
    expect(resolveEnvironment(action)).toBe("production");
  });
});

/** ADR-011, contract v1.2 — canonical operands. */
describe("ADR-011 operands", () => {
  const base = {
    id: "act_01J8ZC2N6Q4T7V9X3B5D8F0H2K",
    agent: { host: "claude-code" },
    tool: { name: "Bash" },
    arguments: { command: "git status" },
    sideEffectClass: "unknown",
    createdAt: "2026-09-20T10:15:30Z",
  };
  const withOperands = (operands: unknown): unknown => ({ ...base, operands });

  it("accepts a command as text, as a vector, or as both", () => {
    for (const command of [
      { raw: "git status" },
      { argv: ["git", "status"] },
      { raw: "git status", argv: ["git", "status"] },
    ]) {
      expect(parseCanonicalAction(withOperands({ command })).ok).toBe(true);
    }
    expect(
      parseCanonicalAction(
        withOperands({
          paths: ["/work/project/a.ts"],
          networkHosts: ["example.test"],
        }),
      ).ok,
    ).toBe(true);
    // An action with no operands is as valid as it was in v1.1.
    expect(parseCanonicalAction(base).ok).toBe(true);
  });

  // Adversarial: operands are what policy is matched against, so nothing in
  // them may be tolerated, defaulted or repaired.
  it.each([
    ["a command that is neither text nor a vector", { command: {} }],
    ["an empty command", { command: { raw: "" } }],
    ["an empty vector", { command: { argv: [] } }],
    ["a vector that is not text", { command: { argv: ["git", 1] } }],
    ["a host-shaped key in the command", { command: { raw: "ls", cmd: "ls" } }],
    [
      "a key the contract does not know",
      { command: { raw: "ls" }, trusted: true },
    ],
    [
      "a classification smuggled in",
      { command: { raw: "ls" }, sideEffectClass: "none" },
    ],
    ["paths that are not text", { paths: [42] }],
    ["a path as an object", { paths: [{ path: "/x" }] }],
    ["too many paths", { paths: Array.from({ length: 1_025 }, () => "/x") }],
    [
      "a host with a control character",
      { networkHosts: [`a${String.fromCodePoint(10)}b`] },
    ],
    ["operands that are not an object", "rm -rf ~"],
  ])("rejects %s", (_label, operands) => {
    expect(parseCanonicalAction(withOperands(operands)).ok).toBe(false);
  });

  it("bounds a command and never echoes it in an issue", () => {
    const secret = "sk-live-5e8b1f0a9c3d";
    const result = parseCanonicalAction(
      withOperands({ command: { raw: `${secret}${"x".repeat(1_048_577)}` } }),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
