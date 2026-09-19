/**
 * The shape of tool arguments: keys, types and sizes, never values.
 *
 * Until the redactor exists (RFX-031) nothing derived from an argument value
 * may be written to disk. A shape is enough to see which tools an agent uses
 * and how, and to check the canonical model against real payloads (RFX-089).
 *
 * Key names are recorded only when they look like schema identifiers, and
 * only near the top of the structure, where tool schemas define them. A key
 * that looks like data (an email address, a path, a sentence, a token) is
 * counted, not written: maps keyed by user data are common, and a key is a
 * value too. The test is deliberately narrow. A real field name that fails it
 * costs one name in a diagnostic; a token that passes it is a leak.
 */
export type ArgumentShape =
  | { readonly type: "string"; readonly length: number }
  | { readonly type: "number" }
  | { readonly type: "boolean" }
  | { readonly type: "null" }
  | {
      readonly type: "array";
      readonly length: number;
      /** Shape of the first item only. */
      readonly items?: ArgumentShape;
    }
  | {
      readonly type: "object";
      readonly keys: Readonly<Record<string, ArgumentShape>>;
      /** Keys not written: data-like names, or beyond the per-object limit. */
      readonly otherKeys: number;
    }
  /** Deeper than the depth limit. */
  | { readonly type: "truncated" }
  /** Not a JSON value: undefined, function, symbol, bigint, class instance. */
  | { readonly type: "unsupported" };

export interface ShapeLimits {
  readonly maxDepth: number;
  readonly maxKeysPerObject: number;
  /** Object nesting levels, from the root, whose key names are written. */
  readonly maxNamedLevels: number;
}

export const DEFAULT_SHAPE_LIMITS: ShapeLimits = {
  maxDepth: 4,
  maxKeysPerObject: 32,
  maxNamedLevels: 2,
};

/** snake_case or camelCase, short, and not digit-heavy like a token. */
const SCHEMA_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const MAX_DIGITS_IN_KEY = 3;

function looksLikeSchemaKey(key: string): boolean {
  return (
    SCHEMA_KEY.test(key) &&
    key.replace(/[^0-9]/g, "").length <= MAX_DIGITS_IN_KEY
  );
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function describeShape(
  value: unknown,
  limits: ShapeLimits = DEFAULT_SHAPE_LIMITS,
  depth = 0,
  objectLevel = 0,
): ArgumentShape {
  switch (typeof value) {
    case "string":
      return { type: "string", length: value.length };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "object":
      break;
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      return { type: "unsupported" };
  }

  if (value === null) {
    return { type: "null" };
  }
  if (depth >= limits.maxDepth) {
    return { type: "truncated" };
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.length === 0
      ? { type: "array", length: 0 }
      : {
          type: "array",
          length: items.length,
          items: describeShape(items[0], limits, depth + 1, objectLevel),
        };
  }
  if (!isPlainObject(value)) {
    return { type: "unsupported" };
  }

  const keys: Record<string, ArgumentShape> = {};
  let otherKeys = 0;
  let written = 0;
  const named = objectLevel < limits.maxNamedLevels;
  for (const key of Object.keys(value)) {
    if (
      !named ||
      written >= limits.maxKeysPerObject ||
      !looksLikeSchemaKey(key)
    ) {
      otherKeys += 1;
      continue;
    }
    // `__proto__` passes the identifier test; assigning it would set the
    // prototype of `keys` instead of adding a key.
    Object.defineProperty(keys, key, {
      value: describeShape(value[key], limits, depth + 1, objectLevel + 1),
      enumerable: true,
    });
    written += 1;
  }
  return { type: "object", keys, otherKeys };
}
