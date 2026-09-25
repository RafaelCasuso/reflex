import { homedir } from "node:os";
import { join } from "node:path";

import { FAILURE_MODES, type FailureMode } from "@reflex/contracts";
import { isProviderId, type ProviderId } from "@reflex/semantic-provider";

import type { RateLimitOptions } from "../http/limits.js";
import type { ListenTarget } from "../server.js";

/**
 * The daemon's command line. Strict: an unknown flag is an error, because a
 * daemon that starts with a misread flag runs with the wrong policy.
 */
export interface GatewayArguments {
  readonly listen: ListenTarget;
  readonly policyFiles: readonly string[];
  readonly failureMode: FailureMode;
  readonly cache: boolean;
  readonly reflexHome: string;
  readonly telemetry: boolean;
  /** `--rate-limit <burst>/<per-second>`; the server's default otherwise. */
  readonly rateLimit: RateLimitOptions | undefined;
  /** ADR-016 §1: `none` is today's behavior and the default. */
  readonly semanticProvider: ProviderId;
  /** A versioned model for the provider; the provider's default otherwise. */
  readonly semanticModel: string | undefined;
  /** Where the provider is reached; the provider's default otherwise. */
  readonly semanticEndpoint: string | undefined;
}

export type ArgumentsResult =
  | { readonly ok: true; readonly arguments: GatewayArguments }
  | { readonly ok: false; readonly problem: string };

export function defaultReflexHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.REFLEX_HOME ?? join(homedir(), ".reflex");
}

export function defaultSocketPath(reflexHome: string): string {
  return join(reflexHome, "run", "reflex.sock");
}

export const USAGE = `usage: reflex-gateway [--socket <path> | --tcp <host:port>] [--policy <file>]... [--failure-mode fail-open|fail-ask|fail-closed] [--no-cache] [--no-telemetry] [--home <dir>] [--rate-limit <burst>/<per-second>] [--semantic-provider none|jev|local|reflex|fake] [--semantic-model <id>] [--semantic-endpoint <url>]`;

function isFailureMode(value: string): value is FailureMode {
  return (FAILURE_MODES as readonly string[]).includes(value);
}

export function parseArguments(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ArgumentsResult {
  let listen: ListenTarget | undefined;
  const policyFiles: string[] = [];
  let failureMode: FailureMode = "fail-ask";
  let cache = true;
  let telemetry = true;
  let reflexHome = defaultReflexHome(env);
  let rateLimit: RateLimitOptions | undefined;
  let semanticProvider: ProviderId = "none";
  let semanticModel: string | undefined;
  let semanticEndpoint: string | undefined;

  const problem = (message: string): ArgumentsResult => ({
    ok: false,
    problem: `${message}\n${USAGE}`,
  });

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    const value = argv[index + 1];
    const takeValue = (): string | undefined => {
      index += 1;
      return value;
    };
    switch (flag) {
      case "--socket": {
        const path = takeValue();
        if (path === undefined || path === "") {
          return problem("--socket needs a path");
        }
        listen = { kind: "socket", path };
        break;
      }
      case "--tcp": {
        const spec = takeValue();
        const separator = spec?.lastIndexOf(":") ?? -1;
        const port =
          spec === undefined ? Number.NaN : Number(spec.slice(separator + 1));
        if (
          spec === undefined ||
          separator <= 0 ||
          !Number.isInteger(port) ||
          port < 0 ||
          port > 65_535
        ) {
          return problem("--tcp needs host:port");
        }
        listen = { kind: "tcp", host: spec.slice(0, separator), port };
        break;
      }
      case "--policy": {
        const path = takeValue();
        if (path === undefined || path === "") {
          return problem("--policy needs a file");
        }
        policyFiles.push(path);
        break;
      }
      case "--failure-mode": {
        const mode = takeValue();
        if (mode === undefined || !isFailureMode(mode)) {
          return problem(
            "--failure-mode needs fail-open, fail-ask or fail-closed",
          );
        }
        failureMode = mode;
        break;
      }
      case "--home": {
        const dir = takeValue();
        if (dir === undefined || dir === "") {
          return problem("--home needs a directory");
        }
        reflexHome = dir;
        break;
      }
      case "--rate-limit": {
        const spec = takeValue();
        const [burst, perSecond] = (spec ?? "").split("/").map(Number);
        if (
          burst === undefined ||
          perSecond === undefined ||
          !(burst >= 1) ||
          !(perSecond > 0)
        ) {
          return problem("--rate-limit needs <burst>/<per-second>");
        }
        rateLimit = { burst, perSecond };
        break;
      }
      case "--semantic-provider": {
        const id = takeValue();
        if (id === undefined || !isProviderId(id)) {
          return problem(
            "--semantic-provider needs none, jev, local, reflex or fake",
          );
        }
        semanticProvider = id;
        break;
      }
      case "--semantic-model": {
        const model = takeValue();
        if (model === undefined || model === "") {
          return problem("--semantic-model needs a versioned model id");
        }
        semanticModel = model;
        break;
      }
      case "--semantic-endpoint": {
        const url = takeValue();
        if (url === undefined || !/^https?:\/\/[^\s/]+/.test(url)) {
          return problem("--semantic-endpoint needs an http or https URL");
        }
        semanticEndpoint = url;
        break;
      }
      case "--no-cache":
        cache = false;
        break;
      case "--no-telemetry":
        telemetry = false;
        break;
      default:
        return problem(`unknown argument: ${flag}`);
    }
  }

  if (
    semanticProvider === "none" &&
    (semanticModel !== undefined || semanticEndpoint !== undefined)
  ) {
    return problem(
      "--semantic-model and --semantic-endpoint need a --semantic-provider",
    );
  }

  return {
    ok: true,
    arguments: {
      listen: listen ?? { kind: "socket", path: defaultSocketPath(reflexHome) },
      policyFiles,
      failureMode,
      cache,
      reflexHome,
      telemetry,
      rateLimit,
      semanticProvider,
      semanticModel,
      semanticEndpoint,
    },
  };
}
