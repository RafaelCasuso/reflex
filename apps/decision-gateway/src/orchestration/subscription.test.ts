import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPolicySnapshot,
  generateSnapshotKeys,
  parsePolicy,
  serializeSnapshot,
} from "@reflex-control/policy-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classifyLocation,
  createSubscriptionHolder,
  parseSubscriptionRecord,
  serializeSubscription,
  snapshotCachePath,
  subscriptionPath,
  type FetchOutcome,
} from "./subscription.js";

/**
 * RFX-083 — the daemon fetches, verifies, applies, keeps the last good
 * snapshot, and refuses what does not verify (ADR-003 §3, ADR-018).
 */
const ORGANIZATION = `
version: 1
rules:
  - id: org-no-force
    name: Never force-push
    effect: deny
    mandatory: true
    conditions:
      - { field: command.name, operator: equals, value: git }
      - { field: command.args, operator: in, value: [--force, -f] }
`;

const keys = generateSnapshotKeys();
const otherKeys = generateSnapshotKeys();

function snapshotText(
  version: string,
  yaml = ORGANIZATION,
  privateKey = keys.privateKeyPem,
): string {
  const parsed = parsePolicy(yaml);
  if (!parsed.ok) {
    throw new Error("fixture does not parse");
  }
  const created = createPolicySnapshot({
    sources: [{ source: "organization", document: parsed.document }],
    version,
    publishedAt: new Date("2026-10-06T10:00:00.000Z"),
    privateKey,
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  return serializeSnapshot(created.snapshot);
}

let root: string;
let home: string;
let published: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-subscription-"));
  home = join(root, "home");
  await mkdir(home, { recursive: true });
  published = join(root, "team", "policy.json");
  await mkdir(join(root, "team"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function subscribe(
  location = published,
  publicKeyPem = keys.publicKeyPem,
): Promise<void> {
  await writeFile(
    subscriptionPath(home),
    serializeSubscription({
      version: 1,
      location,
      publicKeyPem,
      subscribedAt: "2026-10-06T09:00:00.000Z",
    }),
  );
}

describe("the subscription record", () => {
  it("round-trips, and anything else is no subscription", () => {
    const record = {
      version: 1 as const,
      location: "https://policies.example.com/reflex.json",
      publicKeyPem: keys.publicKeyPem,
      subscribedAt: "2026-10-06T09:00:00.000Z",
    };
    expect(parseSubscriptionRecord(serializeSubscription(record))).toEqual(
      record,
    );
    expect(parseSubscriptionRecord(undefined)).toBeUndefined();
    expect(parseSubscriptionRecord("{")).toBeUndefined();
    expect(parseSubscriptionRecord('{"version":2}')).toBeUndefined();
    expect(
      parseSubscriptionRecord(
        '{"version":1,"location":"","publicKeyPem":"x","subscribedAt":"y"}',
      ),
    ).toBeUndefined();
  });

  it("accepts an absolute path, a file: URL and an https: URL, and nothing else", () => {
    expect(classifyLocation("/srv/policy.json")).toEqual({
      kind: "file",
      target: "/srv/policy.json",
    });
    expect(classifyLocation("file:///srv/policy.json")).toEqual({
      kind: "file",
      target: "/srv/policy.json",
    });
    expect(
      classifyLocation("https://policies.example.com/reflex.json")?.kind,
    ).toBe("https");
    for (const bad of [
      "http://policies.example.com/reflex.json",
      "ftp://x/y",
      "policy.json",
      "",
      "https://",
    ]) {
      expect(classifyLocation(bad), bad).toBeUndefined();
    }
  });
});

describe("the subscription holder", () => {
  it("has nothing in force without a subscription", async () => {
    const holder = await createSubscriptionHolder({ home });
    expect(await holder.refresh()).toEqual({ kind: "unsubscribed" });
    expect(holder.sources()).toEqual([]);
    expect(holder.state()).toEqual({ subscribed: false });
  });

  it("fetches, verifies and applies a snapshot, and caches it for the next start", async () => {
    await subscribe();
    await writeFile(published, snapshotText("2026.10.06"));
    const holder = await createSubscriptionHolder({
      home,
      clock: () => new Date("2026-10-06T11:00:00.000Z"),
    });
    const outcome = await holder.refresh();
    expect(outcome.kind).toBe("applied");
    expect(holder.sources()).toHaveLength(1);
    expect(holder.sources()[0]).toMatchObject({
      source: "organization",
      trusted: true,
    });
    expect(holder.state()).toMatchObject({
      subscribed: true,
      location: published,
      keyId: keys.keyId,
      current: {
        version: "2026.10.06",
        keyId: keys.keyId,
        fetchedAt: "2026-10-06T11:00:00.000Z",
      },
      lastAttemptAt: "2026-10-06T11:00:00.000Z",
    });
    expect(holder.state().lastError).toBeUndefined();
    const cached = JSON.parse(
      await readFile(snapshotCachePath(home), "utf8"),
    ) as { text: string };
    expect(cached.text).toBe(await readFile(published, "utf8"));

    // A daemon that starts offline starts with the last good snapshot.
    await rm(published);
    const restarted = await createSubscriptionHolder({ home });
    expect(restarted.state().current?.version).toBe("2026.10.06");
    expect(restarted.sources()).toHaveLength(1);
    const offline = await restarted.refresh();
    expect(offline.kind).toBe("refused");
    expect(restarted.state().current?.version).toBe("2026.10.06");
    expect(restarted.state().lastError).toContain("cannot read");
  });

  it("keeps the last good snapshot when the new one does not verify, and says so", async () => {
    await subscribe();
    await writeFile(published, snapshotText("v1"));
    const holder = await createSubscriptionHolder({ home });
    await holder.refresh();

    for (const [label, text] of [
      [
        "signed by another key",
        snapshotText("v2", ORGANIZATION, otherKeys.privateKeyPem),
      ],
      ["tampered after signing", snapshotText("v2").replace("deny", "allow")],
      ["not a snapshot", "{}"],
      ["not JSON", "<html>"],
    ] as const) {
      await writeFile(published, text);
      const outcome = await holder.refresh();
      expect(outcome.kind, label).toBe("refused");
      expect(holder.state().current?.version, label).toBe("v1");
      expect(holder.state().lastError, label).toBeDefined();
      expect(holder.sources(), label).toHaveLength(1);
    }

    // A good one again clears the error.
    await writeFile(published, snapshotText("v3"));
    expect((await holder.refresh()).kind).toBe("applied");
    expect(holder.state().current?.version).toBe("v3");
    expect(holder.state().lastError).toBeUndefined();
  });

  it("reports an unchanged snapshot as unchanged, with the fetch time moved", async () => {
    await subscribe();
    await writeFile(published, snapshotText("v1"));
    let now = new Date("2026-10-06T11:00:00.000Z");
    const holder = await createSubscriptionHolder({ home, clock: () => now });
    await holder.refresh();
    now = new Date("2026-10-06T11:05:00.000Z");
    expect(await holder.refresh()).toEqual({ kind: "unchanged" });
    expect(holder.state().current?.fetchedAt).toBe("2026-10-06T11:05:00.000Z");
  });

  it("drops a cached snapshot that the newly subscribed key does not vouch for", async () => {
    await subscribe();
    await writeFile(published, snapshotText("v1"));
    const first = await createSubscriptionHolder({ home });
    await first.refresh();
    await subscribe(published, otherKeys.publicKeyPem);
    const second = await createSubscriptionHolder({ home });
    expect(second.state().current).toBeUndefined();
    expect(second.sources()).toEqual([]);
    const outcome = await second.refresh();
    expect(outcome.kind).toBe("refused");
    expect(second.sources()).toEqual([]);
  });

  it("lets go of the snapshot when the subscription is removed", async () => {
    await subscribe();
    await writeFile(published, snapshotText("v1"));
    const holder = await createSubscriptionHolder({ home });
    await holder.refresh();
    await rm(subscriptionPath(home));
    expect(await holder.refresh()).toEqual({ kind: "unsubscribed" });
    expect(holder.sources()).toEqual([]);
    expect(holder.state().subscribed).toBe(false);
  });

  it("names a record it cannot use", async () => {
    await writeFile(subscriptionPath(home), "{");
    const holder = await createSubscriptionHolder({ home });
    expect(await holder.refresh()).toEqual({ kind: "unsubscribed" });
    expect(holder.state().problem).toContain("subscribe again");
    await subscribe("ftp://nope/policy.json");
    expect((await holder.refresh()).kind).toBe("unsubscribed");
    expect(holder.state().problem).toContain("https: URL");
    await subscribe(published, "not a key");
    expect((await holder.refresh()).kind).toBe("unsubscribed");
    expect(holder.state().problem).toContain("public key");
  });

  it("fetches over HTTPS with the last ETag and treats 304 as unchanged", async () => {
    await subscribe("https://policies.example.com/reflex.json");
    const text = snapshotText("v1");
    const calls: (string | undefined)[] = [];
    const fetcher = (
      _location: unknown,
      etag: string | undefined,
    ): Promise<FetchOutcome> => {
      calls.push(etag);
      return Promise.resolve(
        etag === '"abc"'
          ? { kind: "unchanged" }
          : { kind: "fetched", text, etag: '"abc"' },
      );
    };
    const holder = await createSubscriptionHolder({ home, fetcher });
    expect((await holder.refresh()).kind).toBe("applied");
    expect((await holder.refresh()).kind).toBe("unchanged");
    expect(calls).toEqual([undefined, '"abc"']);
  });
});
