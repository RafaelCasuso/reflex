import { createProviderRegistry } from "@reflex/semantic-provider";
import { describe, expect, it } from "vitest";

import {
  JEV_API_KEY_VARIABLE,
  SEMANTIC_MAX_INPUT_TOKENS,
  buildSemanticStage,
  gatewayProviderRegistry,
} from "./semantic-stage.js";

/**
 * RFX-141 — the stage the daemon builds from `--semantic-provider`, and
 * what it says about it. Adversarial: the key given to the provider must
 * not come back in a reason or a description.
 */
const KEY = new Uint8Array(32).fill(3);
// Assembled at run time so that no secret-shaped literal exists in the repository.
const SECRET = ["canary", "jev", "key", "4d5e6f70"].join("-");

const build = (
  id: "none" | "jev" | "local" | "reflex" | "fake",
  overrides: {
    model?: string;
    endpoint?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) =>
  buildSemanticStage({
    id,
    model: overrides.model,
    endpoint: overrides.endpoint,
    redactionKey: KEY,
    env: overrides.env ?? {},
  });

describe("RFX-141 the daemon's semantic stage", () => {
  it("builds no stage for none, which is the default and today's behavior", () => {
    expect(build("none")).toEqual({
      ok: true,
      stage: undefined,
      provider: { id: "none" },
      shadows: [],
    });
  });

  it("builds the fake for development, and names it with its pinned model", () => {
    const built = build("fake");
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.stage?.provider.providerName).toBe("fake");
      expect(built.stage?.maxInputTokens).toBe(SEMANTIC_MAX_INPUT_TOKENS);
      expect(built.provider).toEqual({
        id: "fake",
        name: "fake",
        model: "fake-1",
      });
    }
  });

  it("registers jev and fake in this build, and nothing else yet", () => {
    expect(gatewayProviderRegistry().available).toEqual(["jev", "fake"]);
    for (const id of ["local", "reflex"] as const) {
      const built = build(id);
      expect(built.ok).toBe(false);
      if (!built.ok) {
        expect(built.reason).toContain(`"${id}" is not available`);
      }
    }
  });

  it("refuses jev without a key, naming the variable and never a value", () => {
    const built = build("jev", { env: {} });
    expect(built).toEqual({
      ok: false,
      reason: `the jev provider needs an API key in ${JEV_API_KEY_VARIABLE}`,
    });
    const empty = build("jev", { env: { [JEV_API_KEY_VARIABLE]: "" } });
    expect(empty.ok).toBe(false);
  });

  it("builds jev from the environment, pinned, and describes it without the key or the endpoint", () => {
    const built = build("jev", {
      env: { [JEV_API_KEY_VARIABLE]: SECRET },
      endpoint: "https://api.example.test/v1/systemone",
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.provider).toEqual({
        id: "jev",
        name: "jev",
        model: "jev-1.13.0",
      });
      expect(JSON.stringify(built.provider)).not.toContain(SECRET);
      expect(JSON.stringify(built.provider)).not.toContain("example.test");
      expect(built.stage?.provider.model).toBe("jev-1.13.0");
    }
    const pinned = build("jev", {
      env: { [JEV_API_KEY_VARIABLE]: SECRET },
      model: "jev-1.12.0",
    });
    expect(
      pinned.ok && pinned.provider.id === "jev" && pinned.provider.model,
    ).toBe("jev-1.12.0");
  });

  it("refuses an alias for the model, and says so without the key", () => {
    for (const model of ["jev-latest", "jev-preview"]) {
      const built = build("jev", {
        env: { [JEV_API_KEY_VARIABLE]: SECRET },
        model,
      });
      expect(built.ok).toBe(false);
      if (!built.ok) {
        expect(built.reason).toContain("never an alias");
        expect(built.reason).not.toContain(SECRET);
      }
    }
  });

  it("takes another registry, so that a test or a future build can bring its own providers", () => {
    const registry = createProviderRegistry({});
    const built = buildSemanticStage({
      id: "fake",
      model: undefined,
      endpoint: undefined,
      redactionKey: KEY,
      env: {},
      registry,
    });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.reason).toContain("available: none");
    }
  });

  it("gives the stage a compiler that redacts with the installation's key", () => {
    const built = build("fake");
    expect(built.ok).toBe(true);
    if (built.ok && built.stage !== undefined) {
      const request = built.stage.compiler.compile(
        {
          id: "act_00000000000000000000000000000001",
          agent: { host: "claude-code" },
          tool: { name: "Bash" },
          arguments: { command: `curl -H 'Authorization: Bearer ${SECRET}'` },
          sideEffectClass: "external-read",
          createdAt: "2026-09-25T10:00:00.000Z",
        },
        { maxInputTokens: 600, deadlineMs: 500 },
      );
      expect(JSON.stringify(request)).not.toContain(SECRET);
    }
  });
});

describe("RFX-142 the daemon's shadows", () => {
  const shadowed = (
    overrides: Partial<Parameters<typeof buildSemanticStage>[0]> = {},
  ) =>
    buildSemanticStage({
      id: "fake",
      model: undefined,
      endpoint: undefined,
      redactionKey: KEY,
      env: {},
      shadows: [{ id: "fake" }],
      shadowDeadlineMs: 250,
      ...overrides,
    });

  it("builds a shadow behind the primary, with its own deadline, and describes it", () => {
    const built = shadowed();
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.stage?.shadow).toHaveLength(1);
      expect(built.stage?.shadow?.[0]).toMatchObject({
        deadlineMs: 250,
        sample: "unresolved",
      });
      expect(built.shadows).toEqual([
        { id: "fake", name: "fake", model: "fake-1", sample: "unresolved" },
      ]);
      expect(built.stage?.shadow?.[0]?.provider).not.toBe(
        built.stage?.provider,
      );
    }
  });

  it("refuses a shadow without a primary", () => {
    const built = shadowed({ id: "none" });
    expect(built).toEqual({
      ok: false,
      reason: "a shadow provider needs a primary one",
    });
  });

  it("refuses to sample everything with a shadow that is not local, before building anything", () => {
    const built = shadowed({ shadowSample: "all" });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.reason).toContain("only local may");
    }
  });

  it("refuses a shadow that cannot be built, and says which", () => {
    const built = shadowed({ shadows: [{ id: "jev" }], env: {} });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.reason).toMatch(/^shadow the jev provider needs an API key/);
    }
    const absent = shadowed({ shadows: [{ id: "local" }] });
    expect(absent.ok).toBe(false);
    if (!absent.ok) {
      expect(absent.reason).toContain('"local" is not available');
    }
  });
});
