/**
 * @reflex/evals — Regression corpus and autonomy/safety evaluation harness.
 *
 * RFX-105 seeds the corpus and a minimal replay runner, so that the policy
 * engine is built against them from its first ticket. RFX-038 and RFX-039
 * extend both; they do not replace them.
 */
export {
  ASSESSMENT_LEVELS,
  CORPUS_PROVENANCE,
  SCORED_ASSESSMENT_DIMENSIONS,
  corpusActionId,
  loadCorpus,
  type AssessmentLevel,
  type CorpusAction,
  type CorpusCase,
  type CorpusFile,
  type CorpusIssue,
  type CorpusLoadResult,
  type CorpusProvenance,
  type ExpectedAssessment,
  type ScoredAssessmentDimension,
} from "./corpus.js";
export { SEED_CORPUS_DIRECTORY, readCorpusDirectory } from "./corpus-files.js";
export {
  describeFailures,
  replayCorpus,
  type CaseResult,
  type CaseVerdict,
  type Evaluate,
  type EvaluatedEffect,
  type ReplayReport,
} from "./replay.js";
export {
  INJECTION_SITES,
  compareTwins,
  describeInjectionReport,
  loadInjectionCorpus,
  runInjectionCorpus,
  type InjectionCorpus,
  type InjectionCorpusLoadResult,
  type InjectionPair,
  type InjectionPairResult,
  type InjectionReport,
  type InjectionSite,
  type InjectionTolerance,
  type InjectionViolation,
} from "./injection.js";
export {
  CORPUS_CONTEXT,
  adversaryProvider,
  createEnginePipeline,
  decideAll,
  evaluateWith,
  oracleProvider,
  policyFromYaml,
  requestKey,
  type EnginePipelineOptions,
} from "./engine-replay.js";
export {
  CONFIDENCE_BINS,
  calibrate,
  describeCalibration,
  type CalibrationBin,
  type CalibrationOptions,
  type CalibrationReport,
  type DimensionReliability,
} from "./calibration.js";
