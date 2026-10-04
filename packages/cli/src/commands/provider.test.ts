import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { consentDigest } from "@reflex-control/semantic-provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nodeFileSystem } from "../backups/file-system.js";
import type { Environment } from "../state.js";
import { changeProvider, describeProvider, readProvider } from "./provider.js";

/** RFX-123 — `rfx provider`: nothing is written for a remote provider without a yes. */
let root: string;
let env: Environment;
const NOW = new Date("2026-09-27T10:00:00.000Z");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-provider-"));
  env = {
    homeDir: join(root, "home"),
    projectDir: join(root, "project"),
    reflexHomeOverride: join(root, "reflex-home"),
    platform: "linux",
    nodePath: "/usr/local/bin/node",
    entryPath: "/opt/reflex/dist/bin.js",
    now: () => NOW,
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("rfx provider", () => {
  it("starts with none, and says so", async () => {
    const report = await readProvider(env, nodeFileSystem);
    expect(report).toEqual({
      config: { version: 1, semanticProvider: "none" },
      consent: undefined,
      withheld: [],
    });
    expect(describeProvider(report)).toContain("nothing leaves this machine");
  });

  it("refuses a remote provider without a yes, and writes nothing", async () => {
    const result = await changeProvider(env, nodeFileSystem, {
      provider: "jev",
      consented: false,
    });
    expect(result).toEqual({ ok: false, reason: "consent-required" });
    expect(await exists(join(root, "reflex-home", "config.json"))).toBe(false);
    expect(await exists(join(root, "reflex-home", "consent.json"))).toBe(false);
  });

  it("records the consent with the statement's digest, then the provider, user-only", async () => {
    const result = await changeProvider(env, nodeFileSystem, {
      provider: "jev",
      model: "jev-1.13.0",
      consented: true,
    });
    expect(result.ok && result.changed).toBe(true);
    const home = join(root, "reflex-home");
    const consent = JSON.parse(
      await readFile(join(home, "consent.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(consent).toEqual({
      version: 1,
      provider: "jev",
      grantedAt: NOW.toISOString(),
      statementDigest: consentDigest("jev"),
    });
    expect((await stat(join(home, "consent.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "config.json"))).mode & 0o777).toBe(0o600);
    const report = await readProvider(env, nodeFileSystem);
    expect(report.withheld).toEqual([]);
    expect(describeProvider(report)).toBe(
      "jev, model jev-1.13.0, consent given 2026-09-27",
    );
  });

  it("withdraws the consent when the provider goes back to none", async () => {
    await changeProvider(env, nodeFileSystem, {
      provider: "jev",
      consented: true,
    });
    const result = await changeProvider(env, nodeFileSystem, {
      provider: "none",
      consented: false,
    });
    expect(result.ok && result.changed).toBe(true);
    expect(await exists(join(root, "reflex-home", "consent.json"))).toBe(false);
    expect((await readProvider(env, nodeFileSystem)).config).toEqual({
      version: 1,
      semanticProvider: "none",
    });
  });

  it("pins the local provider to its checkpoint and needs no consent", async () => {
    expect(
      await changeProvider(env, nodeFileSystem, {
        provider: "local",
        consented: false,
      }),
    ).toEqual({ ok: false, reason: "model-required" });
    const result = await changeProvider(env, nodeFileSystem, {
      provider: "local",
      model: "rdm-0.1.0",
      endpoint: "http://127.0.0.1:8123/v1/assess",
      consented: false,
    });
    expect(result.ok).toBe(true);
    expect((await readProvider(env, nodeFileSystem)).config).toEqual({
      version: 1,
      semanticProvider: "local",
      semanticModel: "rdm-0.1.0",
      semanticEndpoint: "http://127.0.0.1:8123/v1/assess",
    });
    expect(await exists(join(root, "reflex-home", "consent.json"))).toBe(false);
  });

  // Adversarial: the configuration names jev but nobody agreed (written by
  // hand, or by the agent through a tool). Status says so, and the daemon
  // is started with policy alone (config.test.ts, lifecycle).
  it("reports a remote provider configured without consent as withheld", async () => {
    await nodeFileSystem.write(
      join(root, "reflex-home", "config.json"),
      Buffer.from(JSON.stringify({ version: 1, semanticProvider: "jev" })),
      0o600,
    );
    const report = await readProvider(env, nodeFileSystem);
    expect(report.withheld).toEqual(["jev"]);
    expect(describeProvider(report)).toContain("configured without consent");
    expect(describeProvider(report)).toContain("nothing leaves this machine");
  });

  it("reports nothing changed when the same provider is chosen again", async () => {
    await changeProvider(env, nodeFileSystem, {
      provider: "jev",
      consented: true,
    });
    const again = await changeProvider(env, nodeFileSystem, {
      provider: "jev",
      consented: true,
    });
    expect(again.ok && !again.changed).toBe(true);
  });
});
