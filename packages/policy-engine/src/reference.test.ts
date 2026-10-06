import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ENVIRONMENT_KINDS,
  HOST_KINDS,
  POLICY_OPERATORS,
  type CanonicalAction,
  type EnvironmentKind,
  type HostKind,
} from "@reflex-control/contracts";
import { describe, expect, it } from "vitest";

import { CONTEXT, fileTool, mcp, shell } from "./engine.test-support.js";
import {
  compilePolicySet,
  evaluatePolicy,
  type PolicySourceDocument,
} from "./evaluator.js";
import { POLICY_FIELDS } from "./fields.js";
import { parsePolicy } from "./parser.js";
import { POLICY_SOURCES, type PolicySource } from "./precedence.js";

/**
 * RFX-100 — the policy language reference cannot drift from the engine.
 *
 * `docs/policy-language.md` holds policies and, after each, what they decide.
 * This suite runs every one of them, and checks that every operator and every
 * addressable field appears in an example that was run.
 */
const REFERENCE = readFileSync(
  fileURLToPath(new URL("../../../docs/policy-language.md", import.meta.url)),
  "utf8",
);

interface Example {
  readonly sources: PolicySourceDocument[];
  readonly yaml: string[];
  readonly expectations: string[];
}

const examples = new Map<string, Example>();
for (const [, language, body] of REFERENCE.matchAll(
  /^```(yaml|text)\n([\s\S]*?)^```$/gm,
)) {
  if (body === undefined) {
    continue;
  }
  const header = /^# (example|expect): (\S+)$/m.exec(body);
  if (header?.[2] === undefined) {
    continue;
  }
  const example = examples.get(header[2]) ?? {
    sources: [],
    yaml: [],
    expectations: [],
  };
  examples.set(header[2], example);

  if (language === "text") {
    example.expectations.push(
      ...body
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#")),
    );
    continue;
  }
  const source = (/^# source: (\S+)$/m.exec(body)?.[1] ??
    "local") as PolicySource;
  const trusted = /^# trusted: false$/m.exec(body) === null;
  // RFX-084: an `environment` source names the environment it applies to.
  const environment = /^# environment: (\S+)$/m.exec(body)?.[1];
  const parsed = parsePolicy(body);
  if (!parsed.ok) {
    throw new Error(
      `example ${header[2]} does not parse: ${parsed.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  expect(POLICY_SOURCES).toContain(source);
  if (environment !== undefined) {
    expect(ENVIRONMENT_KINDS).toContain(environment);
  }
  example.sources.push({
    source,
    trusted,
    ...(environment === undefined
      ? {}
      : { environment: environment as EnvironmentKind }),
    document: parsed.document,
  });
  example.yaml.push(body);
}

/** `Bash: git status [environment=production branch=main host=codex]` */
function actionOf(line: string): CanonicalAction {
  const options = /\s\[([^\]]+)\]$/.exec(line);
  const head = options === null ? line : line.slice(0, options.index);
  const separator = head.indexOf(": ");
  const tool = head.slice(0, separator);
  const argument = head.slice(separator + 2).trim();

  let action: CanonicalAction;
  if (tool === "Bash") {
    action = shell(argument);
  } else if (tool === "mcp") {
    const match = /^([^/\s]+)\/(\S+)\s+(\{.*\})$/.exec(argument);
    if (
      match?.[1] === undefined ||
      match[2] === undefined ||
      match[3] === undefined
    ) {
      throw new Error(`cannot read the MCP call in: ${line}`);
    }
    action = mcp(
      match[1],
      match[2],
      JSON.parse(match[3]) as Record<string, unknown>,
    );
  } else {
    action = fileTool(tool, argument);
  }

  for (const option of options?.[1]?.split(/\s+/) ?? []) {
    const [key, value] = option.split("=");
    if (
      key === "environment" &&
      (ENVIRONMENT_KINDS as readonly string[]).includes(value ?? "")
    ) {
      action = {
        ...action,
        resource: { environment: value as EnvironmentKind },
      };
    } else if (key === "branch" && value !== undefined) {
      action = {
        ...action,
        repository: { ...action.repository, branch: value },
      };
    } else if (
      key === "host" &&
      (HOST_KINDS as readonly string[]).includes(value ?? "")
    ) {
      action = { ...action, agent: { host: value as HostKind } };
    } else {
      throw new Error(`unknown option ${option} in: ${line}`);
    }
  }
  return action;
}

describe("RFX-100 policy language reference", () => {
  it("holds examples, and every one of them says what it decides", () => {
    expect(examples.size).toBeGreaterThanOrEqual(8);
    for (const [id, example] of examples) {
      expect(example.sources.length, `${id} has no policy`).toBeGreaterThan(0);
      expect(
        example.expectations.length,
        `${id} has no expectations`,
      ).toBeGreaterThan(0);
    }
  });

  describe.each([...examples])("example %s", (_id, example) => {
    const compiled = compilePolicySet(example.sources);
    if (!compiled.ok) {
      throw new Error(compiled.problems.join("; "));
    }

    it.each(example.expectations)("%s", (line) => {
      const arrow = line.lastIndexOf("=>");
      expect(arrow, `no "=>" in: ${line}`).toBeGreaterThan(0);
      const expected = line.slice(arrow + 2).trim();
      const { evaluation } = evaluatePolicy(
        compiled.set,
        actionOf(line.slice(0, arrow).trim()),
        CONTEXT,
      );
      expect(evaluation.effect ?? "unresolved").toBe(expected);
    });
  });

  // The acceptance: every operator and every addressable field is documented
  // with an example that is executed.
  const executed = [...examples.values()]
    .flatMap((example) => example.yaml)
    .join("\n");

  it.each(POLICY_OPERATORS)(
    "runs an example of the operator %s",
    (operator) => {
      expect(executed).toContain(`operator: ${operator}`);
      expect(REFERENCE).toContain(`| \`${operator}\``);
    },
  );

  it.each(["any_of", "not"])("runs an example of %s", (keyword) => {
    expect(executed).toMatch(new RegExp(`(^|[\\s{-])${keyword}:`, "m"));
  });

  it.each([...POLICY_FIELDS.map((field) => field.name), "arguments."])(
    "runs an example of the field %s",
    (field) => {
      expect(executed).toContain(`field: ${field}`);
      expect(REFERENCE).toContain(`| \`${field}`);
    },
  );

  it("documents every value of the closed sets a rule can compare against", () => {
    for (const field of POLICY_FIELDS) {
      for (const value of field.values ?? []) {
        expect(REFERENCE, `${field.name}: ${value}`).toContain(`\`${value}\``);
      }
    }
  });

  it("states the limits the parser really has", () => {
    for (const figure of [
      "256 KiB",
      "2,000 rules",
      "64 conditions",
      "1,024 values",
      "1,024 characters",
      "128 instructions",
      "4,096 characters",
    ]) {
      expect(REFERENCE, figure).toContain(figure);
    }
  });
});
