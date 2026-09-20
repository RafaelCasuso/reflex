/**
 * RFX-097 — path normalization and containment.
 *
 * Lexical on purpose (ADR-011): no symlink is resolved and the disk is never
 * read, so the engine stays pure. What a path really points to is for the
 * component that has a file system.
 */
export interface PathContext {
  /** Relative paths are resolved against this. Without it they are unknown. */
  readonly cwd?: string;
  /** What `~` and `${home}` stand for. */
  readonly home?: string;
  /** What `${project}` stands for. */
  readonly projectRoot?: string;
}

/**
 * An absolute path with `.`, `..`, repeated and trailing separators removed,
 * or `undefined` when it cannot be made absolute. `..` never climbs above the
 * root: `/../etc` is `/etc`, as it is for the operating system.
 */
export function normalizePath(
  path: string,
  context: PathContext,
): string | undefined {
  let absolute: string;
  if (path === "~" || path.startsWith("~/")) {
    if (context.home === undefined) {
      return undefined;
    }
    absolute = `${context.home}/${path.slice(2)}`;
  } else if (path.startsWith("/")) {
    absolute = path;
  } else if (path.startsWith("~") || context.cwd === undefined) {
    // `~user` needs the password database; a relative path needs a directory.
    return undefined;
  } else {
    absolute = `${context.cwd}/${path}`;
  }

  const parts: string[] = [];
  for (const part of absolute.normalize("NFC").split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

/** The directory a `path_within` value names, or `undefined` when unknown. */
export function resolveRoot(
  value: string,
  context: PathContext,
): string | undefined {
  const replaced = value.replace(
    /^\$\{(project|home)\}/,
    (_match, name: string) =>
      (name === "project" ? context.projectRoot : context.home) ?? "\0",
  );
  return replaced.includes("\0") ? undefined : normalizePath(replaced, context);
}

/**
 * True when `path` is `root` or lies under it. Both are normalized paths.
 *
 * A file system may or may not tell `Project` from `project`, and the engine
 * cannot know. So the caller says which mistake is the safe one: an allow rule
 * compares exactly, and a path that only matches by case is not within; a deny
 * or ask rule ignores case, and it is.
 */
export function isWithin(
  path: string,
  root: string,
  ignoreCase: boolean,
): boolean {
  const [a, b] = ignoreCase
    ? [path.toLowerCase(), root.toLowerCase()]
    : [path, root];
  return a === b || b === "/" || a.startsWith(`${b}/`);
}
