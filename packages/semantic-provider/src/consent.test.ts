import { describe, expect, it } from "vitest";

import {
  consentCovers,
  consentDigest,
  consentRecord,
  consentStatement,
  isRemoteProvider,
  parseConsentRecord,
} from "./consent.js";

/** RFX-123 — a consent covers one provider and one statement, exactly. */
describe("consent", () => {
  it("names the remote providers, and only them", () => {
    expect(isRemoteProvider("jev")).toBe(true);
    expect(isRemoteProvider("reflex")).toBe(true);
    expect(isRemoteProvider("local")).toBe(false);
    expect(isRemoteProvider("fake")).toBe(false);
    expect(isRemoteProvider("none")).toBe(false);
  });

  it("states what is sent, what is redacted first and where it goes", () => {
    const statement = consentStatement("jev");
    expect(statement).toContain("What is sent");
    expect(statement).toContain("after redaction");
    expect(statement).toContain("What is redacted first, on this machine");
    expect(statement).toContain("api.typesafe.ai");
    expect(statement).toContain(
      "Declining keeps REFLEX working with policy alone",
    );
    expect(statement).toContain("never its path on disk");
    expect(consentStatement("reflex")).toContain("hosted REFLEX gateway");
  });

  it("covers the provider and the statement it was given for, and nothing else", () => {
    const granted = consentRecord("jev", new Date("2026-09-27T10:00:00.000Z"));
    expect(granted.statementDigest).toBe(consentDigest("jev"));
    expect(consentCovers(granted, "jev")).toBe(true);
    expect(consentCovers(granted, "reflex")).toBe(false);
    expect(consentCovers(undefined, "jev")).toBe(false);
    // An earlier statement: the digest differs, the question is asked again.
    expect(
      consentCovers(
        { ...granted, statementDigest: `sha256:${"0".repeat(64)}` },
        "jev",
      ),
    ).toBe(false);
  });

  it("round-trips through a file and reads anything else as no consent", () => {
    const granted = consentRecord("jev", new Date("2026-09-27T10:00:00.000Z"));
    expect(parseConsentRecord(JSON.stringify(granted))).toEqual(granted);
    for (const text of [
      undefined,
      "",
      "{}",
      "not json",
      JSON.stringify({ ...granted, version: 2 }),
      JSON.stringify({ ...granted, statementDigest: "yes" }),
    ]) {
      expect(parseConsentRecord(text)).toBeUndefined();
    }
  });
});
