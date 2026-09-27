import type { DecisionEffect, DecisionId } from "@reflex/contracts";

/**
 * RFX-125 — the override path for a `deny` in Autopilot.
 *
 * A human, in a terminal, outside the agent's reach, may let one denied
 * action through once. The store remembers recent decisions by their
 * action fingerprint (ADR-006: keyed, never the arguments), turns one deny
 * into a one-shot grant on request, and hands the grant to the engine when
 * the same action comes back. A mandatory deny is not overridable this way
 * (CLAUDE.md: a lower precedence never weakens a mandatory deny); an
 * organization that wants a deny to hold marks it mandatory. Everything
 * here is in memory and bounded: the daemon restarts with a clean slate.
 */
export interface RememberedDecision {
  readonly decisionId: DecisionId;
  readonly fingerprint: string;
  readonly effectiveEffect: DecisionEffect;
  /** A matched deny rule is mandatory: never overridable. */
  readonly mandatoryDeny: boolean;
  readonly rememberedAt: number;
  /** A grant was issued for it. One per decision, ever. */
  readonly overridden?: boolean;
}

export interface OverrideGrant {
  readonly decisionId: DecisionId;
  readonly fingerprint: string;
  readonly grantedAt: number;
  readonly expiresAt: number;
}

export type OverrideRefusal =
  /** Never decided here, or too long ago. */
  | "unknown-decision"
  /** The decision did not deny; there is nothing to override. */
  | "not-a-deny"
  /** A mandatory deny holds whatever anyone says. */
  | "mandatory-deny"
  /**
   * This decision was already overridden (one grant per decision, ever, so
   * that an old id cannot let an action through again and again), or the
   * same action already has a grant waiting.
   */
  | "already-granted";

export type OverrideResult =
  | { readonly ok: true; readonly grant: OverrideGrant }
  | { readonly ok: false; readonly reason: OverrideRefusal };

export interface OverrideStoreOptions {
  /** How many recent decisions are kept. */
  readonly maxDecisions?: number;
  /** How long a decision can be overridden after it was made. */
  readonly decisionTtlMs?: number;
  /** How long a grant waits for the action to come back. */
  readonly grantTtlMs?: number;
}

export const DEFAULT_OVERRIDE_OPTIONS: Required<OverrideStoreOptions> = {
  maxDecisions: 2_000,
  decisionTtlMs: 30 * 60_000,
  grantTtlMs: 10 * 60_000,
};

export interface OverrideCounters {
  readonly granted: number;
  readonly consumed: number;
  readonly refused: number;
  readonly pending: number;
}

export class OverrideStore {
  readonly #options: Required<OverrideStoreOptions>;
  /** Insertion-ordered: the oldest is the first. */
  readonly #decisions = new Map<DecisionId, RememberedDecision>();
  readonly #grants = new Map<string, OverrideGrant>();
  #granted = 0;
  #consumed = 0;
  #refused = 0;

  constructor(options: OverrideStoreOptions = {}) {
    this.#options = { ...DEFAULT_OVERRIDE_OPTIONS, ...options };
  }

  remember(
    decision: Omit<RememberedDecision, "rememberedAt">,
    now: number,
  ): void {
    this.#decisions.set(decision.decisionId, {
      ...decision,
      rememberedAt: now,
    });
    while (this.#decisions.size > this.#options.maxDecisions) {
      const oldest = this.#decisions.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#decisions.delete(oldest);
    }
  }

  /** A human's yes to one denied decision: a one-shot grant, or why not. */
  grant(decisionId: DecisionId, now: number): OverrideResult {
    const refuse = (reason: OverrideRefusal): OverrideResult => {
      this.#refused += 1;
      return { ok: false, reason };
    };
    const decision = this.#decisions.get(decisionId);
    if (
      decision === undefined ||
      now - decision.rememberedAt > this.#options.decisionTtlMs
    ) {
      return refuse("unknown-decision");
    }
    if (decision.effectiveEffect !== "deny") {
      return refuse("not-a-deny");
    }
    if (decision.mandatoryDeny) {
      return refuse("mandatory-deny");
    }
    this.#expire(now);
    if (
      decision.overridden === true ||
      this.#grants.has(decision.fingerprint)
    ) {
      return refuse("already-granted");
    }
    const grant: OverrideGrant = {
      decisionId,
      fingerprint: decision.fingerprint,
      grantedAt: now,
      expiresAt: now + this.#options.grantTtlMs,
    };
    this.#grants.set(decision.fingerprint, grant);
    this.#decisions.set(decisionId, { ...decision, overridden: true });
    this.#granted += 1;
    return { ok: true, grant };
  }

  /** The grant for this action, consumed. Once. */
  take(fingerprint: string, now: number): OverrideGrant | undefined {
    this.#expire(now);
    const grant = this.#grants.get(fingerprint);
    if (grant === undefined) {
      return undefined;
    }
    this.#grants.delete(fingerprint);
    this.#consumed += 1;
    return grant;
  }

  counters(now: number): OverrideCounters {
    this.#expire(now);
    return {
      granted: this.#granted,
      consumed: this.#consumed,
      refused: this.#refused,
      pending: this.#grants.size,
    };
  }

  #expire(now: number): void {
    for (const [fingerprint, grant] of this.#grants) {
      if (grant.expiresAt <= now) {
        this.#grants.delete(fingerprint);
      }
    }
  }
}
