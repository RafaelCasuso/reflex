import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  parseIngestRequest,
  type IngestEntry,
} from "@reflex-control/contracts";

import type { AppendResult } from "./rotating-log.js";

/**
 * ADR-019 §4 — the outbox: what a claimed installation has decided and not
 * yet uploaded, in order.
 *
 * One JSON entry per line in `<REFLEX_HOME>/cloud/outbox.jsonl`, and a
 * cursor (`cursor.json`) that is the byte offset of the first line not yet
 * acknowledged. The uploader peeks at the entries after the cursor, sends
 * them, and acknowledges the offset past them on success, so an entry is
 * uploaded at least once and never skipped; a crash between the send and
 * the acknowledgement resends, and the control plane counts the duplicate.
 *
 * The file is bounded. When an append would exceed the bound, the oldest
 * unsent entries are dropped, counted, and reported through `dropped`; the
 * decision path never waits for any of this, and nothing here throws.
 *
 * One writer at a time: the daemon. `rfx claim` appends the local history
 * only after it has stopped the daemon.
 */
export const OUTBOX_FILE = "outbox.jsonl";
export const OUTBOX_CURSOR_FILE = "cursor.json";
export const DEFAULT_OUTBOX_MAX_BYTES = 20 * 1024 * 1024;
/** Acknowledged bytes are reclaimed once they pass this. */
const COMPACT_AFTER_BYTES = 1024 * 1024;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export interface CloudOutboxOptions {
  readonly directory: string;
  readonly maxBytes?: number;
}

export interface OutboxBatch {
  readonly entries: readonly IngestEntry[];
  /** What to acknowledge once every entry of the batch is uploaded. */
  readonly cursor: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A line is an entry when the contract says so; the file is REFLEX's own. */
function parseEntry(line: string): IngestEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    const result = parseIngestRequest({
      agentId: "agt_0",
      sentAt: "1970-01-01T00:00:00.000Z",
      entries: [parsed],
    });
    return result.ok ? result.value.entries[0] : undefined;
  } catch {
    return undefined;
  }
}

export function defaultOutboxDirectory(reflexHome: string): string {
  return join(reflexHome, "cloud");
}

export class CloudOutbox {
  readonly #directory: string;
  readonly #maxBytes: number;
  #dropped = 0;
  /** Serializes every operation on the file: one writer, in order. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: CloudOutboxOptions) {
    this.#directory = options.directory;
    this.#maxBytes = options.maxBytes ?? DEFAULT_OUTBOX_MAX_BYTES;
  }

  get file(): string {
    return join(this.#directory, OUTBOX_FILE);
  }

  get cursorFile(): string {
    return join(this.#directory, OUTBOX_CURSOR_FILE);
  }

  /** Entries dropped because the outbox was full. */
  get dropped(): number {
    return this.#dropped;
  }

  #serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #readCursor(): Promise<number> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(this.cursorFile, "utf8"),
      );
      if (
        isRecord(parsed) &&
        parsed.version === 1 &&
        typeof parsed.offset === "number" &&
        Number.isInteger(parsed.offset) &&
        parsed.offset >= 0
      ) {
        return parsed.offset;
      }
    } catch {
      // No cursor: nothing acknowledged.
    }
    return 0;
  }

  async #writeCursor(offset: number): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: DIRECTORY_MODE });
    const temporary = `${this.cursorFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, offset })}\n`, {
      mode: FILE_MODE,
    });
    await rename(temporary, this.cursorFile);
  }

  async #size(): Promise<number> {
    try {
      return (await stat(this.file)).size;
    } catch {
      return 0;
    }
  }

  /** Never throws. Full is handled by dropping the oldest unsent entries. */
  append(entry: IngestEntry): Promise<AppendResult> {
    return this.#serialized(async () => {
      try {
        await mkdir(this.#directory, {
          recursive: true,
          mode: DIRECTORY_MODE,
        });
        const line = `${JSON.stringify(entry)}\n`;
        const lineBytes = Buffer.byteLength(line, "utf8");
        const size = await this.#size();
        const cursor = Math.min(await this.#readCursor(), size);
        if (size - cursor + lineBytes > this.#maxBytes) {
          await this.#makeRoom(cursor, lineBytes);
        }
        const handle = await open(this.file, "a+", FILE_MODE);
        try {
          // A line cut short by a crash would swallow the next entry into
          // one unparseable line; it is terminated first, and skipped later.
          const current = (await handle.stat()).size;
          if (current > 0) {
            const last = Buffer.alloc(1);
            await handle.read(last, 0, 1, current - 1);
            if (last[0] !== 0x0a) {
              await handle.write("\n");
            }
          }
          await handle.write(line);
        } finally {
          await handle.close();
        }
        return { ok: true };
      } catch {
        return { ok: false, reason: "write-failed" };
      }
    });
  }

  /**
   * Drops unsent entries from the front until the new line fits, and
   * rewrites the file as the unsent remainder with the cursor at zero.
   */
  async #makeRoom(cursor: number, lineBytes: number): Promise<void> {
    const unsent = (await readFile(this.file)).subarray(cursor);
    const kept: Buffer[] = [];
    let offset = 0;
    while (offset < unsent.length) {
      const end = unsent.indexOf(0x0a, offset);
      if (end === -1) {
        // A line cut short by a crash is not an entry; it is not kept.
        this.#dropped += 1;
        break;
      }
      if (end > offset) {
        kept.push(unsent.subarray(offset, end + 1));
      }
      offset = end + 1;
    }
    let bytes = kept.reduce((total, line) => total + line.length, lineBytes);
    while (kept.length > 0 && bytes > this.#maxBytes) {
      const removed = kept.shift();
      bytes -= removed?.length ?? 0;
      this.#dropped += 1;
    }
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, Buffer.concat(kept), { mode: FILE_MODE });
    await rename(temporary, this.file);
    await this.#writeCursor(0);
  }

  /** The next entries to upload, oldest first, and the cursor past them. */
  peek(limit: number): Promise<OutboxBatch> {
    return this.#serialized(async () => {
      let buffer: Buffer;
      try {
        buffer = await readFile(this.file);
      } catch {
        return { entries: [], cursor: 0 };
      }
      const start = Math.min(await this.#readCursor(), buffer.length);
      const entries: IngestEntry[] = [];
      let offset = start;
      let cursor = start;
      while (entries.length < limit && offset < buffer.length) {
        const end = buffer.indexOf(0x0a, offset);
        if (end === -1) {
          // Not yet terminated: the writer is mid-line, or a crash cut it.
          break;
        }
        const line = buffer.subarray(offset, end).toString("utf8");
        offset = end + 1;
        cursor = offset;
        if (line.trim() === "") {
          continue;
        }
        const entry = parseEntry(line);
        if (entry !== undefined) {
          entries.push(entry);
        }
      }
      return { entries, cursor };
    });
  }

  /** Moves the cursor forward, never back, and reclaims acknowledged bytes. */
  acknowledge(cursor: number): Promise<void> {
    return this.#serialized(async () => {
      const current = await this.#readCursor();
      const size = await this.#size();
      const next = Math.min(Math.max(current, cursor), size);
      const drained = next === size && size > 0;
      if (drained || (next >= COMPACT_AFTER_BYTES && next * 2 >= size)) {
        // Everything acknowledged, or more acknowledged than not: the file
        // becomes its unsent remainder and the cursor starts over.
        const remainder = drained
          ? Buffer.alloc(0)
          : (await readFile(this.file)).subarray(next);
        const temporary = `${this.file}.tmp`;
        await writeFile(temporary, remainder, { mode: FILE_MODE });
        await rename(temporary, this.file);
        await this.#writeCursor(0);
        return;
      }
      await this.#writeCursor(next);
    });
  }

  /** How many entries wait after the cursor. For `rfx status`. */
  pending(): Promise<number> {
    return this.#serialized(async () => {
      let buffer: Buffer;
      try {
        buffer = await readFile(this.file);
      } catch {
        return 0;
      }
      const start = Math.min(await this.#readCursor(), buffer.length);
      let count = 0;
      let offset = start;
      while (offset < buffer.length) {
        const end = buffer.indexOf(0x0a, offset);
        if (end === -1) {
          break;
        }
        if (end > offset) {
          count += 1;
        }
        offset = end + 1;
      }
      return count;
    });
  }
}
