import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadCorpus,
  type CorpusFile,
  type CorpusLoadResult,
} from "./corpus.js";

/** The seeded corpus that ships in this package, `corpus/v1`. */
export const SEED_CORPUS_DIRECTORY = fileURLToPath(
  new URL("../corpus/v1/", import.meta.url),
);

/**
 * Reads a corpus directory. The only I/O in this package, kept apart from
 * `loadCorpus` so that the loader stays pure and testable on hostile input.
 * An unreadable file is a load failure, never a smaller corpus.
 */
export function readCorpusDirectory(directory: string): CorpusLoadResult {
  const files: CorpusFile[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      files.push({
        name,
        content: JSON.parse(readFileSync(join(directory, name), "utf8")),
      });
    } catch {
      return {
        ok: false,
        issues: [{ file: name, caseId: undefined, message: "not valid JSON" }],
      };
    }
  }
  if (files.length === 0) {
    return {
      ok: false,
      issues: [
        { file: directory, caseId: undefined, message: "no corpus files" },
      ],
    };
  }
  return loadCorpus(files);
}
