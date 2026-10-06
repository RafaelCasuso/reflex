import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { compilePolicySet, evaluatePolicy } from "./evaluator.js";
import { CONTEXT, policy, shell } from "./engine.test-support.js";
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_LIMITS,
  createPolicySnapshot,
  generateSnapshotKeys,
  parsePolicySnapshot,
  serializeSnapshot,
  verifyPolicySnapshot,
  type PolicySnapshot,
  type SnapshotSourceInput,
} from "./snapshot.js";

/**
 * RFX-083 — a signed snapshot is applied only when everything about it
 * verifies, and a lower source cannot weaken a mandate it carries.
 */
const ORGANIZATION = policy(`
version: 1
defaults:
  unresolved: ask
rules:
  - id: org-no-force-push
    name: Never force-push
    effect: deny
    mandatory: true
    conditions:
      - { field: command.name, operator: equals, value: git }
      - { field: command.args, operator: in, value: [--force, -f] }
  - id: org-reads
    name: Reads are fine
    effect: allow
    conditions:
      - { field: command.name, operator: in, value: [ls, cat] }
  - id: org-ask-rm
    name: Ask before rm
    effect: ask
    conditions:
      - { field: command.name, operator: equals, value: rm }
`);

const PRODUCTION = policy(`
version: 1
rules:
  - id: prod-no-rm
    name: No rm in production
    effect: deny
    conditions:
      - { field: command.name, operator: equals, value: rm }
`);

const SOURCES: readonly SnapshotSourceInput[] = [
  { source: "organization", policyId: "pol_team", document: ORGANIZATION },
  { source: "environment", environment: "production", document: PRODUCTION },
];

const keys = generateSnapshotKeys();
const other = generateSnapshotKeys();
const AT = new Date("2026-10-06T10:00:00.000Z");

function signed(
  overrides: Partial<Parameters<typeof createPolicySnapshot>[0]> = {},
): PolicySnapshot {
  const result = createPolicySnapshot({
    sources: SOURCES,
    version: "2026.10.06",
    publishedAt: AT,
    privateKey: keys.privateKeyPem,
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.snapshot;
}

describe("RFX-083 policy snapshots", () => {
  it("signs a team's documents into an envelope that round-trips through text", () => {
    const snapshot = signed();
    expect(snapshot.format).toBe(SNAPSHOT_FORMAT);
    expect(snapshot.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snapshot.signature.keyId).toBe(keys.keyId);
    const parsed = parsePolicySnapshot(serializeSnapshot(snapshot));
    expect(parsed).toEqual({ ok: true, snapshot });
  });

  it("verifies with the team's public key and yields trusted organization and environment sources", () => {
    const verified = verifyPolicySnapshot(signed(), keys.publicKeyPem);
    expect(verified.ok).toBe(true);
    if (!verified.ok) {
      return;
    }
    expect(verified.verified.version).toBe("2026.10.06");
    expect(verified.verified.keyId).toBe(keys.keyId);
    expect(verified.verified.sources.map((source) => source.source)).toEqual([
      "environment",
      "organization",
    ]);
    expect(verified.verified.sources.every((source) => source.trusted)).toBe(
      true,
    );
    const production = verified.verified.sources.find(
      (source) => source.source === "environment",
    );
    expect(production?.environment).toBe("production");
    const organization = verified.verified.sources.find(
      (source) => source.source === "organization",
    );
    expect(organization?.policyId).toBe("pol_team");
    expect(organization?.document.defaults).toEqual({ unresolved: "ask" });
  });

  it("is immutable: the same documents give the same hash, whatever the order or the time", () => {
    const a = signed();
    const b = signed({
      sources: [...SOURCES].reverse(),
      publishedAt: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(a.hash).toBe(b.hash);
    expect(a.policySet).toBe(b.policySet);
    expect(a.signature.value).not.toBe(b.signature.value);
  });

  it("compiles with the user's sources, and its hash is in the set's", () => {
    const verified = verifyPolicySnapshot(signed(), keys.publicKeyPem);
    if (!verified.ok) {
      throw new Error(verified.reason);
    }
    const compiled = compilePolicySet([
      ...verified.verified.sources,
      {
        source: "local",
        trusted: true,
        document: policy(`
version: 1
rules:
  - id: me-force
    name: I force-push
    effect: allow
    conditions:
      - { field: command.name, operator: equals, value: git }
`),
      },
    ]);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    // The snapshot's canonical sources are inside the set's canonical form.
    expect(compiled.set.canonical).toContain('"policyId":"pol_team"');
    expect(compiled.set.canonical).toContain('"environment":"production"');
  });

  describe("refuses, and says why", () => {
    const refuse = (snapshot: PolicySnapshot, key = keys.publicKeyPem) => {
      const result = verifyPolicySnapshot(snapshot, key);
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.reason;
    };

    it("a payload edited after signing", () => {
      const snapshot = signed();
      const tampered = {
        ...snapshot,
        policySet: snapshot.policySet.replace('"deny"', '"allow"'),
      };
      expect(refuse(tampered)).toContain("hash");
    });

    it("a payload edited with its hash recomputed", () => {
      const snapshot = signed();
      const edited = signed({
        sources: [
          {
            source: "organization",
            document: policy("version: 1\nrules: []\n"),
          },
        ],
      });
      const tampered = {
        ...snapshot,
        policySet: edited.policySet,
        hash: edited.hash,
      };
      expect(refuse(tampered)).toContain("signature");
    });

    it("a version or a publication time changed after signing", () => {
      const snapshot = signed();
      expect(refuse({ ...snapshot, version: "2026.10.07" })).toContain(
        "signature",
      );
      expect(
        refuse({ ...snapshot, publishedAt: "2026-10-07T00:00:00.000Z" }),
      ).toContain("signature");
    });

    it("a signature by another key, and a key that is not a key", () => {
      expect(refuse(signed(), other.publicKeyPem)).toContain("signature");
      expect(refuse(signed(), "not a key")).toContain("does not parse");
      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
      expect(
        refuse(
          signed(),
          rsa.publicKey.export({ type: "spki", format: "pem" }).toString(),
        ),
      ).toContain("Ed25519");
    });

    it("a payload that is signed but not canonical", () => {
      // Re-sign a payload with whitespace in it: same meaning, another text.
      const snapshot = signed();
      const spaced = JSON.stringify(
        JSON.parse(snapshot.policySet) as unknown,
        null,
        1,
      );
      const resigned = createPolicySnapshot({
        sources: SOURCES,
        version: "v",
        publishedAt: AT,
        privateKey: keys.privateKeyPem,
      });
      if (!resigned.ok) {
        throw new Error(resigned.reason);
      }
      // Forge the envelope around the spaced payload with a true hash and
      // signature, as a publisher with the key but without this code could.
      const hash = `sha256:${createHash("sha256").update(spaced, "utf8").digest("hex")}`;
      const statement = Buffer.from(
        `reflex-policy-snapshot\n1\nv\n${AT.toISOString()}\n${hash}\n`,
        "utf8",
      );
      const forged: PolicySnapshot = {
        ...resigned.snapshot,
        policySet: spaced,
        hash,
        signature: {
          ...resigned.snapshot.signature,
          value: sign(null, statement, keys.privateKeyPem).toString("base64"),
        },
      };
      expect(refuse(forged)).toContain("canonical");
    });

    it("a source a snapshot may not carry", () => {
      for (const source of ["local", "project", "built-in"] as const) {
        const result = createPolicySnapshot({
          sources: [
            { source: source as "organization", document: ORGANIZATION },
          ],
          version: "v",
          publishedAt: AT,
          privateKey: keys.privateKeyPem,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toContain(source);
        }
      }
    });

    it("an environment source without its environment, an unknown one, or an organization that names one", () => {
      for (const sources of [
        [{ source: "environment", document: PRODUCTION }],
        [
          {
            source: "environment",
            environment: "unknown",
            document: PRODUCTION,
          },
        ],
        [
          {
            source: "organization",
            environment: "production",
            document: ORGANIZATION,
          },
        ],
      ] as const) {
        const result = createPolicySnapshot({
          sources,
          version: "v",
          publishedAt: AT,
          privateKey: keys.privateKeyPem,
        });
        expect(result.ok).toBe(false);
      }
    });

    it("an envelope that is not one", () => {
      for (const text of [
        "",
        "null",
        "[]",
        "{}",
        '{"format":2}',
        `{"format":1,"version":"../x","publishedAt":"2026-10-06T00:00:00Z","policySet":"{}","hash":"sha256:${"0".repeat(64)}","signature":{"algorithm":"ed25519","keyId":"k","value":"v"}}`,
        `{"format":1,"version":"v","publishedAt":"yesterday","policySet":"{}","hash":"sha256:${"0".repeat(64)}","signature":{"algorithm":"ed25519","keyId":"k","value":"v"}}`,
        `{"format":1,"version":"v","publishedAt":"2026-10-06T00:00:00Z","policySet":"{}","hash":"md5:0","signature":{"algorithm":"ed25519","keyId":"k","value":"v"}}`,
        `{"format":1,"version":"v","publishedAt":"2026-10-06T00:00:00Z","policySet":"{}","hash":"sha256:${"0".repeat(64)}","signature":{"algorithm":"rsa","keyId":"k","value":"v"}}`,
      ]) {
        expect(parsePolicySnapshot(text).ok, text).toBe(false);
      }
      expect(
        parsePolicySnapshot("x".repeat(SNAPSHOT_LIMITS.bytes + 1)).ok,
      ).toBe(false);
    });

    it("a signed payload whose rules the policy parser would refuse", () => {
      const payload = JSON.stringify({
        format: 1,
        sources: [
          {
            source: "organization",
            trusted: true,
            policyId: null,
            unresolved: null,
            rules: [
              {
                id: "bad",
                name: "mandatory allow",
                effect: "allow",
                mandatory: true,
                conditions: [{ field: "tool.name", operator: "exists" }],
              },
            ],
          },
        ],
      });
      const hash = `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
      const statement = Buffer.from(
        `reflex-policy-snapshot\n1\nv\n${AT.toISOString()}\n${hash}\n`,
        "utf8",
      );
      const forged: PolicySnapshot = {
        format: 1,
        version: "v",
        publishedAt: AT.toISOString(),
        policySet: payload,
        hash,
        signature: {
          algorithm: "ed25519",
          keyId: keys.keyId,
          value: sign(null, statement, keys.privateKeyPem).toString("base64"),
        },
      };
      expect(refuse(forged)).toContain("mandatory");
    });

    it("a payload whose source claims to be untrusted, or is a project", () => {
      const snapshot = signed();
      const edits: readonly (readonly [string, string])[] = [
        ['"trusted":true', '"trusted":false'],
        ['"source":"organization"', '"source":"project"'],
      ];
      for (const [from, to] of edits) {
        expect(snapshot.policySet).toContain(from);
        const tampered = {
          ...snapshot,
          policySet: snapshot.policySet.replace(from, to),
        };
        // The hash catches it first; a forger with the key is the next test.
        expect(refuse(tampered)).toContain("hash");
      }
    });
  });
});

describe("RFX-083 a subscribed set and the precedence of ADR-004", () => {
  const verified = verifyPolicySnapshot(signed(), keys.publicKeyPem);
  if (!verified.ok) {
    throw new Error(verified.reason);
  }
  const LOCAL_ALLOWS_EVERYTHING = {
    source: "local" as const,
    trusted: true,
    document: policy(`
version: 1
rules:
  - id: me-git
    name: git is mine
    effect: allow
    conditions:
      - { field: command.name, operator: equals, value: git }
  - id: me-rm
    name: rm is mine
    effect: allow
    conditions:
      - { field: command.name, operator: equals, value: rm }
`),
  };
  const PROJECT_ALLOWS_RM = {
    source: "project" as const,
    trusted: true,
    document: policy(`
version: 1
rules:
  - id: proj-rm
    name: rm is fine here
    effect: allow
    conditions:
      - { field: command.name, operator: equals, value: rm }
`),
  };
  const compiled = compilePolicySet([
    ...verified.verified.sources,
    PROJECT_ALLOWS_RM,
    LOCAL_ALLOWS_EVERYTHING,
  ]);
  if (!compiled.ok) {
    throw new Error(compiled.problems.join("; "));
  }
  const effectOf = (
    command: string,
    environment?: "production" | "development",
  ) => {
    const action = shell(command);
    return evaluatePolicy(
      compiled.set,
      environment === undefined
        ? action
        : { ...action, resource: { environment } },
      CONTEXT,
    ).evaluation.effect;
  };

  it("a local allow cannot weaken the snapshot's mandatory deny", () => {
    expect(effectOf("git push --force")).toBe("deny");
  });

  it("a local allow does override the snapshot's non-mandatory ask (ADR-004 §3)", () => {
    expect(effectOf("rm -rf build")).toBe("allow");
  });

  it("the production source denies in production and is silent elsewhere (ADR-018)", () => {
    expect(effectOf("rm -rf build", "production")).toBe("deny");
    expect(effectOf("rm -rf build", "development")).toBe("allow");
  });

  it("every decision under the snapshot carries its sources in the set's hash", () => {
    const without = compilePolicySet([
      PROJECT_ALLOWS_RM,
      LOCAL_ALLOWS_EVERYTHING,
    ]);
    expect(without.ok && without.set.hash !== compiled.set.hash).toBe(true);
  });
});
