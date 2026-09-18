import { CONTRACT_LIMITS } from "../limits.js";

/**
 * Bounded structural check for the two untyped bags in the canonical action:
 * `arguments` and `adapterMetadata`.
 *
 * Both are attacker-influenced and sit on the hot path, which rules out a
 * recursive validator: a nesting bomb must not overflow the stack, a cyclic
 * in-process object must not loop forever, and a large payload must cost one
 * linear pass. The walk is iterative, bounded in depth and in node count, and
 * allocates nothing per value on the success path.
 */
export type JsonViolationReason =
  | "not_plain_object"
  | "unsupported_value"
  | "non_finite_number"
  | "too_deep"
  | "too_large";

export interface JsonViolation {
  readonly path: readonly (string | number)[];
  readonly reason: JsonViolationReason;
}

export interface JsonLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
}

const DEFAULT_LIMITS: JsonLimits = {
  maxDepth: CONTRACT_LIMITS.jsonDepth,
  maxNodes: CONTRACT_LIMITS.jsonNodes,
};

interface Frame {
  readonly container: Readonly<Record<string, unknown>> | readonly unknown[];
  /** Own enumerable keys for objects; `undefined` for arrays. */
  readonly keys: readonly string[] | undefined;
  readonly size: number;
  /** Index of the next child to visit. */
  next: number;
}

export function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function frameOf(
  container: Readonly<Record<string, unknown>> | readonly unknown[],
): Frame {
  if (Array.isArray(container)) {
    return { container, keys: undefined, size: container.length, next: 0 };
  }
  const keys = Object.keys(container);
  return { container, keys, size: keys.length, next: 0 };
}

/** Rebuilt from the stack only when something is wrong. */
function pathOf(stack: readonly Frame[]): (string | number)[] {
  return stack.map((frame) => {
    const index = frame.next - 1;
    return frame.keys?.[index] ?? index;
  });
}

/**
 * Returns the first violation, or `undefined` when `root` is a plain JSON
 * object within limits.
 */
export function findJsonViolation(
  root: unknown,
  limits: JsonLimits = DEFAULT_LIMITS,
): JsonViolation | undefined {
  if (!isPlainObject(root)) {
    return { path: [], reason: "not_plain_object" };
  }

  const stack: Frame[] = [frameOf(root)];
  let nodes = 1;

  for (;;) {
    const frame = stack.at(-1);
    if (frame === undefined) {
      return undefined;
    }
    if (frame.next >= frame.size) {
      stack.pop();
      continue;
    }

    const index = frame.next;
    frame.next += 1;
    const value: unknown =
      frame.keys === undefined
        ? (frame.container as readonly unknown[])[index]
        : (frame.container as Readonly<Record<string, unknown>>)[
            frame.keys[index] ?? ""
          ];

    nodes += 1;
    if (nodes > limits.maxNodes) {
      return { path: pathOf(stack), reason: "too_large" };
    }

    switch (typeof value) {
      case "string":
      case "boolean":
        continue;
      case "number":
        if (!Number.isFinite(value)) {
          return { path: pathOf(stack), reason: "non_finite_number" };
        }
        continue;
      case "object": {
        if (value === null) {
          continue;
        }
        const container: Frame["container"] | undefined = Array.isArray(value)
          ? (value as readonly unknown[])
          : isPlainObject(value)
            ? value
            : undefined;
        if (container === undefined) {
          // Date, Map, Set, class instances: not representable in JSON.
          return { path: pathOf(stack), reason: "unsupported_value" };
        }
        // A cycle is an infinitely deep structure: the depth bound ends it.
        if (stack.length >= limits.maxDepth) {
          return { path: pathOf(stack), reason: "too_deep" };
        }
        stack.push(frameOf(container));
        continue;
      }
      case "undefined":
      case "function":
      case "symbol":
      case "bigint":
        // Includes array holes. JSON would drop or rewrite these silently.
        return { path: pathOf(stack), reason: "unsupported_value" };
    }
  }
}
