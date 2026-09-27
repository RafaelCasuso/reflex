import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  HOST_INPUT_DEPENDENCIES,
  compareHostSchema,
  declaredInputs,
  type RecordedToolInput,
} from "./host-schema.js";
import { operandsOf } from "./translate.js";

/**
 * RFX-124 — the schema canary: what the adapter reads from the host's tool
 * inputs, compared with a release's declarations. The comparison is tested
 * here on synthetic declarations; the scheduled job runs it against the
 * latest release on npm.
 */
const DECLARATIONS = `
export type ToolInputSchemas = BashInput | FileEditInput;
export interface BashInput {
  /**
   * The command to execute
   */
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
}
export interface FileEditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}
export interface FileReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
}
export interface FileWriteInput {
  file_path: string;
  content: string;
}
export interface NotebookEditInput {
  notebook_path: string;
  cell_id?: string;
  new_source: string;
  cell_type?: "code" | "markdown";
  edit_mode?: "replace" | "insert" | "delete";
}
export interface WebFetchInput {
  url: string;
  prompt: string;
}
export interface EnterPlanModeInput {}
export interface AgentInput {
  description: string;
  options?: {
    file_path: string;
    nested: { deeper: number };
  };
  prompt: string;
}
`;

const FIXTURES = fileURLToPath(
  new URL("../fixtures/claude-code-2.1/", import.meta.url),
);

function recordedFixtures(): RecordedToolInput[] {
  return readdirSync(FIXTURES)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      const payload = JSON.parse(
        readFileSync(`${FIXTURES}${file}`, "utf8"),
      ) as {
        tool_name?: string;
        tool_input?: Record<string, unknown>;
        mcp_server?: unknown;
      };
      return typeof payload.tool_name === "string" &&
        payload.tool_input !== undefined &&
        payload.mcp_server === undefined
        ? [
            {
              name: file,
              toolName: payload.tool_name,
              toolInput: payload.tool_input,
            },
          ]
        : [];
    });
}

describe("RFX-124 reading the declarations", () => {
  it("lists every interface with its own top-level fields, and nothing nested", () => {
    const declared = declaredInputs(DECLARATIONS);
    expect(declared.get("BashInput")).toEqual([
      "command",
      "timeout",
      "description",
      "run_in_background",
    ]);
    expect(declared.get("NotebookEditInput")).toEqual([
      "notebook_path",
      "cell_id",
      "new_source",
      "cell_type",
      "edit_mode",
    ]);
    expect(declared.get("EnterPlanModeInput")).toEqual([]);
    // `file_path` inside `options` is not AgentInput's own field.
    expect(declared.get("AgentInput")).toEqual([
      "description",
      "options",
      "prompt",
    ]);
    expect(declared.has("ToolInputSchemas")).toBe(false);
  });
});

describe("RFX-124 comparing a release with what the adapter reads", () => {
  it("passes on declarations that carry every field the adapter reads", () => {
    const report = compareHostSchema(DECLARATIONS, {
      fixtures: recordedFixtures(),
    });
    expect(report).toEqual({
      ok: true,
      drift: [],
      checked: ["Bash", "Read", "Write", "Edit", "NotebookEdit", "WebFetch"],
      undeclared: ["MultiEdit"],
    });
  });

  it("fails when a field the adapter reads is renamed", () => {
    const renamed = DECLARATIONS.replace(
      "export interface FileWriteInput {\n  file_path: string;",
      "export interface FileWriteInput {\n  path: string;",
    );
    const report = compareHostSchema(renamed);
    expect(report.ok).toBe(false);
    expect(report.drift).toEqual([
      {
        tool: "Write",
        kind: "field-missing",
        detail:
          'FileWriteInput has no top-level field "file_path" (has: path, content)',
      },
    ]);
  });

  // Adversarial: the field still exists, one level down. The adapter reads
  // top-level fields only, so this is drift, not a pass.
  it("fails when the field moves into a nested object", () => {
    const nested = DECLARATIONS.replace(
      "export interface WebFetchInput {\n  url: string;",
      "export interface WebFetchInput {\n  target: {\n    url: string;\n  };",
    );
    const report = compareHostSchema(nested);
    expect(report.drift.map((entry) => entry.kind)).toEqual(["field-missing"]);
  });

  it("fails when an interface the adapter relies on disappears, and tolerates the one it never had", () => {
    const gone = DECLARATIONS.replace(
      /export interface FileReadInput \{[\s\S]*?\n\}\n/,
      "",
    );
    const report = compareHostSchema(gone);
    expect(report.drift).toEqual([
      {
        tool: "Read",
        kind: "interface-missing",
        detail: "FileReadInput is not declared",
      },
    ]);
    expect(report.undeclared).toEqual(["Read", "MultiEdit"]);
  });

  it("fails when a recorded fixture carries a field the release does not declare", () => {
    const report = compareHostSchema(DECLARATIONS, {
      fixtures: [
        {
          name: "pre-tool-use.bash.json",
          toolName: "Bash",
          toolInput: { command: "git status", sandbox: false },
        },
      ],
    });
    expect(report.drift).toEqual([
      {
        tool: "Bash",
        kind: "fixture-field-unknown",
        detail:
          'pre-tool-use.bash.json carries "sandbox", which BashInput does not declare',
      },
    ]);
  });
});

describe("RFX-124 the dependency list is what the adapter actually reads", () => {
  it.each(HOST_INPUT_DEPENDENCIES)(
    "$tool: the operand comes from $fields and from nothing else",
    ({ tool, fields }) => {
      const value = tool === "WebFetch" ? "https://example.test/x" : "/work/a";
      const only = Object.fromEntries(fields.map((field) => [field, value]));
      expect(operandsOf({ name: tool }, only)).toBeDefined();
      const renamed = Object.fromEntries(
        fields.map((field) => [`${field}_renamed`, value]),
      );
      expect(operandsOf({ name: tool }, renamed)).toBeUndefined();
    },
  );

  it("covers every recorded fixture of a built-in tool the adapter reads operands from", () => {
    const read = new Set(HOST_INPUT_DEPENDENCIES.map((entry) => entry.tool));
    for (const fixture of recordedFixtures()) {
      if (!read.has(fixture.toolName)) {
        continue;
      }
      const dependency = HOST_INPUT_DEPENDENCIES.find(
        (entry) => entry.tool === fixture.toolName,
      );
      for (const field of dependency?.fields ?? []) {
        expect(fixture.toolInput, `${fixture.name}.${field}`).toHaveProperty(
          field,
        );
      }
    }
  });
});
