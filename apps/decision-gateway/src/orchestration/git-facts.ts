import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { RepositoryFacts } from "@reflex-control/policy-engine";

/**
 * RFX-084 — what the repository of a working directory says about itself:
 * its root, the checked-out branch and where `origin` points. Read from the
 * files git keeps (`HEAD`, `config`), never by running git: a hook call is
 * on the hot path and git is a process. A few `stat` and two small reads,
 * cached by the caller.
 *
 * The lookup walks up from the working directory and stops before the
 * user's home, like the project policy's (RFX-104): the home is not a
 * repository REFLEX governs.
 */
export interface GitFacts extends RepositoryFacts {
  /** The directory that holds `.git`. */
  readonly root: string;
  /** `github.com`, for the contract's `repository.remoteHost`. */
  readonly remoteHost?: string;
}

export interface GitFactsOptions {
  readonly home: string | undefined;
  readonly exists?: (path: string) => "directory" | "file" | undefined;
  readonly read?: (path: string) => string | undefined;
}

function kindOf(path: string): "directory" | "file" | undefined {
  try {
    const info = statSync(path);
    return info.isDirectory()
      ? "directory"
      : info.isFile()
        ? "file"
        : undefined;
  } catch {
    return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The directory git keeps its files in, for a `.git` directory or a worktree's `.git` file. */
function gitDirectoryOf(
  root: string,
  options: Required<Pick<GitFactsOptions, "exists" | "read">>,
): string | undefined {
  const dotGit = join(root, ".git");
  const kind = options.exists(dotGit);
  if (kind === "directory") {
    return dotGit;
  }
  if (kind !== "file") {
    return undefined;
  }
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(options.read(dotGit) ?? "");
  const target = pointer?.[1];
  if (target === undefined) {
    return undefined;
  }
  return isAbsolute(target) ? target : resolve(root, target);
}

/** `ref: refs/heads/main` is a branch; a bare hash (detached) is none. */
export function branchOf(head: string | undefined): string | undefined {
  const match = /^ref:\s*refs\/heads\/(\S+)\s*$/m.exec(head ?? "");
  return match?.[1];
}

/**
 * `origin`'s URL as `host/owner/repo`: `git@github.com:acme/api.git`,
 * `https://github.com/acme/api.git` and `ssh://git@github.com/acme/api`
 * all become `github.com/acme/api`. A URL that is none of these shapes
 * (a local path, a bundle) gives nothing.
 */
export function remoteOf(
  config: string | undefined,
): { readonly remote: string; readonly host: string } | undefined {
  if (config === undefined) {
    return undefined;
  }
  const section = /^\[remote "origin"\]\n((?:[ \t].*\n?)*)/m.exec(config);
  const url = /^\s*url\s*=\s*(.+?)\s*$/m.exec(section?.[1] ?? "")?.[1];
  if (url === undefined) {
    return undefined;
  }
  let host: string | undefined;
  let path: string | undefined;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(url);
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== "") {
        host = parsed.hostname;
        path = parsed.pathname;
      }
    } catch {
      return undefined;
    }
  }
  if (host === undefined || path === undefined) {
    return undefined;
  }
  const cleaned = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (cleaned === "" || /[\s\p{Cc}]/u.test(cleaned)) {
    return undefined;
  }
  return {
    remote: `${host.toLowerCase()}/${cleaned}`,
    host: host.toLowerCase(),
  };
}

/** The repository at or above `cwd`, if any; `undefined` for none, or for the home itself. */
export function readGitFacts(
  cwd: string,
  options: GitFactsOptions,
): GitFacts | undefined {
  const exists = options.exists ?? kindOf;
  const read = options.read ?? readText;
  const stop = options.home === undefined ? undefined : resolve(options.home);
  let directory = resolve(cwd);
  for (;;) {
    if (directory === stop) {
      return undefined;
    }
    const gitDirectory = gitDirectoryOf(directory, { exists, read });
    if (gitDirectory !== undefined) {
      const branch = branchOf(read(join(gitDirectory, "HEAD")));
      // A worktree's config lives with the main repository's git directory.
      const common = read(join(gitDirectory, "commondir"))?.trim();
      const configDirectory =
        common === undefined
          ? gitDirectory
          : isAbsolute(common)
            ? common
            : resolve(gitDirectory, common);
      const remote = remoteOf(read(join(configDirectory, "config")));
      return {
        root: directory,
        ...(branch === undefined ? {} : { branch }),
        ...(remote === undefined
          ? {}
          : { remote: remote.remote, remoteHost: remote.host }),
      };
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}
