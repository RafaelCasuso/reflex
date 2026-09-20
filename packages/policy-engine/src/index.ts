/**
 * @reflex/policy-engine — Pure deterministic policy evaluation.
 *
 * No I/O anywhere in this package: strings and values in, results out.
 */
export {
  POLICY_FIELDS,
  RAW_ARGUMENTS_PREFIX,
  addressableFieldNames,
  fieldSpec,
  type FieldKind,
  type FieldSpec,
} from "./fields.js";
export {
  POLICY_ISSUE_CODES,
  POLICY_LIMITS,
  parsePolicy,
  type PolicyIssue,
  type PolicyIssueCode,
  type PolicyParseResult,
} from "./parser.js";
export {
  PATTERN_LIMITS,
  compilePattern,
  type CompiledPattern,
  type PatternCompileResult,
} from "./pattern.js";
export {
  compilePolicySet,
  evaluatePolicy,
  type CompileResult,
  type CompiledPolicySet,
  type PolicyEvaluationResult,
  type PolicySourceDocument,
} from "./evaluator.js";
export { ruleMatches, type MatchContext, type RuleKind } from "./matcher.js";
export {
  isWithin,
  normalizePath,
  resolveRoot,
  type PathContext,
} from "./paths.js";
export {
  POLICY_SOURCES,
  combine,
  mostRestrictive,
  precedenceOf,
  resolve,
  type PolicySource,
  type Resolution,
  type SourcedRule,
} from "./precedence.js";
export {
  subjectsOf,
  valuesOf,
  type FieldValue,
  type Subject,
  type SubjectSet,
} from "./subjects.js";
