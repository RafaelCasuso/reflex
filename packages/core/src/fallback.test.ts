import {
  FAILURE_MODES,
  FALLBACK_REASONS,
  SIDE_EFFECT_CLASSES,
  type FailureMode,
  type SideEffectClass,
} from "@reflex-control/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_FAILURE_MODE,
  FAILURE_MODE_CEILING,
  fallbackEffect,
  fallbackReasonCode,
  resolveFailureMode,
  strictestFailureMode,
} from "./fallback.js";

const STRICTNESS: Record<FailureMode, number> = {
  "fail-open": 0,
  "fail-ask": 1,
  "fail-closed": 2,
};

describe("RFX-020 failure-mode engine (ADR-003)", () => {
  it("defaults to fail-ask with nothing configured", () => {
    expect(DEFAULT_FAILURE_MODE).toBe("fail-ask");
  });

  it("lets only none and local-read fail open (ADR-003 §2)", () => {
    const mayFailOpen = SIDE_EFFECT_CLASSES.filter(
      (sideEffectClass) =>
        FAILURE_MODE_CEILING[sideEffectClass] === "fail-open",
    );
    expect(mayFailOpen.sort()).toEqual(["local-read", "none"]);
    // Everything else, `unknown` included, is at least fail-ask.
    for (const sideEffectClass of SIDE_EFFECT_CLASSES) {
      if (!mayFailOpen.includes(sideEffectClass)) {
        expect(FAILURE_MODE_CEILING[sideEffectClass], sideEffectClass).toBe(
          "fail-ask",
        );
      }
    }
  });

  // Enforcement item for RFX-020: every class by every requested and
  // configured mode.
  describe("the strictest of requested, configured and the class floor wins", () => {
    const cases: [SideEffectClass, FailureMode, FailureMode][] = [];
    for (const sideEffectClass of SIDE_EFFECT_CLASSES) {
      for (const requested of FAILURE_MODES) {
        for (const configured of FAILURE_MODES) {
          cases.push([sideEffectClass, requested, configured]);
        }
      }
    }
    expect(cases).toHaveLength(90);

    it.each(cases)(
      "%s, requested %s, configured %s",
      (sideEffectClass, requested, configured) => {
        const resolved = resolveFailureMode({
          requested,
          configured,
          sideEffectClass,
        });
        const expected = Math.max(
          STRICTNESS[requested],
          STRICTNESS[configured],
          STRICTNESS[FAILURE_MODE_CEILING[sideEffectClass]],
        );
        expect(STRICTNESS[resolved]).toBe(expected);
      },
    );
  });

  // Adversarial: a request for fail-open never yields anything more lenient
  // than the class floor, whatever is configured.
  it("cannot obtain fail-open for anything but a read or nothing", () => {
    for (const sideEffectClass of SIDE_EFFECT_CLASSES) {
      const resolved = resolveFailureMode({
        requested: "fail-open",
        configured: "fail-open",
        sideEffectClass,
      });
      if (sideEffectClass === "none" || sideEffectClass === "local-read") {
        expect(resolved).toBe("fail-open");
      } else {
        expect(resolved, sideEffectClass).not.toBe("fail-open");
      }
    }
  });

  it("lets a client ask to be treated more strictly, never less", () => {
    expect(
      resolveFailureMode({
        requested: "fail-closed",
        configured: "fail-open",
        sideEffectClass: "none",
      }),
    ).toBe("fail-closed");
    expect(
      resolveFailureMode({
        requested: "fail-open",
        configured: "fail-closed",
        sideEffectClass: "none",
      }),
    ).toBe("fail-closed");
  });

  it("raises the floor with the class: a raised class is a raised floor", () => {
    // The adapter said local-read; the classifier raised it to destructive.
    expect(
      resolveFailureMode({
        requested: "fail-open",
        configured: "fail-open",
        sideEffectClass: "destructive",
      }),
    ).toBe("fail-ask");
  });

  it("orders the modes and treats an empty list as the most lenient", () => {
    expect(strictestFailureMode([])).toBe("fail-open");
    expect(strictestFailureMode(["fail-ask", "fail-open"])).toBe("fail-ask");
    expect(strictestFailureMode(["fail-open", "fail-closed", "fail-ask"])).toBe(
      "fail-closed",
    );
  });

  it("decides ask for open and ask, deny for closed: open is never an allow", () => {
    expect(fallbackEffect("fail-open")).toBe("ask");
    expect(fallbackEffect("fail-ask")).toBe("ask");
    expect(fallbackEffect("fail-closed")).toBe("deny");
    for (const mode of FAILURE_MODES) {
      expect(fallbackEffect(mode)).not.toBe("allow");
    }
  });

  it("gives every fallback reason a reason code (ADR-003 §5)", () => {
    for (const reason of FALLBACK_REASONS) {
      expect(fallbackReasonCode(reason)).toBeTypeOf("string");
    }
    expect(fallbackReasonCode("timeout")).toBe("decision_timeout");
    expect(fallbackReasonCode("provider-error")).toBe("provider_unavailable");
    expect(fallbackReasonCode("gateway-error")).toBe("provider_unavailable");
  });
});
