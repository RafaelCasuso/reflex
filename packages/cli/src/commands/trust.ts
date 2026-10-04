import { homedir } from "node:os";

import {
  createProjectPolicyComposer,
  findProjectPolicy,
  parseTrustRecord,
  policyHashOf,
  readPolicyFiles,
  trustFilePath,
  withTrust,
  withoutTrust,
  type ProjectPolicyComposer,
  type ProjectPolicyReading,
  type TrustRecord,
} from "@reflex-control/decision-gateway/policy.js";
import type { PolicyCondition, PolicyRule } from "@reflex-control/contracts";

import type { FileSystemPort } from "../backups/file-system.js";
import {
  reflexHome,
  serialize,
  STATE_FILE_MODE,
  type Environment,
} from "../state.js";

/**
 * RFX-104 — `rfx trust`: the user looks at what a repository's policy would
 * allow, and trusts that very content.
 *
 * Until then the policy only tightens (ADR-012). Trust is bound to the
 * file's hash: an edited policy is untrusted again and asks again. The
 * command is on REFLEX's own rule, so the agent cannot answer the prompt
 * for the user (RFX-103). `rfx trust --revoke` takes the trust back.
 */
export interface ProjectPolicyStatus {
  /** `undefined` when the project has no `.reflex/policy.yaml` above it. */
  readonly reading: ProjectPolicyReading | undefined;
  readonly trustFile: string;
}

/** The composer the daemon uses, built the same way, for one-off reads. */
export async function composerFor(
  environment: Environment,
  fileSystem: FileSystemPort,
): Promise<ProjectPolicyComposer> {
  const home = reflexHome(environment);
  const userPolicy = `${home}/policy.yaml`;
  const exists = (await fileSystem.read(userPolicy)) !== undefined;
  const read = exists ? await readPolicyFiles([userPolicy]) : undefined;
  const userSources = read?.ok ? read.sources : [];
  return createProjectPolicyComposer({
    home: environment.homeDir,
    trustFile: trustFilePath(home),
    userSources: () => userSources,
    lookupTtlMs: 0,
  });
}

export async function readProjectPolicy(
  environment: Environment,
  fileSystem: FileSystemPort,
): Promise<ProjectPolicyStatus> {
  const composer = await composerFor(environment, fileSystem);
  return {
    reading: composer.inspect(environment.projectDir),
    trustFile: trustFilePath(reflexHome(environment)),
  };
}

export type TrustResult =
  | {
      readonly kind: "trusted";
      readonly path: string;
      readonly policyHash: string;
    }
  | { readonly kind: "revoked"; readonly path: string }
  | { readonly kind: "no-policy" }
  | {
      readonly kind: "unparseable";
      readonly path: string;
      readonly problems: readonly string[];
    }
  | { readonly kind: "write-failed" };

async function readTrust(
  fileSystem: FileSystemPort,
  file: string,
): Promise<TrustRecord> {
  return parseTrustRecord(
    (await fileSystem.read(file))?.content.toString("utf8"),
  );
}

export async function trustProjectPolicy(
  environment: Environment,
  fileSystem: FileSystemPort,
  options: { readonly revoke?: boolean } = {},
): Promise<TrustResult> {
  const path = findProjectPolicy(environment.projectDir, environment.homeDir);
  if (path === undefined) {
    return { kind: "no-policy" };
  }
  const file = await fileSystem.read(path);
  if (file === undefined) {
    return { kind: "no-policy" };
  }
  const text = file.content.toString("utf8");
  const trustFile = trustFilePath(reflexHome(environment));
  const record = await readTrust(fileSystem, trustFile);
  try {
    if (options.revoke === true) {
      await fileSystem.write(
        trustFile,
        serialize(withoutTrust(record, path)),
        STATE_FILE_MODE,
      );
      return { kind: "revoked", path };
    }
    const status = await readProjectPolicy(environment, fileSystem);
    if (status.reading !== undefined && status.reading.problems.length > 0) {
      return { kind: "unparseable", path, problems: status.reading.problems };
    }
    const policyHash = policyHashOf(text);
    await fileSystem.write(
      trustFile,
      serialize(withTrust(record, path, policyHash, environment.now())),
      STATE_FILE_MODE,
    );
    return { kind: "trusted", path, policyHash };
  } catch {
    return { kind: "write-failed" };
  }
}

/** One line per condition, as the policy wrote it; never evaluated here. */
export function describeCondition(condition: PolicyCondition): string {
  if ("any_of" in condition) {
    return `any of: ${condition.any_of.map(describeCondition).join(" | ")}`;
  }
  if ("not" in condition) {
    return `not ${describeCondition(condition.not)}`;
  }
  const value =
    "value" in condition && condition.value !== undefined
      ? ` ${JSON.stringify(condition.value)}`
      : "";
  return `${condition.field} ${condition.operator}${value}`;
}

/** What trusting this policy would let through: its allow rules, in full. */
export function describeAllowRules(rules: readonly PolicyRule[]): string[] {
  if (rules.length === 0) {
    return ["  (no allow rules: trusting it changes nothing)"];
  }
  return rules.flatMap((rule) => [
    `  allow  ${rule.id}  ${rule.name}`,
    ...rule.conditions.map(
      (condition) => `         when ${describeCondition(condition)}`,
    ),
  ]);
}

export { homedir };
