import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REDACTION_KEY_BYTES,
  createRedactor,
} from "@reflex-control/context-compiler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readOrCreateRedactionKey, redactionKeyPath } from "./redaction-key.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "reflex-key-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("RFX-031 the redaction key", () => {
  it("creates a key of the right size, readable by the user alone, and reads it back", async () => {
    const path = redactionKeyPath(join(home, ".reflex"));
    const first = await readOrCreateRedactionKey(path);
    expect(first).toMatchObject({ ok: true, created: true });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, ".reflex"))).mode & 0o777).toBe(0o700);
    expect((await readFile(path)).length).toBe(REDACTION_KEY_BYTES);

    const second = await readOrCreateRedactionKey(path);
    expect(second).toMatchObject({ ok: true, created: false });
    expect(first.ok && second.ok && Buffer.compare(first.key, second.key)).toBe(
      0,
    );
  });

  it("gives the same secret the same placeholder across restarts, and another installation another", async () => {
    const path = redactionKeyPath(home);
    const one = await readOrCreateRedactionKey(path);
    const again = await readOrCreateRedactionKey(path);
    const elsewhere = await readOrCreateRedactionKey(
      redactionKeyPath(join(home, "other")),
    );
    if (!one.ok || !again.ok || !elsewhere.ok) {
      throw new Error("no key");
    }
    const secret = "sk-live-0123456789ab";
    const here = createRedactor({ key: one.key }).redactText(secret).text;
    expect(createRedactor({ key: again.key }).redactText(secret).text).toBe(
      here,
    );
    expect(
      createRedactor({ key: elsewhere.key }).redactText(secret).text,
    ).not.toBe(here);
  });

  it("refuses a key of the wrong size rather than replacing it", async () => {
    const path = redactionKeyPath(home);
    await writeFile(path, Buffer.alloc(5, 1));
    expect(await readOrCreateRedactionKey(path)).toEqual({
      ok: false,
      reason: "wrong-size",
    });
    expect((await readFile(path)).length).toBe(5);
  });

  it("tightens a key that became readable by others", async () => {
    const path = redactionKeyPath(home);
    await writeFile(path, Buffer.alloc(REDACTION_KEY_BYTES, 2), {
      mode: 0o644,
    });
    expect((await readOrCreateRedactionKey(path)).ok).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("reports a home it cannot write", async () => {
    const result = await readOrCreateRedactionKey("/dev/null/no/redaction.key");
    expect(result.ok).toBe(false);
  });
});
