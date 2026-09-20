import type { SideEffectClass } from "@reflex/contracts";

import {
  parseShellCommand,
  type NotUnderstoodReason,
  type ShellSegment,
} from "./shell/parse.js";

/**
 * RFX-096 — what a shell command does, segment by segment.
 *
 * One classifier for every host (ADR-011), so that the same command gets the
 * same class whoever runs it. Three rules hold everything together:
 *
 * - **Unknown is never safe.** A program this table does not know is
 *   `unknown`, never `none`.
 * - **A class is raised and never lowered.** A flag, a path or a redirection
 *   can make a harmless program dangerous (`find -delete`, `cat ~/.ssh/id_rsa`,
 *   `echo x > file`). Nothing makes a dangerous one harmless.
 * - **A program that runs code defined elsewhere is `unknown`** and marked
 *   `indirect`: `pnpm test`, `make`, `node build.js`, `./deploy.sh`. REFLEX
 *   knows that it runs; it does not know what it does.
 *
 * Pure: no I/O. Paths are read lexically and never resolved against the disk.
 */
const SEVERITY: Readonly<Record<SideEffectClass, number>> = {
  none: 0,
  "local-read": 1,
  "external-read": 2,
  "local-write": 3,
  unknown: 4,
  "external-write": 5,
  privilege: 6,
  credential: 7,
  destructive: 8,
  financial: 8,
};

/** The more severe of two classes. Equal severity keeps the first. */
export function escalate(
  current: SideEffectClass,
  next: SideEffectClass,
): SideEffectClass {
  return SEVERITY[next] > SEVERITY[current] ? next : current;
}

export interface ClassifiedSegment {
  readonly segment: ShellSegment;
  readonly sideEffectClass: SideEffectClass;
  /** Paths the segment names, as written. Not resolved, not normalized. */
  readonly paths: readonly string[];
  /** Hosts the segment names, lower-cased. */
  readonly networkHosts: readonly string[];
  /** True when what runs is defined somewhere other than the command. */
  readonly indirect: boolean;
}

export interface ClassifiedCommand {
  readonly segments: readonly ClassifiedSegment[];
  readonly understood: boolean;
  readonly reasons: readonly NotUnderstoodReason[];
  /** The most severe class of any segment; `unknown` when nothing was read. */
  readonly sideEffectClass: SideEffectClass;
}

const set = (words: string): ReadonlySet<string> => new Set(words.split(" "));

const READS = set(
  "ls cat head tail less more wc grep egrep fgrep rg ag pwd echo printf which whereis type whoami id date stat file du df tree diff cmp sort uniq cut tr jq yq basename dirname realpath readlink test [ true false : sleep uname hostname ps column nl tac rev fold comm paste join xxd hexdump od md5 md5sum shasum sha1sum sha256sum base64 seq expr cd pushd popd dirs export unset alias hash help man",
);
const LOCAL_WRITES = set(
  "touch mkdir cp mv ln tee patch install tar unzip zip gzip gunzip bzip2 xz",
);
const DESTRUCTIVE = set(
  "rm rmdir unlink shred srm dd truncate mkfs fdisk wipefs parted diskutil",
);
const PRIVILEGE = set(
  "sudo su doas chmod chown chgrp setfacl visudo passwd useradd userdel usermod groupadd launchctl systemctl service crontab mount umount sysctl csrutil spctl dscl",
);
const REMOTE_SHELLS = set("ssh scp sftp rsync ftp nc ncat netcat telnet socat");
/** Wrappers whose own class is that of what they run, which is a segment too. */
const TRANSPARENT = set(
  "env nohup nice ionice time command builtin exec stdbuf setsid timeout watch xargs caffeinate chronic unbuffer",
);
const SHELLS = set("sh bash zsh dash ksh fish ash eval source .");
const INDIRECT = set(
  "npm pnpm yarn bun npx pnpx bunx node deno python python2 python3 ruby perl php java make just task gradle gradlew mvn cargo go dotnet swift rake bundle pip pip3 pipx poetry uv uvx tsx ts-node vitest jest tsc eslint prettier turbo nx awk gawk osascript",
);
const CLOUD = set(
  "kubectl helm terraform tofu pulumi aws gcloud az doctl heroku vercel fly flyctl netlify supabase wrangler docker podman",
);
const CLOUD_READS = set(
  "get describe list ls logs log show status plan version view inspect images ps top diff validate fmt output history whoami info",
);
const CLOUD_DESTRUCTIVE =
  /^(delete|destroy|terminate|rm|rmi|remove|prune|purge|drop|uninstall|down|kill)$|^(delete|terminate|remove|purge|deregister|disable)-/;
const CREDENTIAL_TOOLS = set("printenv pass op vault keyring secret-tool");
const DATABASE = set(
  "psql mysql mariadb mongosh mongo redis-cli sqlite3 sqlcmd cqlsh clickhouse-client",
);

const GIT_READS = set(
  "status diff log show blame describe rev-parse ls-files ls-tree shortlog grep cat-file whatchanged show-ref name-rev merge-base count-objects var version help",
);
const GIT_EXTERNAL_READS = set("fetch ls-remote");
const GIT_LOCAL_WRITES = set(
  "add commit switch merge rebase cherry-pick revert init mv apply am worktree submodule pull clone notes bisect",
);
const GIT_DESTRUCTIVE = set("clean restore filter-branch filter-repo");
const GIT_OPTIONS_WITH_VALUE = set(
  "-C -c --git-dir --work-tree --namespace --exec-path --super-prefix",
);

const NEVER_A_PATH =
  /^(?:&\d+|\/dev\/(?:null|stdout|stderr|stdin|tty|fd\/\d+))$/;
const TEMPORARY = /^(?:\/private)?\/(?:tmp|var\/tmp)\//;
const URL = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/\s@]+@)?(\[[0-9a-f:]+\]|[^/:\s?#]+)/i;
const REMOTE_SPEC =
  /^(?:[^@/\s:]+@)?([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}|localhost):/;

/**
 * Files that hold credentials, by name. Lexical on purpose: it must hold for
 * a path that does not exist yet and for one written with `..`.
 */
const CREDENTIAL_PATHS: readonly RegExp[] = [
  /(?:^|\/)\.ssh(?:\/|$)/,
  /(?:^|\/)\.gnupg(?:\/|$)/,
  /(?:^|\/)\.aws\/(?:credentials|config)$/,
  /(?:^|\/)\.config\/gh\/hosts\.yml$/,
  /(?:^|\/)\.config\/gcloud(?:\/|$)/,
  /(?:^|\/)\.azure(?:\/|$)/,
  /(?:^|\/)\.docker\/config\.json$/,
  /(?:^|\/)\.kube\/config$/,
  /(?:^|\/)\.(?:netrc|npmrc|pypirc|pgpass|my\.cnf|git-credentials)$/,
  /(?:^|\/)\.env(?:\.(?!example$|sample$|template$|dist$)[A-Za-z0-9_.-]+)?$/,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /(?:^|\/)(?:credentials|secrets?)(?:\.(?:json|ya?ml|toml|txt))?$/i,
  /^\/etc\/(?:shadow|gshadow|master\.passwd)$/,
  /(?:^|\/)Library\/Keychains(?:\/|$)/,
];
const PRIVILEGE_PATHS: readonly RegExp[] = [
  /^\/etc\/(?:sudoers(?:\.d\/.*)?|passwd|group|pam\.d\/.*|ssh\/.*|hosts)$/,
  /(?:^|\/)\.ssh\/authorized_keys$/,
];

/** The class a path implies by itself, whatever touches it. */
export function classifyPath(path: string): SideEffectClass | undefined {
  if (PRIVILEGE_PATHS.some((pattern) => pattern.test(path))) {
    return "privilege";
  }
  if (CREDENTIAL_PATHS.some((pattern) => pattern.test(path))) {
    return "credential";
  }
  return undefined;
}

const isOption = (arg: string): boolean => arg.startsWith("-") && arg !== "-";
const positional = (args: readonly string[]): string[] =>
  args.filter((arg) => !isOption(arg));
const hasOption = (args: readonly string[], ...options: string[]): boolean =>
  args.some(
    (arg) =>
      options.includes(arg) ||
      options.some(
        (option) => option.startsWith("--") && arg.startsWith(`${option}=`),
      ),
  );
/** `-rf` holds `-r` and `-f`. */
const hasShortFlag = (args: readonly string[], flag: string): boolean =>
  args.some((arg) => /^-[A-Za-z]+$/.test(arg) && arg.includes(flag));

function looksLikePath(arg: string): boolean {
  return (
    !URL.test(arg) &&
    (arg.startsWith("/") ||
      arg.startsWith("./") ||
      arg.startsWith("../") ||
      arg.startsWith("~") ||
      arg === "." ||
      arg === ".." ||
      arg.includes("/"))
  );
}

function classifyGit(args: readonly string[]): {
  kind: SideEffectClass;
  paths: string[];
} {
  let index = 0;
  let injected = false;
  while (index < args.length && isOption(args[index] ?? "")) {
    const option = args[index] ?? "";
    // `-c alias.x=!cmd`, `-c core.pager=cmd`: git runs what it is given.
    injected ||= option === "-c" || option.startsWith("--config-env");
    index += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  const separator = rest.indexOf("--");
  const paths = separator === -1 ? [] : rest.slice(separator + 1);
  let kind: SideEffectClass = "unknown";

  if (subcommand === undefined) {
    kind = "local-read";
  } else if (GIT_READS.has(subcommand)) {
    kind = "local-read";
  } else if (GIT_EXTERNAL_READS.has(subcommand)) {
    kind = "external-read";
  } else if (GIT_DESTRUCTIVE.has(subcommand)) {
    kind = "destructive";
  } else if (subcommand === "reset") {
    kind = hasOption(rest, "--hard", "--merge", "--keep")
      ? "destructive"
      : "local-write";
  } else if (subcommand === "checkout") {
    kind =
      separator !== -1 || rest.includes(".") || hasOption(rest, "-f", "--force")
        ? "destructive"
        : "local-write";
  } else if (subcommand === "push") {
    kind =
      hasOption(
        rest,
        "--force",
        "--force-with-lease",
        "--delete",
        "--mirror",
        "--prune",
      ) ||
      hasShortFlag(rest, "f") ||
      hasShortFlag(rest, "d") ||
      positional(rest).some((arg) => arg.startsWith(":") || arg.startsWith("+"))
        ? "destructive"
        : "external-write";
  } else if (subcommand === "branch" || subcommand === "tag") {
    kind =
      hasShortFlag(rest, "D") ||
      hasShortFlag(rest, "d") ||
      hasOption(rest, "--delete")
        ? "destructive"
        : positional(rest).length === 0 ||
            hasOption(rest, "--list", "-l", "-a", "-r", "-v", "-vv")
          ? "local-read"
          : "local-write";
  } else if (subcommand === "stash") {
    kind =
      rest[0] === "drop" || rest[0] === "clear"
        ? "destructive"
        : rest[0] === "list" || rest[0] === "show"
          ? "local-read"
          : "local-write";
  } else if (subcommand === "remote") {
    kind =
      rest.length === 0 ||
      rest[0] === "-v" ||
      rest[0] === "show" ||
      rest[0] === "get-url"
        ? "local-read"
        : "local-write";
  } else if (subcommand === "config") {
    kind =
      hasOption(rest, "--get", "--get-all", "--list", "-l", "--get-regexp") ||
      positional(rest).length <= 1
        ? "local-read"
        : "local-write";
  } else if (subcommand === "reflog") {
    kind =
      rest[0] === "expire" || rest[0] === "delete"
        ? "destructive"
        : "local-read";
  } else if (GIT_LOCAL_WRITES.has(subcommand)) {
    kind = "local-write";
  }
  return { kind: injected ? escalate(kind, "unknown") : kind, paths };
}

function classifyCurl(name: string, args: readonly string[]): SideEffectClass {
  if (name === "wget") {
    return hasOption(
      args,
      "--post-data",
      "--post-file",
      "--method",
      "--body-data",
      "--body-file",
    )
      ? "external-write"
      : "local-write";
  }
  const method =
    args[args.findIndex((arg) => arg === "-X" || arg === "--request") + 1];
  const explicit =
    args.find((arg) => /^-X[A-Za-z]+$/.test(arg))?.slice(2) ??
    (args.some((arg) => arg === "-X" || arg === "--request")
      ? method
      : undefined);
  const writes =
    (explicit !== undefined && !/^(GET|HEAD|OPTIONS)$/i.test(explicit)) ||
    hasOption(
      args,
      "-d",
      "--data",
      "--data-raw",
      "--data-binary",
      "--data-urlencode",
      "--json",
      "-F",
      "--form",
      "-T",
      "--upload-file",
    ) ||
    args.some((arg) => /^-(?:d|F|T)./.test(arg));
  if (writes) {
    return "external-write";
  }
  return hasOption(args, "-o", "--output", "-O", "--remote-name") ||
    hasShortFlag(args, "O") ||
    hasShortFlag(args, "o")
    ? "local-write"
    : "external-read";
}

function classifyProgram(segment: ShellSegment): {
  kind: SideEffectClass;
  indirect: boolean;
  paths: string[];
} {
  const { name, args } = segment;
  const none = { indirect: false, paths: [] as string[] };
  if (name === undefined) {
    return { kind: "unknown", ...none };
  }
  const words = positional(args);

  if (name === "git") {
    const { kind, paths } = classifyGit(args);
    return { kind, indirect: false, paths };
  }
  if (
    name === "curl" ||
    name === "wget" ||
    name === "http" ||
    name === "https"
  ) {
    return {
      kind:
        name === "http" || name === "https"
          ? words.length > 1 &&
            /^(POST|PUT|PATCH|DELETE)$/i.test(words[0] ?? "")
            ? "external-write"
            : "external-read"
          : classifyCurl(name, args),
      indirect: false,
      paths: [],
    };
  }
  if (name === "gh") {
    const [area, verb] = words;
    if (area === "auth" && verb === "token") {
      return { kind: "credential", ...none };
    }
    if (area === "repo" && verb === "delete") {
      return { kind: "destructive", ...none };
    }
    const reads =
      verb === undefined ||
      /^(view|list|status|diff|checks|watch|download)$/.test(verb);
    const apiWrite =
      area === "api" &&
      (hasOption(
        args,
        "-X",
        "--method",
        "-f",
        "-F",
        "--field",
        "--raw-field",
        "--input",
      ) ||
        args.some((arg) => /^-X./.test(arg)));
    return {
      kind:
        area === "api"
          ? apiWrite
            ? "external-write"
            : "external-read"
          : reads
            ? "external-read"
            : "external-write",
      ...none,
    };
  }
  if (name === "stripe") {
    return {
      kind: words.some((word) =>
        /^(list|retrieve|get|logs|listen|status|version|help)$/.test(word),
      )
        ? "external-read"
        : "financial",
      ...none,
    };
  }
  if (name === "security") {
    return {
      kind: /^(find-|dump-|export|show-keychain)/.test(words[0] ?? "")
        ? "credential"
        : "unknown",
      ...none,
    };
  }
  if (
    name === "env" &&
    words.filter((word) => !word.includes("=")).length === 0
  ) {
    return { kind: "credential", ...none }; // prints the environment
  }
  if (name === "set" && args.length === 0) {
    return { kind: "credential", ...none };
  }
  if (CREDENTIAL_TOOLS.has(name)) {
    return { kind: "credential", ...none };
  }
  if (TRANSPARENT.has(name)) {
    return { kind: "none", ...none };
  }
  if (SHELLS.has(name)) {
    // A shell with a literal `-c` is decomposed; anything else runs a script.
    return {
      kind: args.includes("-c") ? "none" : "unknown",
      indirect: !args.includes("-c"),
      paths: [],
    };
  }
  if (PRIVILEGE.has(name)) {
    const skip =
      name === "chmod" || name === "chown" || name === "chgrp" ? 1 : 0;
    return { kind: "privilege", indirect: false, paths: words.slice(skip) };
  }
  if (DESTRUCTIVE.has(name)) {
    return { kind: "destructive", indirect: false, paths: words };
  }
  if (REMOTE_SHELLS.has(name)) {
    return {
      kind: "external-write",
      indirect: false,
      paths: words.filter(
        (word) => !REMOTE_SPEC.test(word) && looksLikePath(word),
      ),
    };
  }
  if (CLOUD.has(name)) {
    const verbs = words.slice(0, 3);
    if (verbs.some((verb) => CLOUD_DESTRUCTIVE.test(verb))) {
      return { kind: "destructive", ...none };
    }
    return {
      kind: verbs.some(
        (verb) => CLOUD_READS.has(verb) || /^(describe|list|get)-/.test(verb),
      )
        ? "external-read"
        : "external-write",
      ...none,
    };
  }
  if (DATABASE.has(name)) {
    return { kind: "unknown", ...none };
  }
  if (name === "find") {
    return {
      kind: hasOption(args, "-delete")
        ? "destructive"
        : hasOption(args, "-fprint", "-fprintf", "-fls")
          ? "local-write"
          : "local-read",
      indirect: false,
      paths: words
        .filter((word, index) => index === 0 || looksLikePath(word))
        .filter(looksLikePath),
    };
  }
  if (name === "sed") {
    const inPlace = args.some(
      (arg) =>
        arg.startsWith("-i") ||
        arg === "--in-place" ||
        arg.startsWith("--in-place="),
    );
    const scriptGiven = hasOption(args, "-e", "-f", "--expression", "--file");
    return {
      kind: inPlace ? "local-write" : "local-read",
      indirect: false,
      paths: words.slice(scriptGiven ? 0 : 1).filter((word) => word !== ""),
    };
  }
  if (
    name === "grep" ||
    name === "egrep" ||
    name === "fgrep" ||
    name === "rg" ||
    name === "ag"
  ) {
    const patternGiven = hasOption(args, "-e", "-f", "--regexp", "--file");
    return {
      kind: "local-read",
      indirect: false,
      paths: words.slice(patternGiven ? 0 : 1),
    };
  }
  if (
    INDIRECT.has(name) ||
    name.endsWith(".sh") ||
    segment.program?.includes("/") === true
  ) {
    const publishes =
      (name === "npm" ||
        name === "pnpm" ||
        name === "yarn" ||
        name === "bun" ||
        name === "cargo") &&
      words[0] === "publish";
    return {
      kind: publishes ? "external-write" : "unknown",
      indirect: true,
      paths: words.filter(looksLikePath),
    };
  }
  if (READS.has(name)) {
    const prints =
      name === "echo" ||
      name === "printf" ||
      name === "test" ||
      name === "[" ||
      name === "expr" ||
      name === "seq" ||
      name === "date" ||
      name === "sleep";
    return {
      kind:
        name === "cd" || name === ":" || name === "true" || name === "false"
          ? "none"
          : "local-read",
      indirect: false,
      paths: prints ? [] : words,
    };
  }
  if (LOCAL_WRITES.has(name)) {
    return { kind: "local-write", indirect: false, paths: words };
  }
  return {
    kind: "unknown",
    indirect: false,
    paths: words.filter(looksLikePath),
  };
}

function classifySegment(segment: ShellSegment): ClassifiedSegment {
  const program = classifyProgram(segment);
  let kind = program.kind;
  const paths = [...program.paths];

  // Whatever the program is, an argument that is written like a path may be
  // one: `curl -T ~/.ssh/id_ed25519`, `gh release upload v1 ./secret.pem`. For
  // a rule that restricts, one path too many is the safe mistake.
  for (const arg of segment.args) {
    // `-d @file`, `-F upload=@file`, `--data-binary=@file`
    const attached = /(?:^|=)@(.+)$/.exec(arg)?.[1];
    if (attached !== undefined && attached !== "-") {
      paths.push(attached);
    } else if (!isOption(arg) && looksLikePath(arg)) {
      paths.push(arg);
    }
  }

  for (const redirect of segment.redirects) {
    const { operator, target } = redirect;
    if (
      operator === "<<" ||
      target === undefined ||
      NEVER_A_PATH.test(target)
    ) {
      continue;
    }
    if (operator === ">&" && /^\d+$/.test(target)) {
      continue;
    }
    paths.push(target);
    if (operator.startsWith("<") && operator !== "<>") {
      kind = escalate(kind, "local-read");
    } else if (operator === ">>" || TEMPORARY.test(target)) {
      kind = escalate(kind, "local-write");
    } else {
      // `>` empties what was there. Whether anything was there is not known.
      kind = escalate(kind, "destructive");
    }
  }

  const hosts = new Set<string>();
  for (const arg of segment.args) {
    const url = URL.exec(arg);
    const remote =
      url === null && REMOTE_SHELLS.has(segment.name ?? "")
        ? REMOTE_SPEC.exec(arg)
        : null;
    const host = url?.[1] ?? remote?.[1];
    if (host !== undefined) {
      hosts.add(host.toLowerCase());
    }
  }
  if (segment.name === "ssh") {
    const target = positional(segment.args)[0];
    const host = target?.slice(target.lastIndexOf("@") + 1);
    if (host !== undefined && host !== "") {
      hosts.add(host.toLowerCase());
    }
  }

  for (const path of paths) {
    const implied = classifyPath(path);
    if (implied !== undefined) {
      kind = escalate(kind, implied);
    }
  }

  return {
    segment,
    sideEffectClass: kind,
    paths: [...new Set(paths)],
    networkHosts: [...hosts],
    indirect: program.indirect,
  };
}

/**
 * A command a host runs without a shell, given as its argument vector. There
 * is nothing to parse and nothing a shell would expand: every word is literal,
 * so the command is understood by construction.
 */
export function classifyArgv(argv: readonly string[]): ClassifiedCommand {
  const [program, ...args] = argv;
  if (program === undefined || program === "") {
    return {
      segments: [],
      understood: false,
      reasons: ["syntax"],
      sideEffectClass: "unknown",
    };
  }
  const name = program.slice(program.lastIndexOf("/") + 1);
  // A shell given a script is a command line again, and is read as one.
  if (SHELLS.has(name) && args.includes("-c")) {
    const script = args[args.indexOf("-c") + 1];
    return script === undefined
      ? {
          segments: [],
          understood: false,
          reasons: ["syntax"],
          sideEffectClass: "unknown",
        }
      : classifyCommand(script);
  }
  const classified = classifySegment({
    name,
    program,
    args,
    text: [name, ...args].join(" "),
    assignments: [],
    redirects: [],
    input: undefined,
    understood: true,
    reasons: [],
  });
  return {
    segments: [classified],
    understood: true,
    reasons: [],
    sideEffectClass: classified.sideEffectClass,
  };
}

export function classifyCommand(source: string): ClassifiedCommand {
  const parsed = parseShellCommand(source);
  const segments = parsed.segments.map(classifySegment);
  // Nothing read means nothing known, and what is not understood is at least
  // unknown: a class is never better than the understanding behind it.
  let overall: SideEffectClass =
    segments.length === 0 || !parsed.understood ? "unknown" : "none";
  for (const { sideEffectClass } of segments) {
    overall = escalate(overall, sideEffectClass);
  }
  return {
    segments,
    understood: parsed.understood,
    reasons: parsed.reasons,
    sideEffectClass: overall,
  };
}
