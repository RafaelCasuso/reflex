import {
  chmod,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nodeFileSystem, sha256, type FileSystemPort } from "./file-system.js";
import {
  applyTransaction,
  type BackupManifest,
  type PlannedWrite,
} from "./transaction.js";

let root: string;
let backupDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-tx-"));
  backupDir = join(root, ".reflex", "backups", "run");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bytes = (text: string) => Buffer.from(text, "utf8");

async function seed(name: string, text: string, mode = 0o644): Promise<string> {
  const path = join(root, name);
  await writeFile(path, text);
  await chmod(path, mode);
  return path;
}

async function planFor(
  path: string,
  content: string | undefined,
): Promise<PlannedWrite> {
  const current = await nodeFileSystem.read(path);
  return {
    path,
    content: content === undefined ? undefined : bytes(content),
    expectedSha256: current === undefined ? undefined : sha256(current.content),
  };
}

/** Fails the Nth call to `write` that targets a path outside the backup dir. */
function failingOn(nthConfigWrite: number): FileSystemPort {
  let configWrites = 0;
  return {
    ...nodeFileSystem,
    async write(path, content, mode) {
      if (!path.startsWith(backupDir)) {
        configWrites += 1;
        if (configWrites === nthConfigWrite) {
          // A realistic partial failure: bytes land, then the call throws.
          await nodeFileSystem.write(path, bytes("CORRUPTED"), mode);
          throw new Error("disk full");
        }
      }
      await nodeFileSystem.write(path, content, mode);
    },
  };
}

/** RFX-053 — partial failure rolls back prior modifications. */
describe("RFX-053 config transaction: success", () => {
  it("writes every file and keeps a byte-exact backup of each original", async () => {
    const a = await seed("a.json", '{"a":1}\n');
    const b = await seed("b.json", '{"b":2}\n');
    const created = join(root, "nested", "new.json");

    const result = await applyTransaction(
      [
        await planFor(a, '{"a":1,"hooks":{}}\n'),
        await planFor(b, '{"b":2,"hooks":{}}\n'),
        await planFor(created, "{}\n"),
      ],
      { backupDir, now: () => new Date("2026-09-19T10:00:00Z") },
    );

    expect(result.ok).toBe(true);
    expect(await readFile(a, "utf8")).toBe('{"a":1,"hooks":{}}\n');
    expect(await readFile(created, "utf8")).toBe("{}\n");

    if (!result.ok) {
      return;
    }
    const manifest = JSON.parse(
      await readFile(result.manifestPath, "utf8"),
    ) as BackupManifest;
    expect(manifest.createdAt).toBe("2026-09-19T10:00:00.000Z");
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      a,
      b,
      created,
    ]);

    const [first, , third] = manifest.entries;
    expect(first?.originalSha256).toBe(sha256(bytes('{"a":1}\n')));
    expect(await readFile(first?.backupFile ?? "", "utf8")).toBe('{"a":1}\n');
    // A file that did not exist has nothing to back up. On disk the manifest
    // simply omits those keys, which is what "absent" means in JSON.
    expect(third?.path).toBe(created);
    expect(third?.backupFile).toBeUndefined();
    expect(third?.originalSha256).toBeUndefined();
    expect(third?.writtenSha256).toBe(sha256(bytes("{}\n")));
  });

  it("deletes a file when the plan says so, after backing it up", async () => {
    const path = await seed("gone.json", "bye\n");
    const result = await applyTransaction([await planFor(path, undefined)], {
      backupDir,
    });

    expect(result.ok).toBe(true);
    expect(await nodeFileSystem.read(path)).toBeUndefined();
    if (result.ok) {
      const backup = result.manifest.entries[0]?.backupFile ?? "";
      expect(await readFile(backup, "utf8")).toBe("bye\n");
    }
  });

  it("preserves the permission bits of a private settings file", async () => {
    const path = await seed("settings.json", "{}\n", 0o600);
    await applyTransaction([await planFor(path, '{"hooks":{}}\n')], {
      backupDir,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("writes backups that only the user can read", async () => {
    const path = await seed("settings.json", '{"env":{"TOKEN":"x"}}\n', 0o600);
    const result = await applyTransaction([await planFor(path, "{}\n")], {
      backupDir,
    });
    if (result.ok) {
      const backup = result.manifest.entries[0]?.backupFile ?? "";
      expect((await stat(backup)).mode & 0o777).toBe(0o600);
      expect((await stat(result.manifestPath)).mode & 0o777).toBe(0o600);
    }
    expect(result.ok).toBe(true);
  });

  it("writes through a symlink instead of replacing it", async () => {
    // Dotfiles setups symlink settings into place. Replacing the link with a
    // regular file would silently detach the user's configuration.
    const real = await seed("dotfiles-settings.json", "{}\n");
    const link = join(root, "settings.json");
    await symlink(real, link);

    const result = await applyTransaction(
      [await planFor(link, '{"hooks":{}}\n')],
      { backupDir },
    );

    expect(result.ok).toBe(true);
    expect(await readlink(link)).toBe(real);
    expect(await readFile(real, "utf8")).toBe('{"hooks":{}}\n');
  });
});

describe("RFX-053 config transaction: failure", () => {
  it("rolls back every earlier write when a later one fails", async () => {
    const a = await seed("a.json", "original-a\n");
    const b = await seed("b.json", "original-b\n", 0o600);
    const c = await seed("c.json", "original-c\n");
    const created = join(root, "new.json");

    const result = await applyTransaction(
      [
        await planFor(created, "new\n"),
        await planFor(a, "changed-a\n"),
        await planFor(b, "changed-b\n"),
        await planFor(c, "changed-c\n"),
      ],
      { backupDir, fileSystem: failingOn(3) },
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "write-failed",
      path: b,
      rolledBack: true,
      unrestored: [],
    });
    expect(await readFile(a, "utf8")).toBe("original-a\n");
    // The write that failed half-way is restored too, mode included.
    expect(await readFile(b, "utf8")).toBe("original-b\n");
    expect((await stat(b)).mode & 0o777).toBe(0o600);
    expect(await readFile(c, "utf8")).toBe("original-c\n");
    // A file the transaction created is removed again.
    expect(await nodeFileSystem.read(created)).toBeUndefined();
  });

  it("says which files it could not restore when rollback fails too", async () => {
    const a = await seed("a.json", "original-a\n");
    const b = await seed("b.json", "original-b\n");
    let configWrites = 0;
    const brokenDisk: FileSystemPort = {
      ...nodeFileSystem,
      async write(path, content, mode) {
        if (!path.startsWith(backupDir)) {
          configWrites += 1;
          if (configWrites >= 2) {
            throw new Error("read-only file system");
          }
        }
        await nodeFileSystem.write(path, content, mode);
      },
    };

    const result = await applyTransaction(
      [await planFor(a, "changed-a\n"), await planFor(b, "changed-b\n")],
      { backupDir, fileSystem: brokenDisk },
    );

    // It must not claim a clean rollback, and it must point at the backups.
    expect(result).toMatchObject({
      ok: false,
      reason: "write-failed",
      rolledBack: false,
      backupDir,
    });
    if (!result.ok) {
      expect(result.unrestored).toContain(a);
    }
  });

  // Adversarial: the user approved a plan computed from specific bytes. If the
  // file changed since, applying the plan would overwrite edits nobody saw.
  it("refuses to run when a file changed after the plan was computed", async () => {
    const a = await seed("a.json", "original-a\n");
    const b = await seed("b.json", "original-b\n");
    const plan = [
      await planFor(a, "changed-a\n"),
      await planFor(b, "changed-b\n"),
    ];

    await writeFile(b, "edited by the user in the meantime\n");
    const result = await applyTransaction(plan, { backupDir });

    expect(result).toMatchObject({
      ok: false,
      reason: "changed-since-plan",
      path: b,
      rolledBack: true,
    });
    // Nothing was written, not even the first file.
    expect(await readFile(a, "utf8")).toBe("original-a\n");
    expect(await readFile(b, "utf8")).toBe(
      "edited by the user in the meantime\n",
    );
  });

  it("refuses to run when a file appeared where the plan expected none", async () => {
    const path = join(root, "settings.json");
    const plan = [await planFor(path, "{}\n")];
    await writeFile(path, '{"created":"by someone else"}\n');

    const result = await applyTransaction(plan, { backupDir });
    expect(result).toMatchObject({ ok: false, reason: "changed-since-plan" });
    expect(await readFile(path, "utf8")).toBe(
      '{"created":"by someone else"}\n',
    );
  });

  it("writes nothing when a backup cannot be taken", async () => {
    const a = await seed("a.json", "original-a\n");
    const noBackups: FileSystemPort = {
      ...nodeFileSystem,
      async write(path, content, mode) {
        if (path.startsWith(backupDir)) {
          throw new Error("no space left on device");
        }
        await nodeFileSystem.write(path, content, mode);
      },
    };

    const result = await applyTransaction([await planFor(a, "changed-a\n")], {
      backupDir,
      fileSystem: noBackups,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "backup-failed",
      rolledBack: true,
    });
    expect(await readFile(a, "utf8")).toBe("original-a\n");
  });

  it("restores binary content byte for byte", async () => {
    const path = join(root, "blob.bin");
    const original = Buffer.from([0x00, 0xff, 0xfe, 0x0a, 0x0d, 0x80, 0x00]);
    await writeFile(path, original);
    const other = await seed("other.json", "x\n");

    await applyTransaction(
      [await planFor(path, "text now\n"), await planFor(other, "y\n")],
      { backupDir, fileSystem: failingOn(2) },
    );

    expect((await readFile(path)).equals(original)).toBe(true);
  });
});
