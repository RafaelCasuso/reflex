import { join } from "node:path";

import type { ObservationRecord } from "./records.js";
import {
  RotatingJsonlLog,
  type AppendResult,
  type RotatingLogOptions,
} from "./rotating-log.js";

/**
 * RFX-086 — the local, size-bounded log of what REFLEX observed.
 */
export type ObservationLogOptions = Omit<RotatingLogOptions, "baseName">;

export type { AppendResult };

function isObservationRecord(value: unknown): value is ObservationRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "recordVersion" in value &&
    "recordedAt" in value
  );
}

export class ObservationLog {
  readonly #log: RotatingJsonlLog<ObservationRecord>;

  constructor(options: ObservationLogOptions) {
    this.#log = new RotatingJsonlLog<ObservationRecord>(
      { ...options, baseName: "observations" },
      isObservationRecord,
    );
  }

  get activeFile(): string {
    return this.#log.activeFile;
  }

  /** Never throws: a hook inside someone's tool call must not fail the host. */
  append(record: ObservationRecord): Promise<AppendResult> {
    return this.#log.append(record);
  }

  /** The most recent records, oldest first. Unreadable lines are skipped. */
  readRecent(limit: number): Promise<ObservationRecord[]> {
    return this.#log.readRecent(limit);
  }
}

export function defaultObservationDirectory(reflexHome: string): string {
  return join(reflexHome, "observe");
}
