import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SIDE_EFFECT_CLASSES, type SideEffectClass } from "@reflex/contracts";
import { describe, expect, it } from "vitest";

import { DETERMINISTIC_RISK, reasonForClass, riskOf } from "./risk.js";

const ADR_002 = readFileSync(
  fileURLToPath(
    new URL(
      "../../../docs/adr/ADR-002-decision-precedence-and-effective-effect.md",
      import.meta.url,
    ),
  ),
  "utf8",
);

/** The table in ADR-002 §3, read from the document so the two cannot drift. */
function tableInAdr(): Map<SideEffectClass, number> {
  const rows = new Map<SideEffectClass, number>();
  for (const match of ADR_002.matchAll(/^\| `([a-z-]+)`\s+\| (\d+)\s+\|$/gm)) {
    const [, name, risk] = match;
    if (
      name !== undefined &&
      risk !== undefined &&
      (SIDE_EFFECT_CLASSES as readonly string[]).includes(name)
    ) {
      rows.set(name as SideEffectClass, Number(risk));
    }
  }
  return rows;
}

describe("deterministic risk (ADR-002 §3)", () => {
  it("is the table in the ADR, for every class", () => {
    const documented = tableInAdr();
    expect(documented.size).toBe(SIDE_EFFECT_CLASSES.length);
    for (const sideEffectClass of SIDE_EFFECT_CLASSES) {
      expect(riskOf(sideEffectClass), sideEffectClass).toBe(
        documented.get(sideEffectClass),
      );
    }
  });

  it("is an integer in 0..100 and never lower for a more severe class", () => {
    const order: readonly SideEffectClass[] = [
      "none",
      "local-read",
      "external-read",
      "local-write",
      "unknown",
      "external-write",
      "privilege",
      "credential",
      "destructive",
      "financial",
    ];
    let previous = -1;
    for (const sideEffectClass of order) {
      const risk = DETERMINISTIC_RISK[sideEffectClass];
      expect(Number.isInteger(risk)).toBe(true);
      expect(risk).toBeGreaterThanOrEqual(previous);
      expect(risk).toBeLessThanOrEqual(100);
      previous = risk;
    }
  });

  it("explains every class that is not a plain read or local write", () => {
    expect(reasonForClass("none")).toBeUndefined();
    expect(reasonForClass("local-read")).toBeUndefined();
    expect(reasonForClass("local-write")).toBeUndefined();
    expect(reasonForClass("unknown")).toBe("unknown_risk");
    expect(reasonForClass("destructive")).toBe("destructive");
    expect(reasonForClass("credential")).toBe("secret_access");
    expect(reasonForClass("privilege")).toBe("privilege_escalation");
    expect(reasonForClass("financial")).toBe("financial_action");
    expect(reasonForClass("external-read")).toBe("external_side_effect");
    expect(reasonForClass("external-write")).toBe("external_side_effect");
  });
});
