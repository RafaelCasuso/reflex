import { createHash } from "node:crypto";

import {
  DECISION_EFFECTS,
  parseCanonicalAction,
  type ActionId,
  type CanonicalAction,
  type DecisionEffect,
} from "@reflex-control/contracts";

/**
 * RFX-105 — the golden corpus: actions, and what REFLEX may decide about them.
 *
 * A case never says what the decision must be. It says which decisions are
 * acceptable, and whether allowing the action would be dangerous. That keeps
 * the two failures apart: asking about `git status` costs autonomy, allowing
 * `rm -rf ~` costs the product. Only the second one is a safety regression.
 *
 * The action is what an adapter really sends today. In particular
 * `sideEffectClass` is `unknown` for almost everything (ADR-001 §4): the
 * corpus must not hand the engine a classification no adapter computes.
 */
export const CORPUS_PROVENANCE = ["observed", "constructed"] as const;
export type CorpusProvenance = (typeof CORPUS_PROVENANCE)[number];

/** The action as written in a corpus file. The loader supplies the rest. */
export type CorpusAction = Omit<CanonicalAction, "id" | "createdAt">;

/**
 * RFX-038: what a right assessment says about the case, per dimension. A
 * scored dimension accepts a set of the four levels a provider can answer
 * (0, 33, 67, 100, `packages/provider-jev`); the boolean accepts one value.
 * Absent means the case says nothing about that dimension.
 */
export const ASSESSMENT_LEVELS = [0, 33, 67, 100] as const;
export type AssessmentLevel = (typeof ASSESSMENT_LEVELS)[number];

export const SCORED_ASSESSMENT_DIMENSIONS = [
  "objectiveAlignment",
  "destructiveRisk",
  "reversibility",
  "privilegeEscalation",
  "secretAccess",
  "sensitiveDataExposure",
  "financialConsequence",
  "productionMutation",
  "unusualScope",
  "untrustedInput",
] as const;
export type ScoredAssessmentDimension =
  (typeof SCORED_ASSESSMENT_DIMENSIONS)[number];

export type ExpectedAssessment = Partial<
  Readonly<Record<ScoredAssessmentDimension, readonly AssessmentLevel[]>>
> & { readonly externalSideEffect?: boolean };

export interface CorpusCase {
  /** Stable and unique. The action's ID is derived from it. */
  readonly id: string;
  readonly title: string;
  readonly action: CanonicalAction;
  /** Never empty. `ask` is rarely wrong; it is only expensive. */
  readonly acceptableEffects: readonly DecisionEffect[];
  /** True when running this without a human would be a safety failure. */
  readonly dangerousIfAllowed: boolean;
  /** `observed`: a payload a real host sent. `constructed`: written by hand. */
  readonly provenance: CorpusProvenance;
  readonly tags: readonly string[];
  /** Why these effects. A case nobody can argue with is a case nobody reads. */
  readonly why: string;
  /** RFX-038: present on semantic cases; absent on deterministic ones. */
  readonly expectedAssessment?: ExpectedAssessment;
}

export interface CorpusIssue {
  readonly file: string;
  readonly caseId: string | undefined;
  readonly message: string;
}

export type CorpusLoadResult =
  | { readonly ok: true; readonly cases: readonly CorpusCase[] }
  | { readonly ok: false; readonly issues: readonly CorpusIssue[] };

/** A corpus file, by name and parsed content. The loader does no I/O. */
export interface CorpusFile {
  readonly name: string;
  readonly content: unknown;
}

const CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CASE_KEYS = new Set([
  "id",
  "title",
  "action",
  "acceptableEffects",
  "dangerousIfAllowed",
  "provenance",
  "tags",
  "why",
  "expectedAssessment",
]);

/** Fixed, so that a replay is reproducible byte for byte. */
const CORPUS_EPOCH = "2026-01-01T00:00:00.000Z";

/** Length-prefixed, so that no two case IDs can collide by concatenation. */
export function corpusActionId(caseId: string): ActionId {
  const digest = createHash("sha256")
    .update(`reflex-corpus:${String(caseId.length)}:${caseId}`)
    .digest("hex");
  return `act_${digest.slice(0, 32)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

type CaseReadResult =
  | { readonly ok: true; readonly value: CorpusCase }
  | { readonly ok: false; readonly message: string };

const invalid = (message: string): CaseReadResult => ({ ok: false, message });

function readCase(raw: unknown): CaseReadResult {
  if (!isRecord(raw)) {
    return invalid("a case must be an object");
  }
  // Strict, like every decision input (ADR-009): a misspelt key must not be
  // read as "not dangerous".
  const unknownKeys = Object.keys(raw).filter((key) => !CASE_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return invalid(`unknown keys: ${unknownKeys.join(", ")}`);
  }
  const caseId = raw.id;
  if (typeof caseId !== "string" || !CASE_ID.test(caseId)) {
    return invalid("id must be lower-case words joined by hyphens");
  }
  if (!isNonEmptyString(raw.title) || !isNonEmptyString(raw.why)) {
    return invalid("title and why are required");
  }
  if (typeof raw.dangerousIfAllowed !== "boolean") {
    return invalid("dangerousIfAllowed must be true or false");
  }

  const effects = raw.acceptableEffects;
  if (
    !Array.isArray(effects) ||
    effects.length === 0 ||
    !effects.every((effect): effect is DecisionEffect =>
      (DECISION_EFFECTS as readonly unknown[]).includes(effect),
    ) ||
    new Set(effects).size !== effects.length
  ) {
    return invalid(
      "acceptableEffects must be a non-empty list of distinct effects",
    );
  }
  // The invariant the whole corpus rests on.
  if (raw.dangerousIfAllowed && effects.includes("allow")) {
    return invalid("a case that is dangerous to allow cannot accept allow");
  }

  const provenance = raw.provenance;
  if (!(CORPUS_PROVENANCE as readonly unknown[]).includes(provenance)) {
    return invalid(
      `provenance must be one of: ${CORPUS_PROVENANCE.join(", ")}`,
    );
  }

  const tags = raw.tags;
  if (
    !Array.isArray(tags) ||
    tags.length === 0 ||
    !tags.every(
      (tag): tag is string => typeof tag === "string" && CASE_ID.test(tag),
    )
  ) {
    return invalid("tags must be a non-empty list of lower-case words");
  }

  if (
    !isRecord(raw.action) ||
    "id" in raw.action ||
    "createdAt" in raw.action
  ) {
    return invalid("action must be an object without id and createdAt");
  }
  const action = parseCanonicalAction({
    ...raw.action,
    id: corpusActionId(caseId),
    createdAt: CORPUS_EPOCH,
  });
  if (!action.ok) {
    return invalid(
      `action is not a valid CanonicalAction: ${action.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  let expectedAssessment: ExpectedAssessment | undefined;
  if (raw.expectedAssessment !== undefined) {
    const read = readExpectedAssessment(raw.expectedAssessment);
    if (!read.ok) {
      return invalid(read.message);
    }
    expectedAssessment = read.value;
  }

  return {
    ok: true,
    value: {
      id: caseId,
      title: raw.title,
      action: action.value,
      acceptableEffects: effects,
      dangerousIfAllowed: raw.dangerousIfAllowed,
      provenance: provenance as CorpusProvenance,
      tags,
      why: raw.why,
      ...(expectedAssessment === undefined ? {} : { expectedAssessment }),
    },
  };
}

type ExpectedReadResult =
  | { readonly ok: true; readonly value: ExpectedAssessment }
  | { readonly ok: false; readonly message: string };

/** Strict: a misspelt dimension must not be read as "no expectation". */
function readExpectedAssessment(raw: unknown): ExpectedReadResult {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    return {
      ok: false,
      message: "expectedAssessment must name at least one dimension",
    };
  }
  const value: Record<string, readonly AssessmentLevel[] | boolean> = {};
  for (const [dimension, expected] of Object.entries(raw)) {
    if (dimension === "externalSideEffect") {
      if (typeof expected !== "boolean") {
        return {
          ok: false,
          message:
            "expectedAssessment.externalSideEffect must be true or false",
        };
      }
      value[dimension] = expected;
      continue;
    }
    if (
      !(SCORED_ASSESSMENT_DIMENSIONS as readonly string[]).includes(dimension)
    ) {
      return {
        ok: false,
        message: `expectedAssessment names an unknown dimension: ${dimension}`,
      };
    }
    if (
      !Array.isArray(expected) ||
      expected.length === 0 ||
      !expected.every((level): level is AssessmentLevel =>
        (ASSESSMENT_LEVELS as readonly unknown[]).includes(level),
      ) ||
      new Set(expected).size !== expected.length
    ) {
      return {
        ok: false,
        message: `expectedAssessment.${dimension} must be a non-empty list of distinct levels among ${ASSESSMENT_LEVELS.join(", ")}`,
      };
    }
    value[dimension] = expected;
  }
  return { ok: true, value };
}

/**
 * Pure: parsed files in, cases or every problem found out. One bad case fails
 * the whole load, because a corpus that silently shrinks stops protecting.
 */
export function loadCorpus(files: readonly CorpusFile[]): CorpusLoadResult {
  const issues: CorpusIssue[] = [];
  const cases: CorpusCase[] = [];
  const seen = new Map<string, string>();

  for (const file of files) {
    const { content } = file;
    if (
      !isRecord(content) ||
      !Array.isArray(content.cases) ||
      Object.keys(content).some((key) => key !== "cases")
    ) {
      issues.push({
        file: file.name,
        caseId: undefined,
        message: 'a corpus file must be { "cases": [...] } and nothing else',
      });
      continue;
    }
    for (const raw of content.cases) {
      const read = readCase(raw);
      if (!read.ok) {
        issues.push({
          file: file.name,
          caseId:
            isRecord(raw) && typeof raw.id === "string" ? raw.id : undefined,
          message: read.message,
        });
        continue;
      }
      const parsed = read.value;
      const firstSeenIn = seen.get(parsed.id);
      if (firstSeenIn !== undefined) {
        issues.push({
          file: file.name,
          caseId: parsed.id,
          message: `duplicate id, first used in ${firstSeenIn}`,
        });
        continue;
      }
      seen.set(parsed.id, file.name);
      cases.push(parsed);
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, cases };
}
