import { join } from "node:path";

import type { TelemetryEvent, TelemetrySink } from "./decision-events.js";
import {
  RotatingJsonlLog,
  type AppendResult,
  type RotatingLogOptions,
} from "./rotating-log.js";

/**
 * RFX-023 — the local decision telemetry log (ADR-008 §4: decision metadata,
 * kept locally, size-bounded here and purged by RFX-121).
 */
export type DecisionLogOptions = Omit<RotatingLogOptions, "baseName">;

function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "eventVersion" in value &&
    "at" in value
  );
}

export class DecisionLog implements TelemetrySink {
  readonly #log: RotatingJsonlLog<TelemetryEvent>;
  #pending: Promise<unknown> = Promise.resolve();
  #dropped = 0;

  constructor(options: DecisionLogOptions) {
    this.#log = new RotatingJsonlLog<TelemetryEvent>(
      { ...options, baseName: "decisions" },
      isTelemetryEvent,
    );
  }

  get activeFile(): string {
    return this.#log.activeFile;
  }

  /** Events the disk refused. Visible to `rfx status`, never to the host. */
  get dropped(): number {
    return this.#dropped;
  }

  /**
   * Fire and forget, in order. A write that fails is counted and dropped:
   * telemetry is never allowed to fail a decision or to block the next one.
   */
  emit(event: TelemetryEvent): void {
    this.#pending = this.#pending.then(async () => {
      const result = await this.#log.append(event);
      if (!result.ok) {
        this.#dropped += 1;
      }
    });
  }

  /** Resolves once everything emitted so far has been written or dropped. */
  async flush(): Promise<void> {
    await this.#pending;
  }

  readRecent(limit: number): Promise<TelemetryEvent[]> {
    return this.#log.readRecent(limit);
  }

  append(event: TelemetryEvent): Promise<AppendResult> {
    return this.#log.append(event);
  }
}

export function defaultDecisionLogDirectory(reflexHome: string): string {
  return join(reflexHome, "decisions");
}
