#!/usr/bin/env node
/**
 * RFX-146 — writes the refund benchmark's labels (ADR-016 §7).
 *
 * Reads the generated file (`rdm/`'s generator, committed under
 * benchmarks/refunds/v1/), runs every case through the real engine under its
 * policy with the vector provider, and writes:
 *
 *   corpus/refunds/v1/refunds.json       the labelled corpus, replayed by CI
 *   benchmarks/refunds/v1/labels.json    the labels alone, with their source
 *
 *   node scripts/label-refund-benchmark.mjs   (after `pnpm build`)
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

import { labelRefundBenchmark, pairsThatDoNotFlip } from "../dist/index.js";

const GENERATED = fileURLToPath(
  new URL("../benchmarks/refunds/v1/generated.json", import.meta.url),
);
const CORPUS = fileURLToPath(
  new URL("../corpus/refunds/v1/refunds.json", import.meta.url),
);
const LABELS = fileURLToPath(
  new URL("../benchmarks/refunds/v1/labels.json", import.meta.url),
);

const generated = JSON.parse(readFileSync(GENERATED, "utf8"));
const labelled = await labelRefundBenchmark(generated);
const broken = pairsThatDoNotFlip(labelled);
for (const { pair, actual } of broken) {
  process.stderr.write(
    `${pair.id} (${pair.variable}): expected ${pair.expectedEffects.join(" / ")}, got ${actual.join(" / ")}\n`,
  );
}
writeFileSync(CORPUS, `${JSON.stringify(labelled.corpus, null, 2)}\n`);
writeFileSync(
  LABELS,
  `${JSON.stringify(
    {
      family: generated.family,
      version: generated.version,
      labels: labelled.labels,
    },
    null,
    2,
  )}\n`,
);
const counts = {};
for (const label of labelled.labels) {
  counts[label.effect] = (counts[label.effect] ?? 0) + 1;
}
process.stdout.write(
  `${String(labelled.labels.length)} cases labelled (${JSON.stringify(counts)}), ${String(labelled.pairs.length)} pairs, ${String(broken.length)} do not flip\n`,
);
process.exitCode = broken.length === 0 ? 0 : 1;
