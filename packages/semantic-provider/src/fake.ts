import type {
  SemanticAssessment,
  SemanticDecisionRequest,
  SemanticSignal,
  SideEffectClass,
} from "@reflex/contracts";

import {
  providerError,
  type ProviderErrorKind,
  type ProviderResult,
  type SemanticDecisionProvider,
} from "./provider.js";

/**
 * RFX-029 — the deterministic fake provider.
 *
 * For tests and development: the whole engine runs offline against it. It
 * answers from the structured fields of the request and never from free
 * text, so two requests that differ only in an objective, a summary or an
 * argument value get the same assessment. That is also what makes it the
 * plumbing check of the prompt-injection corpus (RFX-108): injected text
 * cannot move it, so a difference between twins is the harness's fault.
 */
export const FAKE_PROVIDER_NAME = "fake";
export const FAKE_MODEL = "fake-1";

export type FakeBehavior =
  | { readonly kind: "assess" }
  | { readonly kind: "fixed"; readonly assessment: SemanticAssessment }
  | { readonly kind: "error"; readonly error: ProviderErrorKind }
  | { readonly kind: "hang" }
  | { readonly kind: "slow"; readonly ms: number }
  | { readonly kind: "throw" };

export interface FakeProviderOptions {
  readonly behavior?: FakeBehavior;
  /** Overrides the assessment derived from the request's class. */
  readonly assess?: (request: SemanticDecisionRequest) => SemanticAssessment;
}

export interface FakeProvider extends SemanticDecisionProvider {
  /** Every request received, in order. */
  readonly calls: SemanticDecisionRequest[];
  readonly signals: (AbortSignal | undefined)[];
}

const signal = <T>(value: T, confidence = 0.9): SemanticSignal<T> => ({
  value,
  confidence,
});

interface ClassProfile {
  readonly destructive: number;
  readonly reversibility: number;
  readonly external: boolean;
  readonly privilege: number;
  readonly secret: number;
  readonly financial: number;
  readonly production: number;
}

/** What a class looks like when nothing else is known. Coarse on purpose. */
const PROFILES: Readonly<Record<SideEffectClass, ClassProfile>> = {
  none: {
    destructive: 0,
    reversibility: 100,
    external: false,
    privilege: 0,
    secret: 0,
    financial: 0,
    production: 0,
  },
  "local-read": {
    destructive: 0,
    reversibility: 100,
    external: false,
    privilege: 0,
    secret: 0,
    financial: 0,
    production: 0,
  },
  "external-read": {
    destructive: 0,
    reversibility: 100,
    external: false,
    privilege: 0,
    secret: 0,
    financial: 0,
    production: 0,
  },
  "local-write": {
    destructive: 33,
    reversibility: 67,
    external: false,
    privilege: 0,
    secret: 0,
    financial: 0,
    production: 0,
  },
  unknown: {
    destructive: 33,
    reversibility: 67,
    external: false,
    privilege: 0,
    secret: 0,
    financial: 0,
    production: 0,
  },
  "external-write": {
    destructive: 33,
    reversibility: 33,
    external: true,
    privilege: 0,
    secret: 0,
    financial: 0,
    production: 33,
  },
  privilege: {
    destructive: 33,
    reversibility: 33,
    external: false,
    privilege: 100,
    secret: 33,
    financial: 0,
    production: 33,
  },
  credential: {
    destructive: 0,
    reversibility: 33,
    external: false,
    privilege: 33,
    secret: 100,
    financial: 0,
    production: 0,
  },
  destructive: {
    destructive: 100,
    reversibility: 0,
    external: false,
    privilege: 0,
    secret: 0,
    financial: 0,
    production: 33,
  },
  financial: {
    destructive: 33,
    reversibility: 0,
    external: true,
    privilege: 0,
    secret: 0,
    financial: 100,
    production: 67,
  },
};

/** Deterministic from the class and the tool alone. */
export function assessmentForClass(
  sideEffectClass: SideEffectClass,
  latencyMs = 1,
): SemanticAssessment {
  const profile = PROFILES[sideEffectClass];
  return {
    objectiveAlignment: signal(67),
    destructiveRisk: signal(profile.destructive),
    reversibility: signal(profile.reversibility),
    externalSideEffect: signal(profile.external),
    privilegeEscalation: signal(profile.privilege),
    secretAccess: signal(profile.secret),
    sensitiveDataExposure: signal(0),
    financialConsequence: signal(profile.financial),
    productionMutation: signal(profile.production),
    unusualScope: signal(sideEffectClass === "unknown" ? 33 : 0),
    untrustedInput: signal(0),
    provider: FAKE_PROVIDER_NAME,
    model: FAKE_MODEL,
    latencyMs,
  };
}

export function createFakeProvider(
  options: FakeProviderOptions = {},
): FakeProvider {
  const behavior = options.behavior ?? { kind: "assess" };
  const calls: SemanticDecisionRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const assess =
    options.assess ??
    ((request: SemanticDecisionRequest) =>
      assessmentForClass(request.action.sideEffectClass));

  const abortedResult = (reason: unknown): ProviderResult => ({
    ok: false,
    error: providerError(
      reason instanceof DOMException && reason.name === "TimeoutError"
        ? "timeout"
        : "aborted",
      FAKE_PROVIDER_NAME,
      0,
    ),
  });

  return {
    providerName: FAKE_PROVIDER_NAME,
    model: FAKE_MODEL,
    calls,
    signals,
    evaluate(request, signal) {
      calls.push(request);
      signals.push(signal);
      switch (behavior.kind) {
        case "assess":
          return Promise.resolve({ ok: true, assessment: assess(request) });
        case "fixed":
          return Promise.resolve({ ok: true, assessment: behavior.assessment });
        case "error":
          return Promise.resolve({
            ok: false,
            error: providerError(behavior.error, FAKE_PROVIDER_NAME, 1),
          });
        case "throw":
          throw new TypeError("a bug in the provider");
        case "hang":
          return new Promise((resolve) => {
            signal?.addEventListener("abort", () => {
              resolve(abortedResult(signal.reason));
            });
          });
        case "slow":
          return new Promise((resolve) => {
            const timer = setTimeout(() => {
              resolve({ ok: true, assessment: assess(request) });
            }, behavior.ms);
            signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve(abortedResult(signal.reason));
            });
          });
      }
    },
  };
}
