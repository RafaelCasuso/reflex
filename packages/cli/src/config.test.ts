import { consentRecord } from "@reflex-control/semantic-provider";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  daemonArguments,
  parseConfig,
  withConsent,
  type UserConfig,
} from "./config.js";

/**
 * RFX-138 — the user's daemon configuration; RFX-123 — a remote provider
 * in it is passed to the daemon only with the consent that covers it.
 */
const NOW = new Date("2026-09-27T10:00:00.000Z");
const JEV: UserConfig = { version: 1, semanticProvider: "jev" };

describe("the user's configuration", () => {
  it("reads a configuration and treats anything else as none", () => {
    expect(parseConfig(JSON.stringify(JEV))).toEqual(JEV);
    for (const text of [
      undefined,
      "",
      "nope",
      "{}",
      '{"version":2,"semanticProvider":"jev"}',
      '{"version":1,"semanticProvider":"other"}',
    ]) {
      expect(parseConfig(text)).toEqual(DEFAULT_CONFIG);
    }
  });

  it("turns a configuration into the daemon's flags, and none into nothing", () => {
    expect(daemonArguments(DEFAULT_CONFIG)).toEqual([]);
    expect(
      daemonArguments(
        {
          version: 1,
          semanticProvider: "local",
          semanticModel: "rdm-0.1.0",
          semanticEndpoint: "http://127.0.0.1:8123/v1/assess",
          shadowProviders: ["fake"],
          shadowSample: "all",
          shadowDeadlineMs: 250,
        },
        "/home/consent.json",
      ),
    ).toEqual([
      "--semantic-provider",
      "local",
      "--semantic-model",
      "rdm-0.1.0",
      "--semantic-endpoint",
      "http://127.0.0.1:8123/v1/assess",
      "--shadow-provider",
      "fake",
      "--shadow-sample",
      "all",
      "--shadow-deadline",
      "250",
      "--remote-consent",
      "/home/consent.json",
    ]);
  });
});

describe("RFX-123 consent before a remote provider is passed to the daemon", () => {
  it("passes a remote primary with the consent that covers it", () => {
    expect(withConsent(JEV, consentRecord("jev", NOW))).toEqual({
      config: JEV,
      withheld: [],
    });
  });

  // Adversarial: config.json edited by hand (or by the agent) to name a
  // remote provider. Without consent it is withheld, and nothing leaves.
  it("withholds a remote primary without consent, and everything behind it", () => {
    const edited: UserConfig = {
      ...JEV,
      shadowProviders: ["local", "jev"],
      semanticModel: "jev-1.13.0",
    };
    expect(withConsent(edited, undefined)).toEqual({
      config: DEFAULT_CONFIG,
      withheld: ["jev", "jev"],
    });
    expect(daemonArguments(withConsent(edited, undefined).config)).toEqual([]);
  });

  it("does not let a consent to another provider, or to an earlier statement, count", () => {
    expect(withConsent(JEV, consentRecord("reflex", NOW)).withheld).toEqual([
      "jev",
    ]);
    const stale = {
      ...consentRecord("jev", NOW),
      statementDigest: `sha256:${"f".repeat(64)}`,
    };
    expect(withConsent(JEV, stale).withheld).toEqual(["jev"]);
  });

  it("leaves a remote shadow out and keeps the local primary and shadows", () => {
    const config: UserConfig = {
      version: 1,
      semanticProvider: "local",
      semanticModel: "rdm-0.1.0",
      shadowProviders: ["fake", "jev"],
    };
    expect(withConsent(config, undefined)).toEqual({
      config: {
        version: 1,
        semanticProvider: "local",
        semanticModel: "rdm-0.1.0",
        shadowProviders: ["fake"],
      },
      withheld: ["jev"],
    });
    const onlyRemoteShadow: UserConfig = {
      ...config,
      shadowProviders: ["jev"],
    };
    expect(withConsent(onlyRemoteShadow, undefined).config).toEqual({
      version: 1,
      semanticProvider: "local",
      semanticModel: "rdm-0.1.0",
    });
  });

  it("needs no consent for what runs on this machine", () => {
    for (const id of ["none", "local", "fake"] as const) {
      const config: UserConfig = { version: 1, semanticProvider: id };
      expect(withConsent(config, undefined)).toEqual({ config, withheld: [] });
    }
  });
});
