import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * A local, size-bounded log: one JSON object per line, rotated by size.
 *
 * Several processes can append at once (hosts run tool calls in parallel),
 * so every record is written with a single `write` on a file opened in
 * append mode: the operating system keeps those whole, and no lock is needed
 * on the hot path.
 */
export interface RotatingLogOptions {
  /** Directory that holds the log, for example `~/.reflex/observe`. */
  readonly directory: string;
  /** `<baseName>.jsonl`, and `<baseName>.<n>.jsonl` once rotated. */
  readonly baseName: string;
  /** Rotate once the active file reaches this size. */
  readonly maxBytes?: number;
  /** Rotated files to keep, besides the active one. */
  readonly keepFiles?: number;
  /**
   * Retention: the active file is rotated once it has been written to for
   * this long, and a rotated file whose last write is older than this is
   * removed at the next rotation. Absent means size alone decides.
   */
  readonly maxAgeMs?: number;
  /** For tests. */
  readonly now?: () => number;
}

export type AppendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "write-failed" };

const DEFAULTS = { maxBytes: 5 * 1024 * 1024, keepFiles: 3 } as const;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export class RotatingJsonlLog<Record> {
  readonly #directory: string;
  readonly #baseName: string;
  readonly #maxBytes: number;
  readonly #keepFiles: number;
  readonly #maxAgeMs: number | undefined;
  readonly #now: () => number;
  /** When the active file was first written by this process, or was born. */
  #activeSince: number | undefined;
  readonly #isRecord: (value: unknown) => value is Record;

  constructor(
    options: RotatingLogOptions,
    isRecord: (value: unknown) => value is Record,
  ) {
    this.#directory = options.directory;
    this.#baseName = options.baseName;
    this.#maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
    this.#keepFiles = options.keepFiles ?? DEFAULTS.keepFiles;
    this.#maxAgeMs = options.maxAgeMs;
    this.#now = options.now ?? Date.now;
    this.#isRecord = isRecord;
  }

  get activeFile(): string {
    return join(this.#directory, `${this.#baseName}.jsonl`);
  }

  #rotated(index: number): string {
    return join(this.#directory, `${this.#baseName}.${String(index)}.jsonl`);
  }

  /**
   * Never throws. The caller is on someone's hot path: a full disk or a
   * permissions problem must not become the host's problem.
   */
  async append(record: Record): Promise<AppendResult> {
    try {
      await mkdir(this.#directory, { recursive: true, mode: DIRECTORY_MODE });
      await this.#rotateIfNeeded();

      const handle = await open(this.activeFile, "a", FILE_MODE);
      try {
        await handle.write(`${JSON.stringify(record)}\n`);
      } finally {
        await handle.close();
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: "write-failed" };
    }
  }

  /** The most recent records, oldest first. Unreadable lines are skipped. */
  async readRecent(limit: number): Promise<Record[]> {
    const files = [
      ...Array.from({ length: this.#keepFiles }, (_, index) =>
        this.#rotated(this.#keepFiles - index),
      ),
      this.activeFile,
    ];

    const records: Record[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        const record = this.#parseLine(line);
        if (record !== undefined) {
          records.push(record);
        }
      }
    }
    return records.slice(-limit);
  }

  async #rotateIfNeeded(): Promise<void> {
    let size: number;
    let born: number;
    try {
      const active = await stat(this.activeFile);
      size = active.size;
      // Where the file system knows a birth time it is used; where it does
      // not (it reads as 0), the first write seen by this process stands in.
      born = active.birthtimeMs > 0 ? active.birthtimeMs : this.#now();
    } catch {
      // No active file: this append creates it, and its age starts now.
      this.#activeSince = this.#now();
      return;
    }
    this.#activeSince ??= born;
    const now = this.#now();
    const aged =
      this.#maxAgeMs !== undefined && now - this.#activeSince >= this.#maxAgeMs;
    if (size < this.#maxBytes && !aged) {
      return;
    }
    this.#activeSince = undefined;

    // Two processes may rotate at once. Every step is a rename or a forced
    // remove, so the worst case is one record landing in a rotated file.
    await rm(this.#rotated(this.#keepFiles), { force: true });
    for (let index = this.#keepFiles - 1; index >= 1; index -= 1) {
      await rename(this.#rotated(index), this.#rotated(index + 1)).catch(
        () => undefined,
      );
    }
    await rename(this.activeFile, this.#rotated(1)).catch(() => undefined);
    await this.#purgeAged(now);
  }

  /** Rotated files whose last write is older than the retention are removed. */
  async #purgeAged(now: number): Promise<void> {
    if (this.#maxAgeMs === undefined) {
      return;
    }
    for (let index = 1; index <= this.#keepFiles; index += 1) {
      const file = this.#rotated(index);
      try {
        const info = await stat(file);
        if (now - info.mtimeMs >= this.#maxAgeMs) {
          await rm(file, { force: true });
        }
      } catch {
        // Not there: nothing to purge.
      }
    }
  }

  #parseLine(line: string): Record | undefined {
    if (line.trim() === "") {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      // A local file this package wrote. Trusted as far as its shape goes; a
      // truncated or foreign line simply does not get this far.
      return this.#isRecord(parsed) ? parsed : undefined;
    } catch {
      // A line cut short by a crash or a full disk. Skipped.
      return undefined;
    }
  }
}
