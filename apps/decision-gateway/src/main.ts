import {
  DecisionLog,
  defaultDecisionLogDirectory,
  shadowEventOf,
} from "@reflex/telemetry";

import {
  readOrCreateRedactionKey,
  redactionKeyPath,
} from "./orchestration/redaction-key.js";

import { parseArguments } from "./config/arguments.js";
import {
  buildEngine,
  createPolicyHolder,
  readPolicyFiles,
} from "./orchestration/policy-source.js";
import { buildSemanticStage } from "./orchestration/semantic-stage.js";
import { createGatewayServer } from "./server.js";

/**
 * The daemon's entry point. Prints one JSON line to stdout once it listens,
 * so that whatever started it can read where; everything else goes to
 * stderr. Exits non-zero when it cannot start.
 */
const VERSION = "0.0.0";

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.problem}\n`);
    return 2;
  }
  const config = parsed.arguments;

  const policies = createPolicyHolder();
  const files = await readPolicyFiles(config.policyFiles);
  if (files.ok) {
    const loaded = policies.replace(files.sources, new Date());
    if (!loaded.ok) {
      process.stderr.write(
        `policy not loaded, REFLEX's own rules only:\n${loaded.problems.join("\n")}\n`,
      );
    }
  } else {
    process.stderr.write(
      `policy not loaded, REFLEX's own rules only:\n${files.problems.join("\n")}\n`,
    );
  }

  // ADR-006 §4: the installation's redaction key, created on first start,
  // so that every fingerprint is continuous with the first.
  const redactionKey = await readOrCreateRedactionKey(
    redactionKeyPath(config.reflexHome),
  );
  if (!redactionKey.ok) {
    process.stderr.write(
      `cannot read or create the redaction key: ${redactionKey.reason}\n`,
    );
    return 1;
  }

  // RFX-141: the semantic stage, or none. A provider that was asked for and
  // cannot be built is a misconfiguration, not a daemon that quietly runs
  // without it (CLAUDE.md principle 5).
  const semantic = buildSemanticStage({
    id: config.semanticProvider,
    model: config.semanticModel,
    endpoint: config.semanticEndpoint,
    redactionKey: redactionKey.key,
    env: process.env,
    shadows: config.shadowProviders.map((id) => ({ id })),
    shadowDeadlineMs: config.shadowDeadlineMs,
    shadowSample: config.shadowSample,
  });
  if (!semantic.ok) {
    process.stderr.write(`${semantic.reason}\n`);
    return 2;
  }

  const telemetry = config.telemetry
    ? new DecisionLog({
        directory: defaultDecisionLogDirectory(config.reflexHome),
      })
    : undefined;
  const engine = buildEngine({
    policies,
    failureMode: config.failureMode,
    cache: config.cache,
    home: process.env.HOME,
    ...(semantic.stage === undefined ? {} : { semantic: semantic.stage }),
    // RFX-142: a shadow's outcome is telemetry of its own (ADR-016 §3).
    ...(telemetry === undefined
      ? {}
      : {
          onShadow: (observation) => {
            telemetry.emit(
              shadowEventOf({
                ...observation,
                at: new Date().toISOString(),
              }),
            );
          },
        }),
  });

  const server = createGatewayServer({
    engine,
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(config.rateLimit === undefined
      ? {}
      : { limits: { rate: config.rateLimit } }),
    health: () => ({
      version: VERSION,
      policySetHash: policies.state().current.hash,
      policyLoadedAt: policies.state().loadedAt ?? null,
      policyProblems: policies.state().lastProblems.length,
      telemetryDropped: telemetry?.dropped ?? 0,
      redactionKey: redactionKey.created ? "created" : "present",
      semanticProvider: semantic.provider,
      shadowProviders: semantic.shadows,
    }),
  });

  const listening = await server.listen(config.listen);
  if (!listening.ok) {
    process.stderr.write(`cannot listen: ${listening.reason}\n`);
    return 1;
  }
  process.stdout.write(
    `${JSON.stringify({ listening: listening.target, version: VERSION })}\n`,
  );

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      resolve();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  await server.close();
  await telemetry?.flush();
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "failed"}\n`,
    );
    process.exitCode = 1;
  },
);
