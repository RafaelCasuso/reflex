import { join } from "node:path";

import {
  parseTrustRecord,
  policyHashOf,
  PROJECT_POLICY_RELATIVE,
  trustFilePath,
  withTrust,
} from "@reflex/decision-gateway/policy.js";
import { STARTER_POLICY_YAML } from "@reflex/policy-engine";

import type { FileSystemPort } from "../backups/file-system.js";
import {
  reflexHome,
  serialize,
  STATE_FILE_MODE,
  type Environment,
} from "../state.js";
import { appendAudit } from "./pause-command.js";

/**
 * RFX-054 — `rfx policy starter`: the conservative starter policy, written
 * to `.reflex/policy.yaml` and trusted as written. An existing file is
 * never overwritten without `--force`, and `--force` keeps a copy first.
 */
export type StarterResult =
  | { readonly kind: "written"; readonly path: string }
  | { readonly kind: "exists"; readonly path: string }
  | {
      readonly kind: "replaced";
      readonly path: string;
      readonly backup?: string;
    }
  | { readonly kind: "write-failed" };

export async function writeStarterPolicy(
  environment: Environment,
  fileSystem: FileSystemPort,
  options: { readonly force?: boolean } = {},
): Promise<StarterResult> {
  const path = join(environment.projectDir, PROJECT_POLICY_RELATIVE);
  const existing = await fileSystem.read(path);
  if (existing !== undefined && options.force !== true) {
    return { kind: "exists", path };
  }
  const home = reflexHome(environment);
  let backup: string | undefined;
  try {
    if (existing !== undefined) {
      backup = `${path}.${environment.now().toISOString().replaceAll(/[-:.]/g, "")}.bak`;
      await fileSystem.write(backup, existing.content, 0o600);
    }
    await fileSystem.write(
      path,
      Buffer.from(STARTER_POLICY_YAML, "utf8"),
      0o644,
    );
    const trustFile = trustFilePath(home);
    const record = parseTrustRecord(
      (await fileSystem.read(trustFile))?.content.toString("utf8"),
    );
    await fileSystem.write(
      trustFile,
      serialize(
        withTrust(
          record,
          path,
          policyHashOf(STARTER_POLICY_YAML),
          environment.now(),
        ),
      ),
      STATE_FILE_MODE,
    );
  } catch {
    return { kind: "write-failed" };
  }
  await appendAudit(home, {
    at: environment.now().toISOString(),
    kind: "policy-starter",
    projectDir: environment.projectDir,
    detail: { path, ...(backup === undefined ? {} : { replaced: backup }) },
  });
  return existing === undefined
    ? { kind: "written", path }
    : { kind: "replaced", path, ...(backup === undefined ? {} : { backup }) };
}
