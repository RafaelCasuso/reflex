/**
 * @reflex-control/command-classifier — shell command normalization and side-effect
 * classification, shared by every host (ADR-011).
 *
 * Pure: no I/O, never throws. Depends on the contracts and on nothing else.
 */
export {
  classifyArgv,
  classifyCommand,
  classifyPath,
  escalate,
  type ClassifiedCommand,
  type ClassifiedSegment,
} from "./classify.js";
export {
  NOT_UNDERSTOOD_REASONS,
  SHELL_LIMITS,
  parseShellCommand,
  type NotUnderstoodReason,
  type ParsedCommand,
  type ShellAssignment,
  type ShellInput,
  type ShellRedirect,
  type ShellSegment,
} from "./shell/parse.js";
