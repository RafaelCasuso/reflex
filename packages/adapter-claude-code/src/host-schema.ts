/**
 * RFX-124 — the host hook schema canary.
 *
 * The adapter reads a handful of fields from the host's tool inputs
 * (`translate.ts`). Their names come from `sdk-tools.d.ts`, the type
 * declarations shipped inside `@anthropic-ai/claude-code`, and the host
 * releases outside REFLEX's cycle. This module says which fields the adapter
 * depends on and compares them with a release's declarations; the scheduled
 * job (`live/check-host-schema.mjs`, `.github/workflows/host-schema.yml`)
 * runs it against the latest release on npm and fails on drift. Pure: the
 * text of the declarations in, a report out.
 *
 * What it cannot see: the hook envelope (`hook_event_name`, `tool_name`,
 * `tool_input`, `cwd`...) is not declared in that file. At run time a payload
 * the adapter does not recognize is a typed failure (`hook-input.ts`), and
 * the live runs of RFX-087 and RFX-089 are the evidence for the envelope.
 */
export interface HostInputDependency {
  /** The host's tool name, as `tool_name` carries it. */
  readonly tool: string;
  /** The interface `sdk-tools.d.ts` declares its input under. */
  readonly declaredAs: string;
  /** The top-level fields the adapter reads. */
  readonly fields: readonly string[];
  /**
   * The adapter still translates a tool no checked release declares
   * (`MultiEdit`: absent from 2.1.276 and later). Its absence is not
   * drift; a return with other field names is.
   */
  readonly expectDeclared: boolean;
}

export const HOST_INPUT_DEPENDENCIES: readonly HostInputDependency[] = [
  {
    tool: "Bash",
    declaredAs: "BashInput",
    fields: ["command"],
    expectDeclared: true,
  },
  {
    tool: "Read",
    declaredAs: "FileReadInput",
    fields: ["file_path"],
    expectDeclared: true,
  },
  {
    tool: "Write",
    declaredAs: "FileWriteInput",
    fields: ["file_path"],
    expectDeclared: true,
  },
  {
    tool: "Edit",
    declaredAs: "FileEditInput",
    fields: ["file_path"],
    expectDeclared: true,
  },
  {
    tool: "MultiEdit",
    declaredAs: "FileMultiEditInput",
    fields: ["file_path"],
    expectDeclared: false,
  },
  {
    tool: "NotebookEdit",
    declaredAs: "NotebookEditInput",
    fields: ["notebook_path"],
    expectDeclared: true,
  },
  {
    tool: "WebFetch",
    declaredAs: "WebFetchInput",
    fields: ["url"],
    expectDeclared: true,
  },
];

/**
 * Every exported interface of the declarations with its top-level field
 * names. Fields of nested object types are not the interface's own and are
 * left out, so that a field moved into a sub-object reads as missing.
 */
export function declaredInputs(
  declarations: string,
): ReadonlyMap<string, readonly string[]> {
  const interfaces = new Map<string, readonly string[]>();
  const lines = declarations.replaceAll("\r\n", "\n").split("\n");
  let current: string | undefined;
  let fields: string[] = [];
  let depth = 0;
  for (const line of lines) {
    if (current === undefined) {
      const opened =
        /^export interface (\w+)(?:<[^>]*>)?(?: extends [^{]+)? \{\s*$/.exec(
          line,
        );
      if (opened !== null) {
        current = opened[1];
        fields = [];
        depth = 1;
      } else {
        const empty = /^export interface (\w+)(?:<[^>]*>)? \{\}$/.exec(line);
        if (empty?.[1] !== undefined) {
          interfaces.set(empty[1], []);
        }
      }
      continue;
    }
    if (depth === 1) {
      const field = /^ {2}(?:readonly )?(\w+|"[^"]+")\??\s*:/.exec(line);
      if (field?.[1] !== undefined) {
        fields.push(field[1].replaceAll('"', ""));
      }
    }
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    if (depth <= 0) {
      interfaces.set(current, fields);
      current = undefined;
    }
  }
  return interfaces;
}

export type HostSchemaDriftKind =
  /** The interface the adapter relies on is no longer declared. */
  | "interface-missing"
  /** A field the adapter reads is no longer a top-level field of it. */
  | "field-missing"
  /** A recorded fixture carries a field the release does not declare. */
  | "fixture-field-unknown";

export interface HostSchemaDrift {
  readonly tool: string;
  readonly kind: HostSchemaDriftKind;
  readonly detail: string;
}

export interface HostSchemaReport {
  readonly ok: boolean;
  readonly drift: readonly HostSchemaDrift[];
  /** Tools whose declaration was found and checked. */
  readonly checked: readonly string[];
  /** Tools the adapter translates that this release does not declare. */
  readonly undeclared: readonly string[];
}

export interface RecordedToolInput {
  /** The fixture's name, for the report. */
  readonly name: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
}

export function compareHostSchema(
  declarations: string,
  options: {
    readonly dependencies?: readonly HostInputDependency[];
    readonly fixtures?: readonly RecordedToolInput[];
  } = {},
): HostSchemaReport {
  const declared = declaredInputs(declarations);
  const dependencies = options.dependencies ?? HOST_INPUT_DEPENDENCIES;
  const drift: HostSchemaDrift[] = [];
  const checked: string[] = [];
  const undeclared: string[] = [];

  for (const dependency of dependencies) {
    const fields = declared.get(dependency.declaredAs);
    if (fields === undefined) {
      undeclared.push(dependency.tool);
      if (dependency.expectDeclared) {
        drift.push({
          tool: dependency.tool,
          kind: "interface-missing",
          detail: `${dependency.declaredAs} is not declared`,
        });
      }
      continue;
    }
    checked.push(dependency.tool);
    for (const field of dependency.fields) {
      if (!fields.includes(field)) {
        drift.push({
          tool: dependency.tool,
          kind: "field-missing",
          detail: `${dependency.declaredAs} has no top-level field "${field}" (has: ${fields.length === 0 ? "none" : fields.join(", ")})`,
        });
      }
    }
  }

  // The recorded payloads against the release: a fixture that carries a
  // field the release does not declare is a fixture of another schema.
  for (const fixture of options.fixtures ?? []) {
    const dependency = dependencies.find(
      (entry) => entry.tool === fixture.toolName,
    );
    const fields =
      dependency === undefined
        ? undefined
        : declared.get(dependency.declaredAs);
    if (fields === undefined) {
      continue;
    }
    for (const key of Object.keys(fixture.toolInput)) {
      if (!fields.includes(key)) {
        drift.push({
          tool: fixture.toolName,
          kind: "fixture-field-unknown",
          detail: `${fixture.name} carries "${key}", which ${dependency?.declaredAs ?? "the release"} does not declare`,
        });
      }
    }
  }

  return { ok: drift.length === 0, drift, checked, undeclared };
}
