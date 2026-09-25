import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  fixtureFiles,
  fixtureVersions,
  issuesOf,
  loadFixture,
  readFixtureText,
  valueOf,
} from "./fixtures.test-support.js";
import * as contracts from "./index.js";
import {
  CONTRACT_LIMITS,
  CONTRACT_VERSION,
  parseActionOutcome,
  parseCanonicalAction,
  parseDecisionFeedback,
  parseDecisionRecord,
  parseDecisionRequest,
  parseReflexDecision,
  parseSemanticAssessment,
  type ValidationResult,
} from "./index.js";

/**
 * RFX-011 — the compatibility fixture for the versioning policy (ADR-009).
 *
 * Within a major version, REFLEX promises that every payload that was ever
 * valid stays valid. These tests are that promise, executable. When one of
 * them fails, the change under review is a breaking change: either undo it or
 * follow the "breaking change" procedure in ADR-009. Editing the expectation
 * to make the failure go away is how contracts rot.
 */
type Parser = (input: unknown) => ValidationResult<unknown>;

const PARSERS: Readonly<Record<string, Parser>> = {
  "canonical-action": parseCanonicalAction,
  "decision-request": parseDecisionRequest,
  "reflex-decision": parseReflexDecision,
  "semantic-assessment": parseSemanticAssessment,
  "decision-feedback": parseDecisionFeedback,
  "action-outcome": parseActionOutcome,
  "decision-record": parseDecisionRecord,
};

function parserFor(file: string): Parser | undefined {
  const kind = Object.keys(PARSERS).find((prefix) => file.startsWith(prefix));
  return kind === undefined ? undefined : PARSERS[kind];
}

const currentVersion = `v${String(CONTRACT_VERSION.major)}.${String(CONTRACT_VERSION.minor)}`;

describe("RFX-011 contract version", () => {
  it("is major 1, the v1 of /v1/decisions", () => {
    expect(CONTRACT_VERSION.major).toBe(1);
  });

  it("has a frozen fixture set for the current version", () => {
    // Bumping `minor` without freezing fixtures for it fails here.
    expect(fixtureVersions()).toContain(currentVersion);
  });

  it("only has fixture sets for this major, up to the current minor", () => {
    for (const version of fixtureVersions()) {
      const match = /^v(\d+)\.(\d+)$/.exec(version);
      expect(match, `unexpected fixture directory "${version}"`).not.toBeNull();
      expect(Number(match?.[1])).toBe(CONTRACT_VERSION.major);
      expect(Number(match?.[2])).toBeLessThanOrEqual(CONTRACT_VERSION.minor);
    }
  });
});

describe("RFX-011 backward compatibility: old payloads stay valid", () => {
  const payloads = fixtureVersions().flatMap((version) =>
    fixtureFiles(version).flatMap((file) => {
      const parse = parserFor(file);
      return parse === undefined ? [] : [{ version, file, parse }];
    }),
  );

  it("covers every contract that crosses a boundary", () => {
    for (const kind of Object.keys(PARSERS)) {
      expect(
        payloads.some(({ file }) => file.startsWith(kind)),
        `no frozen fixture for ${kind}`,
      ).toBe(true);
    }
  });

  it.each(payloads)(
    "$version/$file still parses, unchanged, with the current contracts",
    ({ version, file, parse }) => {
      const wire = loadFixture(file, version);
      expect(valueOf(parse(wire))).toStrictEqual(wire);
    },
  );
});

describe("RFX-011 frozen fixtures are not edited", () => {
  /**
   * SHA-256 of each released fixture. A released fixture is evidence of what
   * older clients send; rewriting it destroys the evidence. To change the
   * contract, add a new `vMAJOR.MINOR` directory and leave these alone.
   */
  const FROZEN: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    "v1.0": {
      "canonical-action.full.json":
        "09fffb3d041294c4146df1ed0f66d97b7127303a840019f30ca672423b2ebba3",
      "canonical-action.minimal.json":
        "f2db44d14d19b90bd8f8ee20278c1fdf33aa47d9307662bdaa9c1647b0b4b3e8",
      "decision-feedback.full.json":
        "47f4b241fbcfef750b407df12386f8b058d6fdec8d2150a94fb1e62a4f06514a",
      "decision-feedback.minimal.json":
        "90161dd81364a974b154c8adfc2ca190148c0ecc302ce940dc22868b1d583e95",
      "decision-request.full.json":
        "5e4563884a0132b2c68dad92c6b716aab198a715d2084a0f1193229788dae28c",
      "decision-request.minimal.json":
        "ace2d9ca0ba8bc0b28bfc44d255d8d26b7e29a38c34623c5bf24a14563bdcfa3",
      "reflex-decision.full.json":
        "901e4c4da0f7d3bb31ffff22d262542d16ffd534521bb67a30b1dff6fa699afc",
      "reflex-decision.minimal.json":
        "0232b3f7fbb27cd6f491d58cd3a598b0824285a888fc9302050cddcf02c3d1c7",
      "semantic-assessment.json":
        "a832bca12b82a1c5c3a6d35d81bfc7aec0d1c708dbd6ba5f034fa84379e563f9",
      "vocabulary.json":
        "b2df2ca2dcfd6eccba973e4159e70eabdfec477dac537ba9144ffadebff1d5e2",
    },
    "v1.1": {
      "action-outcome.blocked-by-host.json":
        "b8eeb7e6f6fdad5d12dba1de4bfc48925ea5d5fb36dd5ba94761922a631c6faf",
      "action-outcome.executed-without-prompt.json":
        "2f180556d6e4b8af436cad974c8f050822012a0d28102a5fec8d5f03463f1b03",
      "action-outcome.no-signal.json":
        "890d1ef1d2e74c906ee27970813d1ff8bc4190b6d8b2e7e9d5898774000c7862",
      "action-outcome.prompted-approved.json":
        "59d73999ea1ed752709d572b98ba504388e1ba88bbd5ef24a7f56d831dd407f1",
      "action-outcome.prompted-rejected.json":
        "89bd7e8d9990ea802be02a4939ad65da9a32e9b815c7c718e658766550f74455",
      "canonical-action.full.json":
        "09fffb3d041294c4146df1ed0f66d97b7127303a840019f30ca672423b2ebba3",
      "canonical-action.minimal.json":
        "f2db44d14d19b90bd8f8ee20278c1fdf33aa47d9307662bdaa9c1647b0b4b3e8",
      "decision-feedback.full.json":
        "47f4b241fbcfef750b407df12386f8b058d6fdec8d2150a94fb1e62a4f06514a",
      "decision-feedback.minimal.json":
        "90161dd81364a974b154c8adfc2ca190148c0ecc302ce940dc22868b1d583e95",
      "decision-request.full.json":
        "5e4563884a0132b2c68dad92c6b716aab198a715d2084a0f1193229788dae28c",
      "decision-request.minimal.json":
        "ace2d9ca0ba8bc0b28bfc44d255d8d26b7e29a38c34623c5bf24a14563bdcfa3",
      "reflex-decision.full.json":
        "901e4c4da0f7d3bb31ffff22d262542d16ffd534521bb67a30b1dff6fa699afc",
      "reflex-decision.minimal.json":
        "0232b3f7fbb27cd6f491d58cd3a598b0824285a888fc9302050cddcf02c3d1c7",
      "semantic-assessment.json":
        "a832bca12b82a1c5c3a6d35d81bfc7aec0d1c708dbd6ba5f034fa84379e563f9",
      "vocabulary.json":
        "dbc0ea5e0636fb3cde9d85a1d84a7f5135bdc93b3c34083e86b7172431214ca7",
    },
    "v1.2": {
      "action-outcome.blocked-by-host.json":
        "b8eeb7e6f6fdad5d12dba1de4bfc48925ea5d5fb36dd5ba94761922a631c6faf",
      "action-outcome.executed-without-prompt.json":
        "2f180556d6e4b8af436cad974c8f050822012a0d28102a5fec8d5f03463f1b03",
      "action-outcome.no-signal.json":
        "890d1ef1d2e74c906ee27970813d1ff8bc4190b6d8b2e7e9d5898774000c7862",
      "action-outcome.prompted-approved.json":
        "59d73999ea1ed752709d572b98ba504388e1ba88bbd5ef24a7f56d831dd407f1",
      "action-outcome.prompted-rejected.json":
        "89bd7e8d9990ea802be02a4939ad65da9a32e9b815c7c718e658766550f74455",
      "canonical-action.full.json":
        "09fffb3d041294c4146df1ed0f66d97b7127303a840019f30ca672423b2ebba3",
      "canonical-action.minimal.json":
        "f2db44d14d19b90bd8f8ee20278c1fdf33aa47d9307662bdaa9c1647b0b4b3e8",
      "canonical-action.operands-argv.json":
        "3126914b06fe8f92cd1be2ff027e9df7cd548a739392be9f8000fce185995762",
      "canonical-action.operands.json":
        "aa704159bd41621233daab41dc5a693fc8558a7ded77b53b8379c13346814735",
      "decision-feedback.full.json":
        "47f4b241fbcfef750b407df12386f8b058d6fdec8d2150a94fb1e62a4f06514a",
      "decision-feedback.minimal.json":
        "90161dd81364a974b154c8adfc2ca190148c0ecc302ce940dc22868b1d583e95",
      "decision-request.full.json":
        "5e4563884a0132b2c68dad92c6b716aab198a715d2084a0f1193229788dae28c",
      "decision-request.minimal.json":
        "ace2d9ca0ba8bc0b28bfc44d255d8d26b7e29a38c34623c5bf24a14563bdcfa3",
      "reflex-decision.full.json":
        "901e4c4da0f7d3bb31ffff22d262542d16ffd534521bb67a30b1dff6fa699afc",
      "reflex-decision.minimal.json":
        "0232b3f7fbb27cd6f491d58cd3a598b0824285a888fc9302050cddcf02c3d1c7",
      "semantic-assessment.json":
        "a832bca12b82a1c5c3a6d35d81bfc7aec0d1c708dbd6ba5f034fa84379e563f9",
      "vocabulary.json":
        "8c437629d9877455bb41d042af96d0499c4f264aa506122cbaf6b9a67a5b7d81",
    },
    "v1.3": {
      "action-outcome.blocked-by-host.json":
        "b8eeb7e6f6fdad5d12dba1de4bfc48925ea5d5fb36dd5ba94761922a631c6faf",
      "action-outcome.executed-without-prompt.json":
        "2f180556d6e4b8af436cad974c8f050822012a0d28102a5fec8d5f03463f1b03",
      "action-outcome.no-signal.json":
        "890d1ef1d2e74c906ee27970813d1ff8bc4190b6d8b2e7e9d5898774000c7862",
      "action-outcome.prompted-approved.json":
        "59d73999ea1ed752709d572b98ba504388e1ba88bbd5ef24a7f56d831dd407f1",
      "action-outcome.prompted-rejected.json":
        "89bd7e8d9990ea802be02a4939ad65da9a32e9b815c7c718e658766550f74455",
      "canonical-action.full.json":
        "09fffb3d041294c4146df1ed0f66d97b7127303a840019f30ca672423b2ebba3",
      "canonical-action.minimal.json":
        "f2db44d14d19b90bd8f8ee20278c1fdf33aa47d9307662bdaa9c1647b0b4b3e8",
      "canonical-action.operands-argv.json":
        "3126914b06fe8f92cd1be2ff027e9df7cd548a739392be9f8000fce185995762",
      "canonical-action.operands.json":
        "aa704159bd41621233daab41dc5a693fc8558a7ded77b53b8379c13346814735",
      "decision-feedback.full.json":
        "47f4b241fbcfef750b407df12386f8b058d6fdec8d2150a94fb1e62a4f06514a",
      "decision-feedback.minimal.json":
        "90161dd81364a974b154c8adfc2ca190148c0ecc302ce940dc22868b1d583e95",
      "decision-record.deterministic.json":
        "93ef57adb295cfe8686ce12d6716d91fb00f63839a4682f79c2e541f28544c4f",
      "decision-record.full.json":
        "f1faa5e213097638f235a0be41159cdc52da6cd5dce1d5776cfacfbc7d0ad622",
      "decision-record.minimal.json":
        "fa52fc507f74e89646e3de6672e55435208f2090f1fb34a6eb7cfa16cc648fd1",
      "decision-request.full.json":
        "5e4563884a0132b2c68dad92c6b716aab198a715d2084a0f1193229788dae28c",
      "decision-request.minimal.json":
        "ace2d9ca0ba8bc0b28bfc44d255d8d26b7e29a38c34623c5bf24a14563bdcfa3",
      "reflex-decision.full.json":
        "901e4c4da0f7d3bb31ffff22d262542d16ffd534521bb67a30b1dff6fa699afc",
      "reflex-decision.minimal.json":
        "0232b3f7fbb27cd6f491d58cd3a598b0824285a888fc9302050cddcf02c3d1c7",
      "semantic-assessment.json":
        "a832bca12b82a1c5c3a6d35d81bfc7aec0d1c708dbd6ba5f034fa84379e563f9",
      "vocabulary.json":
        "e0470ec9d797f2f59d1d4eb3dbd1d90ca0b4468c0f209a2baa926fd422af680c",
    },
  };

  it("has a checksum entry for every released fixture set", () => {
    expect(Object.keys(FROZEN).sort()).toEqual(fixtureVersions());
  });

  it.each(Object.keys(FROZEN))(
    "%s is byte-identical to its release",
    (version) => {
      const actual = Object.fromEntries(
        fixtureFiles(version).map((file) => [
          file,
          createHash("sha256")
            .update(readFixtureText(version, file))
            .digest("hex"),
        ]),
      );
      expect(actual).toStrictEqual(FROZEN[version]);
    },
  );
});

describe("RFX-011 no new mandatory fields", () => {
  /**
   * The mandatory fields of each contract as of the minor that introduced it
   * (v1.0 unless noted), discovered by parsing `{}`. A field that is mandatory
   * today and was not mandatory at release rejects every older client: that is
   * a breaking change, however small the diff looks.
   */
  const MANDATORY_AT_RELEASE: Readonly<Record<string, readonly string[]>> = {
    "canonical-action": [
      "agent",
      "arguments",
      "createdAt",
      "id",
      "sideEffectClass",
      "tool",
    ],
    "decision-request": ["action", "failureMode", "mode"],
    "reflex-decision": [
      "actionId",
      "cached",
      "confidence",
      "decidedAt",
      "effect",
      "effectiveEffect",
      "id",
      "latency",
      "mode",
      "policyMatches",
      "reasonCodes",
      "risk",
    ],
    "semantic-assessment": [
      "destructiveRisk",
      "externalSideEffect",
      "financialConsequence",
      "latencyMs",
      "objectiveAlignment",
      "privilegeEscalation",
      "productionMutation",
      "provider",
      "reversibility",
      "secretAccess",
      "sensitiveDataExposure",
      "untrustedInput",
      "unusualScope",
    ],
    "decision-feedback": ["createdAt", "decisionId", "value"],
    // Introduced in v1.1 (ADR-013).
    "action-outcome": [
      "actionId",
      "executed",
      "humanResponse",
      "observedAt",
      "prompted",
    ],
    // Introduced in v1.3 (ADR-016 §4).
    "decision-record": [
      "actionId",
      "contractVersion",
      "decision",
      "decisionId",
      "evaluations",
      "labels",
      "recordedAt",
    ],
  };

  it.each(Object.entries(PARSERS))(
    "%s requires exactly what it required at release",
    (kind, parse) => {
      const mandatory = issuesOf(parse({}))
        .filter((issue) => issue.code === "missing_field")
        .map((issue) => issue.path)
        .sort();
      expect(mandatory).toEqual(MANDATORY_AT_RELEASE[kind]);
    },
  );

  it("still accepts the minimal v1.0 payloads, which carry nothing optional", () => {
    for (const file of fixtureFiles("v1.0").filter((name) =>
      name.includes(".minimal."),
    )) {
      const parse = parserFor(file);
      expect(parse?.(loadFixture(file, "v1.0")).ok, file).toBe(true);
    }
  });
});

describe("RFX-011 vocabulary only grows", () => {
  const current: Readonly<Record<string, readonly string[]>> = {
    DECISION_EFFECTS: contracts.DECISION_EFFECTS,
    REFLEX_MODES: contracts.REFLEX_MODES,
    FAILURE_MODES: contracts.FAILURE_MODES,
    HOST_KINDS: contracts.HOST_KINDS,
    ENVIRONMENT_KINDS: contracts.ENVIRONMENT_KINDS,
    SIDE_EFFECT_CLASSES: contracts.SIDE_EFFECT_CLASSES,
    REASON_CODES: contracts.REASON_CODES,
    FALLBACK_REASONS: contracts.FALLBACK_REASONS,
    POLICY_OPERATORS: contracts.POLICY_OPERATORS,
    DECISION_FEEDBACK_VALUES: contracts.DECISION_FEEDBACK_VALUES,
    VALIDATION_ISSUE_CODES: contracts.VALIDATION_ISSUE_CODES,
    ID_PREFIXES: Object.values(contracts.ID_PREFIXES),
    OBSERVATION_STATES: contracts.OBSERVATION_STATES,
    HUMAN_RESPONSES: contracts.HUMAN_RESPONSES,
    LABEL_SOURCES: contracts.LABEL_SOURCES,
    EVALUATION_ROLES: contracts.EVALUATION_ROLES,
    PROVIDER_ERROR_KINDS: contracts.PROVIDER_ERROR_KINDS,
    ASSESSMENT_DIMENSIONS: contracts.ASSESSMENT_DIMENSIONS,
  };

  const released = fixtureVersions().map((version) => ({
    version,
    vocabulary: loadFixture("vocabulary.json", version) as Record<
      string,
      readonly string[]
    >,
  }));

  it("tracks every closed set the contracts export", () => {
    const latest = released.at(-1);
    expect(latest?.version).toBe(currentVersion);
    expect(Object.keys(current).sort()).toEqual(
      Object.keys(latest?.vocabulary ?? {}).sort(),
    );
  });

  it("never drops a set that an earlier minor released", () => {
    for (const { version, vocabulary } of released) {
      for (const name of Object.keys(vocabulary)) {
        expect(current, `${version} released ${name}`).toHaveProperty([name]);
      }
    }
  });

  const members = released.flatMap(({ version, vocabulary }) =>
    Object.entries(vocabulary).map(([name, frozen]) => ({
      version,
      name,
      frozen,
    })),
  );

  it.each(members)("$name keeps every $version member", ({ name, frozen }) => {
    expect(current[name]).toEqual(expect.arrayContaining([...frozen]));
  });

  // These three sets are the decision semantics. They do not grow within a
  // major version either: a fourth effect is a new product, not a new minor.
  const v1_0 = released[0]?.vocabulary ?? {};
  it.each(["DECISION_EFFECTS", "REFLEX_MODES", "FAILURE_MODES"])(
    "%s is closed for the whole major version",
    (name) => {
      expect(current[name]).toEqual(v1_0[name]);
    },
  );
});

describe("RFX-011 limits only loosen", () => {
  // Each limit at the value it was released with, under the minor that
  // released it. Every limit of the contract has to appear here.
  const LIMITS_AT_RELEASE: Readonly<
    Record<keyof typeof CONTRACT_LIMITS, number>
  > = {
    // v1.0
    nameLength: 256,
    textLength: 8_192,
    pathLength: 4_096,
    hashLength: 256,
    priorActions: 100,
    policyMatches: 256,
    reasonCodes: 64,
    jsonDepth: 64,
    jsonNodes: 100_000,
    // v1.2 (ADR-011)
    commandLength: 1_048_576,
    operandItems: 1_024,
    // v1.3 (ADR-016 §4)
    recordEvaluations: 16,
    recordLabels: 256,
    recordFeedback: 64,
  };

  it.each(Object.entries(LIMITS_AT_RELEASE))(
    "%s is at least the value it was released with",
    (name, released) => {
      expect(
        CONTRACT_LIMITS[name as keyof typeof CONTRACT_LIMITS],
      ).toBeGreaterThanOrEqual(released);
    },
  );
});

describe("RFX-011 public surface", () => {
  /**
   * Runtime exports. Removing or renaming one breaks every consumer. Adding
   * one is fine: append it here in the same change, under its minor.
   */
  const EXPORTS = [
    // v1.0
    "CONTRACT_LIMITS",
    "CONTRACT_VERSION",
    "DECISION_EFFECTS",
    "DECISION_FEEDBACK_VALUES",
    "ENVIRONMENT_KINDS",
    "FAILURE_MODES",
    "FALLBACK_REASONS",
    "HOST_KINDS",
    "ID_BODY_MAX_LENGTH",
    "ID_PREFIXES",
    "MAX_VALIDATION_ISSUES",
    "POLICY_OPERATORS",
    "REASON_CODES",
    "REFLEX_MODES",
    "SIDE_EFFECT_CLASSES",
    "VALIDATION_ISSUE_CODES",
    "isOpaqueId",
    "parseCanonicalAction",
    "parseDecisionFeedback",
    "parseDecisionRequest",
    "parseReflexDecision",
    "parseSemanticAssessment",
    "resolveEnvironment",
    // v1.1 (ADR-013)
    "HUMAN_RESPONSES",
    "OBSERVATION_STATES",
    "parseActionOutcome",
    // v1.3 (ADR-016 §4)
    "ASSESSMENT_DIMENSIONS",
    "EVALUATION_ROLES",
    "LABEL_SOURCES",
    "PROVIDER_ERROR_KINDS",
    "parseDecisionRecord",
  ];

  it("still exports everything it ever exported", () => {
    expect(Object.keys(contracts)).toEqual(expect.arrayContaining(EXPORTS));
  });

  it("exports nothing that is not listed here", () => {
    // Keeps the surface deliberate: an accidental export becomes a promise.
    expect(Object.keys(contracts).sort()).toEqual([...EXPORTS].sort());
  });

  it("keeps the validation library out of every public module", () => {
    // Public modules are the specification. Only `internal/` may import the
    // validation library, so a consumer that imports types from this package
    // never loads that library's (heavy) declarations.
    const sourceDir = fileURLToPath(new URL("./", import.meta.url));
    const publicModules = readdirSync(sourceDir).filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        !file.endsWith(".test-support.ts") &&
        !file.endsWith(".bench.ts"),
    );

    expect(publicModules).toContain("parse.ts");
    for (const file of publicModules) {
      const source = readFileSync(`${sourceDir}${file}`, "utf8");
      expect(source, `${file} imports zod`).not.toMatch(/from\s+["']zod["']/);
    }
  });

  it("does not expose the validation library", () => {
    const looksLikeSchema = (value: unknown): boolean =>
      typeof value === "object" && value !== null && "safeParse" in value;

    for (const [name, value] of Object.entries(contracts)) {
      expect(name.toLowerCase(), name).not.toContain("schema");
      expect(looksLikeSchema(value), `${name} looks like a Zod schema`).toBe(
        false,
      );
    }
  });
});

describe("RFX-011 direction of tolerance", () => {
  const extra = { addedInALaterMinor: true };

  it.each([
    ["CanonicalAction", parseCanonicalAction, "canonical-action.full.json"],
    ["DecisionRequest", parseDecisionRequest, "decision-request.full.json"],
    ["SemanticAssessment", parseSemanticAssessment, "semantic-assessment.json"],
    ["DecisionFeedback", parseDecisionFeedback, "decision-feedback.full.json"],
    [
      "ActionOutcome",
      parseActionOutcome,
      "action-outcome.prompted-approved.json",
    ],
    ["DecisionRecord", parseDecisionRecord, "decision-record.full.json"],
  ] as const)(
    "%s is an input to a decision: an unknown field is rejected",
    (_name, parse, file) => {
      expect(parse({ ...loadFixture(file, currentVersion), ...extra }).ok).toBe(
        false,
      );
    },
  );

  it("ReflexDecision is an output: an unknown field is ignored", () => {
    const wire = loadFixture("reflex-decision.full.json");
    expect(valueOf(parseReflexDecision({ ...wire, ...extra }))).toStrictEqual(
      wire,
    );
  });
});
