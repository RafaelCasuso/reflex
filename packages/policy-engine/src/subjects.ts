import {
  classifyArgv,
  classifyCommand,
  classifyPath,
  escalate,
  type ClassifiedCommand,
} from "@reflex-control/command-classifier";
import {
  resolveEnvironment,
  type CanonicalAction,
  type SideEffectClass,
} from "@reflex-control/contracts";

import { RAW_ARGUMENTS_PREFIX } from "./fields.js";
import { normalizePath, type PathContext } from "./paths.js";

/**
 * RFX-013 — what rules are matched against.
 *
 * An action becomes one or more **subjects**. A tool call is one subject. A
 * shell command is one subject per segment, because `git status; rm -rf ~`
 * is two things, and a rule has to be able to allow the first without being
 * tricked into allowing the second (ADR-011).
 *
 * A subject maps each addressable field to its values. A field that is absent
 * has no entry, which is different from an empty text.
 */
export type FieldValue = string | number | boolean;

export interface Subject {
  readonly fields: ReadonlyMap<string, readonly FieldValue[]>;
  /**
   * False when no allow rule may match: the command was not fully understood,
   * or a path could not be made absolute.
   */
  readonly understood: boolean;
  /**
   * True when the segment has arguments that could not be read (a variable, a
   * glob, a substitution, what `xargs` supplies). Its lists of arguments,
   * paths and hosts are then incomplete: it may point anywhere.
   */
  readonly openLists: boolean;
  /** The host's own arguments, for `arguments.<key>` fields. */
  readonly rawArguments: Readonly<Record<string, unknown>>;
}

export interface SubjectSet {
  readonly subjects: readonly Subject[];
  /** The class after classification: raised, never lowered. */
  readonly sideEffectClass: SideEffectClass;
  readonly understood: boolean;
}

/**
 * The adapter's `unknown` means "not classified", not "as bad as unknown". The
 * classifier's answer replaces it. Any other class the adapter gives is a
 * floor: a later stage raises it and never lowers it, so a wrong or hostile
 * adapter cannot talk an action down (ADR-011, C3).
 */
function refine(
  fromAdapter: SideEffectClass,
  classified: SideEffectClass,
): SideEffectClass {
  return fromAdapter === "unknown"
    ? classified
    : escalate(fromAdapter, classified);
}

export function subjectsOf(
  action: CanonicalAction,
  context: PathContext,
): SubjectSet {
  const cwd = context.cwd ?? action.cwd;
  const projectRoot =
    context.projectRoot ?? action.repository?.root ?? action.cwd;
  const paths: PathContext = {
    ...(cwd === undefined ? {} : { cwd }),
    ...(context.home === undefined ? {} : { home: context.home }),
    ...(projectRoot === undefined ? {} : { projectRoot }),
  };

  const common = new Map<string, readonly FieldValue[]>([
    ["tool.name", [action.tool.name]],
    ["agent.host", [action.agent.host]],
    ["environment", [resolveEnvironment(action)]],
  ]);
  if (action.tool.namespace !== undefined) {
    common.set("tool.namespace", [action.tool.namespace]);
  }
  if (action.repository?.branch !== undefined) {
    common.set("repository.branch", [action.repository.branch]);
  }

  /** Normalized paths, and whether every one of them could be normalized. */
  const normalizeAll = (
    raw: readonly string[],
  ): { values: string[]; complete: boolean; implied: SideEffectClass } => {
    const values: string[] = [];
    let complete = true;
    let implied: SideEffectClass = "none";
    for (const path of raw) {
      const normalized = normalizePath(path, paths);
      // A path that cannot be made absolute is kept as written, so that a
      // restrictive rule can still see it, and no allow rule may match.
      values.push(normalized ?? path);
      complete &&= normalized !== undefined;
      for (const candidate of normalized === undefined
        ? [path]
        : [path, normalized]) {
        const kind = classifyPath(candidate);
        if (kind !== undefined) {
          implied = escalate(implied, kind);
        }
      }
    }
    return { values, complete, implied };
  };

  const declaredPaths = normalizeAll(action.operands?.paths ?? []);
  const declaredHosts = (action.operands?.networkHosts ?? []).map((host) =>
    host.toLowerCase(),
  );

  const command = action.operands?.command;
  let classified: ClassifiedCommand | undefined;
  if (command?.raw !== undefined) {
    classified = classifyCommand(command.raw);
  } else if (command?.argv !== undefined) {
    classified = classifyArgv(command.argv);
  }

  if (classified === undefined) {
    // A tool call with nothing to parse. A path can still raise its class:
    // reading `~/.aws/credentials` is not a local read, whatever the tool.
    const sideEffectClass = escalate(
      action.sideEffectClass,
      declaredPaths.implied,
    );
    const fields = new Map(common);
    fields.set("sideEffectClass", [sideEffectClass]);
    if (declaredPaths.values.length > 0) {
      fields.set("path", declaredPaths.values);
    }
    if (declaredHosts.length > 0) {
      fields.set("network.host", declaredHosts);
    }
    return {
      subjects: [
        {
          fields,
          understood: declaredPaths.complete,
          openLists: false,
          rawArguments: action.arguments,
        },
      ],
      sideEffectClass,
      understood: declaredPaths.complete,
    };
  }

  let overall = escalate(
    refine(action.sideEffectClass, classified.sideEffectClass),
    declaredPaths.implied,
  );
  let understood = classified.understood && declaredPaths.complete;

  const drafts = classified.segments.map((entry) => {
    const own = normalizeAll(entry.paths);
    understood &&= own.complete;
    const kind = escalate(
      escalate(
        refine(action.sideEffectClass, entry.sideEffectClass),
        own.implied,
      ),
      declaredPaths.implied,
    );
    overall = escalate(overall, kind);

    const fields = new Map(common);
    fields.set("sideEffectClass", [kind]);
    if (entry.segment.name !== undefined) {
      fields.set("command.name", [entry.segment.name]);
    }
    if (entry.segment.args.length > 0) {
      fields.set("command.args", entry.segment.args);
    }
    if (entry.segment.text !== "") {
      fields.set("command.text", [entry.segment.text]);
    }
    const allPaths = [...own.values, ...declaredPaths.values];
    if (allPaths.length > 0) {
      fields.set("path", [...new Set(allPaths)]);
    }
    const hosts = [...entry.networkHosts, ...declaredHosts];
    if (hosts.length > 0) {
      fields.set("network.host", [...new Set(hosts)]);
    }
    if (entry.segment.reasons.length > 0) {
      fields.set("command.reasons", entry.segment.reasons);
    }
    return { fields, openLists: !entry.segment.understood };
  });

  // One segment that is not understood taints them all: `ls; $X` cannot be
  // allowed by allowing `ls`.
  return {
    subjects: drafts.map(({ fields, openLists }) => ({
      fields,
      understood,
      openLists,
      rawArguments: action.arguments,
    })),
    sideEffectClass: overall,
    understood: understood && drafts.length > 0,
  };
}

/** The values of a field in a subject, `arguments.<key>` included. */
export function valuesOf(
  subject: Subject,
  field: string,
): readonly FieldValue[] | undefined {
  if (!field.startsWith(RAW_ARGUMENTS_PREFIX)) {
    return subject.fields.get(field);
  }
  let current: unknown = subject.rawArguments;
  for (const key of field.slice(RAW_ARGUMENTS_PREFIX.length).split(".")) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current) ||
      !Object.hasOwn(current, key)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ||
    typeof current === "boolean" ||
    (typeof current === "number" && Number.isFinite(current))
    ? [current]
    : undefined;
}
