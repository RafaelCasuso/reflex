import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * RFX-024 — the numbers in `docs/decision-gateway.md` §4 are the numbers in
 * the benchmark record, and the record says what it measured.
 */
interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly n: number;
}

interface BenchCase {
  readonly label: string;
  readonly effect: string;
  readonly overSocketMissMs: Percentiles;
  readonly overSocketHitMs: Percentiles;
  readonly endToEndHttpClientMs: Percentiles;
  readonly endToEndNetClientMs: Percentiles;
}

interface BenchRecord {
  readonly ticket: string;
  readonly measuredAt: string;
  readonly machine: { readonly cpu: string; readonly node: string };
  readonly runs: { readonly warm: number; readonly endToEnd: number };
  readonly cases: readonly BenchCase[];
}

const record = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../bench/results/apple-m1-max-node24.json", import.meta.url),
    ),
    "utf8",
  ),
) as BenchRecord;

const DOC = readFileSync(
  fileURLToPath(new URL("../../../docs/decision-gateway.md", import.meta.url)),
  "utf8",
);

const cell = (value: number): string => value.toFixed(2);

/** The row for a point of measurement, as the document prints it. */
function documented(label: string, point: string): string | undefined {
  const rows = DOC.split("\n");
  const start = rows.findIndex((row) => row.startsWith(`| ${label}`));
  if (start === -1) {
    return undefined;
  }
  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index] ?? "";
    if (index > start && /^\| [a-z]/.test(row)) {
      break;
    }
    if (row.includes(point)) {
      return row;
    }
  }
  return undefined;
}

describe("RFX-024 benchmark evidence", () => {
  it("is a record of the right harness, with enough runs", () => {
    expect(record.ticket).toBe("RFX-024");
    expect(record.runs.warm).toBeGreaterThanOrEqual(500);
    expect(record.runs.endToEnd).toBeGreaterThanOrEqual(100);
    expect(record.cases).toHaveLength(3);
    for (const benchCase of record.cases) {
      expect(benchCase.overSocketMissMs.n).toBe(record.runs.warm);
      expect(benchCase.endToEndNetClientMs.n).toBe(record.runs.endToEnd);
    }
  });

  it("names the machine and the date the document names", () => {
    expect(DOC).toContain(record.machine.cpu);
    expect(DOC).toContain(`Node ${record.machine.node}`);
    expect(DOC).toContain(record.measuredAt.slice(0, 10));
  });

  it.each(
    record.cases.map((benchCase) => [benchCase.label, benchCase] as const),
  )("prints the recorded numbers for %s", (label, benchCase) => {
    const rows: [string, Percentiles][] = [
      ["over the socket, warm client, miss", benchCase.overSocketMissMs],
      ["end to end, `node:http` client", benchCase.endToEndHttpClientMs],
      ["end to end, `node:net` client", benchCase.endToEndNetClientMs],
    ];
    for (const [point, percentiles] of rows) {
      const row = documented(label, point);
      expect(row, `${label}: ${point}`).toBeDefined();
      for (const value of [percentiles.p50, percentiles.p95, percentiles.p99]) {
        expect(row, `${label}: ${point}`).toContain(cell(value));
      }
    }
    expect(DOC).toContain(`${label} (\`${benchCase.effect}\`)`);
  });

  it("holds the budgets it says it holds", () => {
    for (const benchCase of record.cases) {
      // Infrastructure overhead, p95 < 25 ms: over the socket is the engine
      // plus everything the gateway adds, so it bounds the overhead.
      expect(benchCase.overSocketMissMs.p95).toBeLessThan(25);
    }
    const read = record.cases.find(
      (benchCase) => benchCase.label === "typical read",
    );
    expect(read?.overSocketHitMs.p95).toBeLessThan(20);
  });
});
