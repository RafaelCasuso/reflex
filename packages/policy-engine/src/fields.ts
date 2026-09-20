import {
  ENVIRONMENT_KINDS,
  HOST_KINDS,
  SIDE_EFFECT_CLASSES,
} from "@reflex/contracts";

/**
 * What a policy rule can be written about (ADR-011).
 *
 * The list is closed on purpose. A rule that names a field nobody fills can
 * never match, and for a deny rule that is a silent weakening, so an unknown
 * field is a compile error and not a rule that quietly does nothing.
 *
 * A field is either single-valued or **multi-valued**: one action can touch
 * several paths. How a condition reads several values depends on the rule's
 * effect, never on the author's luck (ADR-011, asymmetric matching): in a
 * `deny` or `ask` rule one value is enough, in an `allow` rule every value has
 * to satisfy it.
 */
export type FieldKind = "text" | "enum";

export interface FieldSpec {
  readonly name: string;
  readonly kind: FieldKind;
  /** For `enum` fields: the only values a rule may compare against. */
  readonly values?: readonly string[];
  readonly multi: boolean;
  readonly description: string;
}

export const POLICY_FIELDS: readonly FieldSpec[] = [
  {
    name: "tool.name",
    kind: "text",
    multi: false,
    description: "The tool's name as the host reports it, without a namespace.",
  },
  {
    name: "tool.namespace",
    kind: "text",
    multi: false,
    description:
      "The MCP server a tool belongs to. Absent for a host's built-in tools.",
  },
  {
    name: "agent.host",
    kind: "enum",
    values: HOST_KINDS,
    multi: false,
    description: "The host that runs the agent.",
  },
  {
    name: "sideEffectClass",
    kind: "enum",
    values: SIDE_EFFECT_CLASSES,
    multi: false,
    description:
      "The side-effect class after classification. It can be raised by a later stage and is never lowered.",
  },
  {
    name: "environment",
    kind: "enum",
    values: ENVIRONMENT_KINDS,
    multi: false,
    description:
      "The environment the action touches, resolved by the contract.",
  },
  {
    name: "repository.branch",
    kind: "text",
    multi: false,
    description: "The checked-out branch, when the adapter knows it.",
  },
  {
    name: "command.name",
    kind: "text",
    multi: false,
    description:
      "The program a shell segment runs, without its directory: `/bin/rm` is `rm`.",
  },
  {
    name: "command.args",
    kind: "text",
    multi: true,
    description: "Each argument of a shell segment, after the shell's quoting.",
  },
  {
    name: "command.text",
    kind: "text",
    multi: false,
    description:
      "A shell segment as normalized text: the program name and its arguments, joined by single spaces.",
  },
  {
    name: "path",
    kind: "text",
    multi: true,
    description:
      "Each file-system path the action touches, absolute and lexically normalized.",
  },
  {
    name: "network.host",
    kind: "text",
    multi: true,
    description: "Each network host the action contacts, lower-cased.",
  },
];

const BY_NAME = new Map(POLICY_FIELDS.map((field) => [field.name, field]));

/**
 * `arguments.<key>` reads the host's own arguments. It is host-shaped, which
 * is what ADR-011 exists to avoid, and it stays for tools that have no
 * canonical operands at all, such as an MCP tool's arguments.
 */
export const RAW_ARGUMENTS_PREFIX = "arguments.";
const RAW_ARGUMENT_PATH = /^arguments(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63}){1,8}$/;

export function fieldSpec(name: string): FieldSpec | undefined {
  const known = BY_NAME.get(name);
  if (known !== undefined) {
    return known;
  }
  if (RAW_ARGUMENT_PATH.test(name)) {
    return {
      name,
      kind: "text",
      multi: false,
      description: "A value inside the host's own arguments.",
    };
  }
  return undefined;
}

export function addressableFieldNames(): readonly string[] {
  return [...BY_NAME.keys(), `${RAW_ARGUMENTS_PREFIX}<key>`];
}
