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

  it("registers jev, local and fake in this build, and not reflex yet", () => {
    expect(gatewayProviderRegistry().available).toEqual([
      "jev",
      "local",
      "fake",
    ]);
    const built = build("reflex");
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.reason).toContain('"reflex" is not available');
    }
  });

  it("builds local on the loopback with a pinned checkpoint, and refuses it without one or elsewhere", () => {
    const built = build("local", { model: "laya-1.0.0" });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.provider).toEqual({
        id: "local",
        name: "local",
        model: "laya-1.0.0",
      });
      expect(built.stage?.provider.onMachine).toBe(true);
    }
    const unpinned = build("local");
    expect(unpinned.ok).toBe(false);
    if (!unpinned.ok) {
      expect(unpinned.reason).toContain("needs --semantic-model");
    }
    const alias = build("local", { model: "rdm-latest" });
    expect(alias.ok).toBe(false);
    const elsewhere = build("local", {
      model: "laya-1.0.0",
      endpoint: "http://10.0.0.5:8765/v1/assess",
    });
    expect(elsewhere.ok).toBe(false);
    if (!elsewhere.ok) {
      expect(elsewhere.reason).toContain("this machine only");
    }
  });

  it("lets a local shadow be sampled on everything, and only it", () => {
    const local = buildSemanticStage({
      id: "fake",
      model: undefined,
      endpoint: undefined,
      redactionKey: KEY,
      env: {},
      shadows: [{ id: "local", model: "rdm-0.1.0" }],
      shadowSample: "all",
    });
    expect(local.ok).toBe(true);
    if (local.ok) {
      expect(local.shadows).toEqual([
        { id: "local", name: "local", model: "rdm-0.1.0", sample: "all" },
      ]);
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
    const unpinned = shadowed({ shadows: [{ id: "local" }] });
    expect(unpinned.ok).toBe(false);
    if (!unpinned.ok) {
      expect(unpinned.reason).toMatch(/^shadow the local provider needs/);
    }
    const absent = shadowed({ shadows: [{ id: "reflex" }] });
    expect(absent.ok).toBe(false);
    if (!absent.ok) {
      expect(absent.reason).toContain('"reflex" is not available');
    }
  });
});
