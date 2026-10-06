import { readFile } from "node:fs/promises";

import { OverrideStore, type DecisionObservation } from "@reflex-control/core";
import {
  parseConsentRecord,
  type ConsentRecord,
} from "@reflex-control/semantic-provider";
import {
  DecisionLog,
  DecisionRecordLog,
  decisionRecordOf,
  defaultDecisionLogDirectory,
  defaultDecisionRecordDirectory,
  shadowEventOf,
} from "@reflex-control/telemetry";

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
import {
  createProjectPolicyComposer,
  trustFilePath,
} from "./orchestration/project-policy.js";
import { createSubscriptionHolder } from "./orchestration/subscription.js";
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
  // RFX-123: the consent record, when the caller passed one. Unreadable is
  // no consent, and a remote provider is then refused below.
  let consent: ConsentRecord | undefined;
  if (config.remoteConsentFile !== undefined) {
    consent = parseConsentRecord(
      await readFile(config.remoteConsentFile, "utf8").catch(() => undefined),
    );
  }
  const semantic = buildSemanticStage({
    id: config.semanticProvider,
    model: config.semanticModel,
    endpoint: config.semanticEndpoint,
    redactionKey: redactionKey.key,
    env: process.env,
    shadows: config.shadowProviders.map((id) => ({ id })),
    shadowDeadlineMs: config.shadowDeadlineMs,
    shadowSample: config.shadowSample,
    ...(consent === undefined ? {} : { consent }),
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
  // RFX-143: the decision records, written after the answer, once every
  // shadow of the decision has settled (each on its own deadline).
  const records = config.telemetry
    ? new DecisionRecordLog({
        directory: defaultDecisionRecordDirectory(config.reflexHome),
      })
    : undefined;
  // RFX-125: the override path. The store is the engine's and the server's:
  // the engine remembers every decision in it and takes the grants; the
  // server turns a human's `rfx override` into a grant.
  const overrides = new OverrideStore();
  // RFX-104: a project's `.reflex/policy.yaml`, found from the action's
  // working directory and trusted only by the user's record, joins the
  // user's own sources per action.
  // RFX-083: the team's signed snapshot, if this machine subscribes to one.
  // Its sources come before the user's: the organization's defaults, which
  // the user's own policy refines, and its mandates, which nothing refines.
  const subscription = await createSubscriptionHolder({
    home: config.reflexHome,
  });
  const refreshed = await subscription.refresh();
  if (refreshed.kind === "refused") {
    process.stderr.write(
      `team policy snapshot not applied (${refreshed.reason}); ${subscription.state().current === undefined ? "none in force" : "the last good one stays in force"}\n`,
    );
  }
  const refreshTimer = setInterval(() => {
    void subscription.refresh();
  }, config.snapshotIntervalMs);
  refreshTimer.unref();
  const projects = createProjectPolicyComposer({
    home: process.env.HOME,
    trustFile: trustFilePath(config.reflexHome),
    userSources: () => [...subscription.sources(), ...policies.sources()],
  });
  const engine = buildEngine({
    policies,
    setFor: projects.setFor,
    failureMode: config.failureMode,
    cache: config.cache,
    home: process.env.HOME,
    overrides,
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
    ...(records === undefined
      ? {}
      : {
          onDecision: (observation: DecisionObservation) => {
            void Promise.all(observation.shadows).then((shadows) => {
              records.write(
                decisionRecordOf({
                  decision: observation.decision,
                  ...(observation.request === undefined
                    ? {}
                    : { request: observation.request }),
                  evaluations: [
                    ...(observation.primary === undefined
                      ? []
                      : [{ ...observation.primary, role: "primary" as const }]),
                    ...shadows.map((shadow) => ({
                      provider: shadow.provider,
                      ...(shadow.model === undefined
                        ? {}
                        : { model: shadow.model }),
                      role: "shadow" as const,
                      sampledOn: shadow.sampledOn,
                      result: shadow.result,
                      latencyMs: shadow.latencyMs,
                    })),
                  ],
                  resolvedByPolicy: observation.resolvedByPolicy,
                  humanOverride: observation.humanOverride,
                  recordedAt: new Date().toISOString(),
                }),
              );
            });
          },
        }),
  });

  const server = createGatewayServer({
    engine,
    overrides,
    // RFX-084: branch, remote and environment, where the host said nothing.
    enrich: projects.enrich,
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(config.rateLimit === undefined
      ? {}
      : { limits: { rate: config.rateLimit } }),
    health: () => ({
      version: VERSION,
      // RFX-138: the lifecycle stops the daemon it can see answering, never
      // a process it merely remembers.
      pid: process.pid,
      policySetHash: policies.state().current.hash,
      policyLoadedAt: policies.state().loadedAt ?? null,
      policyProblems: policies.state().lastProblems.length,
      // RFX-104: project policies that could not be used since start.
      projectPolicyProblems: projects.problems().length,
      // RFX-083: the team snapshot in force, and the last attempt at one.
      snapshot: subscription.state(),
      telemetryDropped: telemetry?.dropped ?? 0,
      recordsDropped: records?.dropped ?? 0,
      redactionKey: redactionKey.created ? "created" : "present",
      semanticProvider: semantic.provider,
      shadowProviders: semantic.shadows,
      // RFX-125: the human override rate's numerator, since this start.
      overrides: overrides.counters(performance.now()),
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
  await records?.flush();
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
