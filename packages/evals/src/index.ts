/**
 * @reflex/evals — Regression corpus and autonomy/safety evaluation harness.
 *
 * RFX-105 seeds the corpus and a minimal replay runner, so that the policy
 * engine is built against them from its first ticket. RFX-038 and RFX-039
 * extend both; they do not replace them.
 */
export {
  CORPUS_PROVENANCE,
  corpusActionId,
  loadCorpus,
  type CorpusAction,
  type CorpusCase,
  type CorpusFile,
  type CorpusIssue,
  type CorpusLoadResult,
  type CorpusProvenance,
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
