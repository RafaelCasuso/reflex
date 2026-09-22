import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SemanticDecisionRequest } from "@reflex/contracts";

/** The request and the answer the real provider gave in RFX-107, as recorded. */
interface Recorded {
  readonly requestedModel: string;
  readonly sample: {
    readonly request: {
      readonly state: unknown;
      readonly model: string;
      readonly questions: Record<
        string,
        { readonly instructions: string; readonly criteria: unknown }
      >;
    };
    readonly response: Record<string, unknown>;
  };
}

export const RECORD = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../live/results/jev-1.13.0.json", import.meta.url)),
    "utf8",
  ),
) as Recorded;

/** The recorded answer, with the boolean re-asked as a `choice`. */
export function recordedResponse(
  booleanForm: "choice" | "noul" = "noul",
): Record<string, unknown> {
  const response = structuredClone(RECORD.sample.response);
  const answers = response.answers as Record<string, unknown>;
  if (booleanForm === "choice") {
    const noul = (answers.externalSideEffect as { noul: number }).noul;
    answers.externalSideEffect = {
      type: "choice",
      choice: noul >= 0.5 ? "yes" : "no",
      probabilities: { yes: noul, no: 1 - noul },
      confidence: Math.abs(noul - 0.5) * 2,
    };
  }
  return response;
}

export function request(
  overrides: Partial<SemanticDecisionRequest["action"]> = {},
): SemanticDecisionRequest {
  return {
    action: {
      userObjective:
        "Fix the failing date-formatting test and open a pull request.",
      taskSummary: "Cleaning build output before re-running the test suite.",
      tool: { name: "Bash" },
      operation: "execute shell command",
      arguments: { command: "rm -rf dist coverage && pnpm test --filter web" },
      sideEffectClass: "unknown",
      repository: { root: "/work/webapp", branch: "fix/date-format" },
      priorActions: [
        { toolName: "Read", occurredAt: "2026-09-22T10:00:00.000Z" },
        {
          toolName: "Bash",
          operation: "pnpm test --filter web",
          effect: "allow",
          occurredAt: "2026-09-22T10:01:00.000Z",
        },
      ],
      ...overrides,
    },
    policyHints: ["Deleting files outside the repository requires approval."],
    maxInputTokens: 600,
    deadlineMs: 500,
  };
}
