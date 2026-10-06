import { join } from "node:path";

/**
 * RFX-126 — `rfx pause`: a bounded break-glass.
 *
 * When REFLEX misbehaves, the alternative to this is `rfx uninstall`, and
 * an uninstalled REFLEX protects nothing. A pause suspends enforcement for
 * a mandatory, bounded time: the hooks keep observing and answer nothing,
 * as in Observe; `rfx status` shows it; it ends by itself; `rfx resume`
 * ends it early. Both commands are on REFLEX's own rule, so the agent
 * cannot run them unasked (RFX-103). Every pause and resume is written to
 * the local audit file (the seed of RFX-085).
 */
export const PAUSE_VERSION = 1;
export const MAX_PAUSE_MS = 24 * 60 * 60_000;

export interface PauseRecord {
  readonly version: typeof PAUSE_VERSION;
  readonly pausedAt: string;
  readonly until: string;
  readonly reason?: string;
}

export function pausePath(home: string): string {
  return join(home, "pause.json");
}

export function auditPath(home: string): string {
  return join(home, "audit.jsonl");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A pause REFLEX cannot read is no pause: enforcement stays on. */
export function parsePause(text: string | undefined): PauseRecord | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      isRecord(parsed) &&
      parsed.version === PAUSE_VERSION &&
      typeof parsed.pausedAt === "string" &&
      typeof parsed.until === "string" &&
      !Number.isNaN(Date.parse(parsed.until))
    ) {
      return {
        version: PAUSE_VERSION,
        pausedAt: parsed.pausedAt,
        until: parsed.until,
        ...(typeof parsed.reason === "string" && parsed.reason !== ""
          ? { reason: parsed.reason }
          : {}),
      };
    }
  } catch {
    // No pause.
  }
  return undefined;
}

/** The pause in force at `now`, or `undefined` when none or it has ended. */
export function activePause(
  record: PauseRecord | undefined,
  now: Date,
): PauseRecord | undefined {
  return record !== undefined && Date.parse(record.until) > now.getTime()
    ? record
    : undefined;
}

/** `30m`, `2h`, `90s`, `1d`: whole units, bounded. `undefined` when it is not one. */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d{1,4})(s|m|h|d)$/.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "s" | "m" | "h" | "d"
  ];
  const ms = amount * unit;
  return ms >= 1_000 && ms <= MAX_PAUSE_MS ? ms : undefined;
}

export function pauseRecord(
  now: Date,
  durationMs: number,
  reason?: string,
): PauseRecord {
  return {
    version: PAUSE_VERSION,
    pausedAt: now.toISOString(),
    until: new Date(now.getTime() + durationMs).toISOString(),
    ...(reason === undefined || reason === "" ? {} : { reason }),
  };
}

export interface AuditEvent {
  readonly at: string;
  readonly kind:
    | "pause"
    | "resume"
    | "mode"
    | "provider"
    | "trust"
    | "untrust"
    | "policy-starter"
    | "policy-keygen"
    | "policy-snapshot"
    | "policy-subscribe"
    | "policy-unsubscribe";
  readonly projectDir?: string;
  readonly detail?: Readonly<Record<string, string>>;
}
