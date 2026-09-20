/**
 * RFX-096 — a shell command, decomposed into the simple commands it runs.
 *
 * Text matching cannot tell `git status` from `git status; rm -rf ~`. This
 * parser can, because it reads the command the way a shell does: quoting,
 * separators, pipes, redirections, substitutions, subshells, here-documents.
 *
 * It never guesses (ADR-011). Every construct is either **decomposed** into
 * segments, so that a rule can see each program that runs, or **reported as
 * not understood**, so that no allow rule can match. What is nested is
 * decomposed too: the `rm` inside `$(...)`, inside `bash -c '...'`, after
 * `xargs`, is a segment like any other. A deny rule then matches if any segment
 * matches; an allow rule needs every segment understood.
 *
 * Pure, linear in the length of the command, bounded in depth, never throws.
 */
export const SHELL_LIMITS = {
  /** Beyond this nothing is parsed: the command is simply not understood. */
  sourceLength: 1024 * 1024,
  /** Substitutions inside substitutions inside wrappers. */
  depth: 8,
  segments: 512,
} as const;

export const NOT_UNDERSTOOD_REASONS = [
  /** Unbalanced quotes or parentheses, an operator with nothing after it. */
  "syntax",
  /** `$(...)`, backticks or `<(...)`: the text is produced at run time. */
  "substitution",
  /** `$VAR`, `${VAR}`, `$1`: the value is not in the command. */
  "variable",
  /** `*`, `?`, `[...]`, `{a,b}`: the arguments are produced at run time. */
  "glob",
  /** `if`, `for`, `while`, `case`, functions. Their commands are still segments. */
  "control-flow",
  /** `eval`, `source`, a shell fed by a pipe or a here-document. */
  "dynamic-command",
  /** `xargs`, `find -exec`: the program is known, its arguments are not. */
  "runtime-arguments",
  /** `$'...'` with escapes this parser does not decode, `$((...))`. */
  "unsupported-quoting",
  "too-long",
  "too-deep",
  "too-many-segments",
] as const;
export type NotUnderstoodReason = (typeof NOT_UNDERSTOOD_REASONS)[number];

export interface ShellRedirect {
  /** `>`, `>>`, `<`, `<<`, `<<<`, `>&`, `&>`, `>|`, `<>`. */
  readonly operator: string;
  /** The file, when it is written out literally. */
  readonly target: string | undefined;
  readonly fd: number | undefined;
}

export interface ShellAssignment {
  readonly name: string;
  readonly value: string | undefined;
}

export type ShellInput = "pipe" | "here-document" | "here-string" | "file";

export interface ShellSegment {
  /** The program without its directory: `/bin/rm` is `rm`. */
  readonly name: string | undefined;
  /** The program as written. */
  readonly program: string | undefined;
  /** The arguments that are written out literally, after quote removal. */
  readonly args: readonly string[];
  /** `name` and `args` joined by single spaces. */
  readonly text: string;
  readonly assignments: readonly ShellAssignment[];
  readonly redirects: readonly ShellRedirect[];
  readonly input: ShellInput | undefined;
  readonly understood: boolean;
  readonly reasons: readonly NotUnderstoodReason[];
}

export interface ParsedCommand {
  readonly segments: readonly ShellSegment[];
  /** True only when every segment is understood and nothing was skipped. */
  readonly understood: boolean;
  readonly reasons: readonly NotUnderstoodReason[];
}

interface Word {
  readonly text: string;
  readonly literal: boolean;
  /** True when any part of the word was quoted: `"if"` is not a keyword. */
  readonly quoted: boolean;
}

const RESERVED = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "while",
  "until",
  "do",
  "done",
  "for",
  "select",
  "case",
  "esac",
  "in",
  "function",
  "time",
  "!",
  "{",
  "}",
  "[[",
  "]]",
]);

/** Programs that run the command given in their remaining arguments. */
const PREFIX_WRAPPERS = new Set([
  "sudo",
  "doas",
  "nohup",
  "nice",
  "ionice",
  "time",
  "command",
  "builtin",
  "exec",
  "stdbuf",
  "setsid",
  "caffeinate",
  "chronic",
  "unbuffer",
]);

/** Shells: `-c STRING` is a command to parse, and stdin is a program. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const OPERATOR_START = new Set([";", "&", "|", "(", ")", "<", ">", "\n"]);

const basename = (program: string): string =>
  program.slice(program.lastIndexOf("/") + 1);

class Parser {
  readonly segments: ShellSegment[] = [];
  readonly reasons = new Set<NotUnderstoodReason>();
  readonly #source: string;
  readonly #depth: number;
  #at = 0;
  #pendingHereDocuments: { delimiter: string; stripTabs: boolean }[] = [];
  /** Set when the segment that owns the pending here-document is a shell. */
  #hereDocumentIsCode = false;
  #nextInput: ShellInput | undefined;

  constructor(source: string, depth: number) {
    this.#source = source;
    this.#depth = depth;
  }

  run(): void {
    while (this.#at < this.#source.length) {
      this.#command();
    }
    if (this.#pendingHereDocuments.length > 0) {
      // A here-document that never starts: the command is cut short.
      this.#flag("syntax");
    }
  }

  #flag(reason: NotUnderstoodReason): void {
    this.reasons.add(reason);
  }

  #peek(offset = 0): string {
    return this.#source[this.#at + offset] ?? "";
  }

  #skipBlanks(): void {
    for (;;) {
      const char = this.#peek();
      if (char === " " || char === "\t" || char === "\r") {
        this.#at += 1;
      } else if (char === "\\" && this.#peek(1) === "\n") {
        this.#at += 2;
      } else {
        return;
      }
    }
  }

  /** Reads a nested command and adds its segments to this one's. */
  #nested(source: string): void {
    if (this.#depth + 1 > SHELL_LIMITS.depth) {
      this.#flag("too-deep");
      return;
    }
    const inner = new Parser(source, this.#depth + 1);
    inner.run();
    for (const segment of inner.segments) {
      this.#push(segment);
    }
    for (const reason of inner.reasons) {
      this.#flag(reason);
    }
  }

  #push(segment: ShellSegment): void {
    if (this.segments.length >= SHELL_LIMITS.segments) {
      this.#flag("too-many-segments");
      return;
    }
    this.segments.push(segment);
  }

  /** From just after an opening delimiter to its match, nesting and quotes respected. */
  #balanced(open: string, close: string): string | undefined {
    const start = this.#at;
    let level = 1;
    while (this.#at < this.#source.length) {
      const char = this.#peek();
      if (char === "\\") {
        this.#at += 2;
        continue;
      }
      if (char === "'") {
        const end = this.#source.indexOf("'", this.#at + 1);
        if (end === -1) {
          break;
        }
        this.#at = end + 1;
        continue;
      }
      if (char === open) {
        level += 1;
      } else if (char === close) {
        level -= 1;
        if (level === 0) {
          const inner = this.#source.slice(start, this.#at);
          this.#at += 1;
          return inner;
        }
      }
      this.#at += 1;
    }
    this.#flag("syntax");
    this.#at = this.#source.length;
    return undefined;
  }

  /** `$...` at the cursor. Returns true when the word is no longer literal. */
  #dollar(): boolean {
    const next = this.#peek(1);
    if (next === "(") {
      if (this.#peek(2) === "(") {
        this.#at += 3;
        this.#balanced("(", ")");
        if (this.#peek() === ")") {
          this.#at += 1;
        }
        this.#flag("unsupported-quoting");
        return true;
      }
      this.#at += 2;
      const inner = this.#balanced("(", ")");
      this.#flag("substitution");
      if (inner !== undefined) {
        this.#nested(inner);
      }
      return true;
    }
    if (next === "{") {
      this.#at += 2;
      this.#balanced("{", "}");
      this.#flag("variable");
      return true;
    }
    if (/[A-Za-z0-9_@*#?$!-]/.test(next)) {
      this.#at += 2;
      while (/[A-Za-z0-9_]/.test(this.#peek())) {
        this.#at += 1;
      }
      this.#flag("variable");
      return true;
    }
    return false;
  }

  #backtick(): void {
    this.#at += 1;
    const start = this.#at;
    while (this.#at < this.#source.length && this.#peek() !== "`") {
      this.#at += this.#peek() === "\\" ? 2 : 1;
    }
    if (this.#at >= this.#source.length) {
      this.#flag("syntax");
      return;
    }
    const inner = this.#source.slice(start, this.#at);
    this.#at += 1;
    this.#flag("substitution");
    this.#nested(inner);
  }

  #word(): Word | undefined {
    let text = "";
    let literal = true;
    let quoted = false;
    const start = this.#at;

    while (this.#at < this.#source.length) {
      const char = this.#peek();
      if (char === " " || char === "\t" || char === "\r") {
        break;
      }
      if (OPERATOR_START.has(char)) {
        // `<(...)` and `>(...)` are part of a word.
        if ((char === "<" || char === ">") && this.#peek(1) === "(") {
          this.#at += 2;
          const inner = this.#balanced("(", ")");
          this.#flag("substitution");
          if (inner !== undefined) {
            this.#nested(inner);
          }
          literal = false;
          continue;
        }
        break;
      }
      if (char === "\\") {
        if (this.#peek(1) === "\n") {
          this.#at += 2;
          continue;
        }
        text += this.#peek(1);
        quoted = true;
        this.#at += 2;
        continue;
      }
      if (char === "'") {
        const end = this.#source.indexOf("'", this.#at + 1);
        if (end === -1) {
          this.#flag("syntax");
          this.#at = this.#source.length;
          return { text, literal: false, quoted: true };
        }
        text += this.#source.slice(this.#at + 1, end);
        quoted = true;
        this.#at = end + 1;
        continue;
      }
      if (char === '"') {
        quoted = true;
        this.#at += 1;
        let closed = false;
        while (this.#at < this.#source.length) {
          const inner = this.#peek();
          if (inner === '"') {
            this.#at += 1;
            closed = true;
            break;
          }
          if (inner === "\\" && /["\\$`\n]/.test(this.#peek(1))) {
            text += this.#peek(1) === "\n" ? "" : this.#peek(1);
            this.#at += 2;
          } else if (inner === "$" && this.#dollar()) {
            literal = false;
          } else if (inner === "`") {
            this.#backtick();
            literal = false;
          } else {
            text += inner;
            this.#at += 1;
          }
        }
        if (!closed) {
          this.#flag("syntax");
          return { text, literal: false, quoted: true };
        }
        continue;
      }
      if (char === "$") {
        if (this.#peek(1) === "'" || this.#peek(1) === '"') {
          // `$'...'` decodes escapes; `$"..."` translates. Neither is literal.
          this.#flag("unsupported-quoting");
          literal = false;
          this.#at += 1;
          continue;
        }
        if (this.#dollar()) {
          literal = false;
          continue;
        }
        text += char;
        this.#at += 1;
        continue;
      }
      if (char === "`") {
        this.#backtick();
        literal = false;
        continue;
      }
      const testCommand =
        char === "[" &&
        this.#at === start &&
        /^\[(?:\s|$)/.test(this.#source.slice(this.#at, this.#at + 2));
      // A URL is not a file name pattern: `?` and `*` in it reach the program
      // as written, because no file is called `https://...`.
      const inUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
      if (
        (char === "*" || char === "?" || char === "[") &&
        !testCommand &&
        !inUrl
      ) {
        this.#flag("glob");
        literal = false;
      }
      if (
        char === "{" &&
        /\{[^{}\s]*[,.][^{}\s]*\}/.test(
          this.#source.slice(this.#at, this.#at + 256),
        )
      ) {
        this.#flag("glob");
        literal = false;
      }
      if (char === "#" && this.#at === start) {
        // A comment runs to the end of the line.
        const end = this.#source.indexOf("\n", this.#at);
        this.#at = end === -1 ? this.#source.length : end;
        return undefined;
      }
      text += char;
      this.#at += 1;
    }

    return this.#at === start ? undefined : { text, literal, quoted };
  }

  /** A here-document's body is data. It starts after the current line. */
  #skipHereDocuments(): string[] {
    const bodies: string[] = [];
    for (const { delimiter, stripTabs } of this.#pendingHereDocuments) {
      const lines: string[] = [];
      let found = false;
      while (this.#at < this.#source.length) {
        const end = this.#source.indexOf("\n", this.#at);
        const raw = this.#source.slice(
          this.#at,
          end === -1 ? this.#source.length : end,
        );
        this.#at = end === -1 ? this.#source.length : end + 1;
        const line = stripTabs ? raw.replace(/^\t+/, "") : raw;
        if (line === delimiter) {
          found = true;
          break;
        }
        lines.push(line);
      }
      if (!found) {
        this.#flag("syntax");
      }
      bodies.push(lines.join("\n"));
    }
    this.#pendingHereDocuments = [];
    return bodies;
  }

  #redirect(fd: number | undefined): ShellRedirect | undefined {
    const match = /^(<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/.exec(
      this.#source.slice(this.#at, this.#at + 3),
    );
    if (match?.[1] === undefined) {
      this.#flag("syntax");
      this.#at += 1;
      return undefined;
    }
    this.#at += match[1].length;
    const stripTabs = match[1] === "<<-";
    const operator = stripTabs ? "<<" : match[1];
    this.#skipBlanks();
    const target = this.#word();
    if (target === undefined) {
      this.#flag("syntax");
      return undefined;
    }
    if (operator === "<<") {
      this.#pendingHereDocuments.push({ delimiter: target.text, stripTabs });
      return { operator, target: undefined, fd };
    }
    return {
      operator,
      target: target.literal ? target.text : undefined,
      fd,
    };
  }

  #command(): void {
    this.#skipBlanks();
    const char = this.#peek();

    if (char === "") {
      return;
    }
    if (char === "\n") {
      this.#at += 1;
      const code = this.#hereDocumentIsCode;
      this.#hereDocumentIsCode = false;
      for (const body of this.#skipHereDocuments()) {
        // `bash <<EOF` runs its body. `cat <<EOF` only prints it.
        if (code) {
          this.#nested(body);
        }
      }
      return;
    }
    if (char === ";" || char === "&" || char === "|") {
      const piped = char === "|" && this.#peek(1) !== "|";
      this.#at += 1;
      if (this.#peek() === char || (char === "|" && this.#peek() === "&")) {
        this.#at += 1;
      }
      this.#nextInput = piped ? "pipe" : undefined;
      return;
    }
    if (char === "(") {
      this.#at += 1;
      const inner = this.#balanced("(", ")");
      if (inner !== undefined) {
        this.#nested(inner);
      }
      return;
    }
    if (char === ")") {
      // A stray `)` is a `case` pattern, or a mistake. Either way, skipped.
      this.#flag(this.reasons.has("control-flow") ? "control-flow" : "syntax");
      this.#at += 1;
      return;
    }

    const words: Word[] = [];
    const redirects: ShellRedirect[] = [];
    const before = new Set(this.reasons);
    let input = this.#nextInput;
    this.#nextInput = undefined;

    for (;;) {
      this.#skipBlanks();
      const next = this.#peek();
      if (
        next === "" ||
        next === "\n" ||
        next === ";" ||
        next === "|" ||
        next === ")"
      ) {
        break;
      }
      if (next === "&" && this.#peek(1) !== ">") {
        break;
      }
      if (next === "(") {
        // `name() { ...; }` defines a function. Its body is still parsed.
        this.#flag("control-flow");
        this.#at += 1;
        continue;
      }
      if (
        next === "<" ||
        next === ">" ||
        (next === "&" && this.#peek(1) === ">")
      ) {
        if (next === "&") {
          this.#at += 1;
        }
        if ((next === "<" || next === ">") && this.#peek(1) === "(") {
          const word = this.#word();
          if (word !== undefined) {
            words.push(word);
          }
          continue;
        }
        const redirect = this.#redirect(undefined);
        if (redirect !== undefined) {
          redirects.push(redirect);
        }
        continue;
      }
      // `2>file`: a number directly before a redirection is a descriptor.
      const descriptor = /^(\d{1,2})[<>]/.exec(
        this.#source.slice(this.#at, this.#at + 3),
      );
      if (descriptor?.[1] !== undefined) {
        this.#at += descriptor[1].length;
        const redirect = this.#redirect(Number(descriptor[1]));
        if (redirect !== undefined) {
          redirects.push(redirect);
        }
        continue;
      }
      const word = this.#word();
      if (word === undefined) {
        break;
      }
      if (words.length === 0 && !word.quoted && RESERVED.has(word.text)) {
        this.#flag("control-flow");
        if (
          word.text === "for" ||
          word.text === "select" ||
          word.text === "case"
        ) {
          // `for x in a b c` and `case $x in`: what follows is not a command.
          for (;;) {
            this.#skipBlanks();
            const skipped = this.#peek();
            if (skipped === "" || skipped === "\n" || skipped === ";") {
              break;
            }
            const following = this.#word();
            if (
              following === undefined ||
              (following.text === "in" && word.text === "case")
            ) {
              break;
            }
          }
        }
        continue;
      }
      words.push(word);
    }

    for (const redirect of redirects) {
      if (redirect.operator === "<<") {
        input = "here-document";
      } else if (redirect.operator === "<<<") {
        input = "here-string";
      } else if (redirect.operator === "<") {
        input ??= "file";
      }
    }
    if (words.length === 0 && redirects.length === 0) {
      return;
    }
    const own = [...this.reasons].filter((reason) => !before.has(reason));
    this.#segment(words, redirects, input, own);
  }

  #segment(
    words: readonly Word[],
    redirects: readonly ShellRedirect[],
    input: ShellInput | undefined,
    ownReasons: readonly NotUnderstoodReason[],
  ): void {
    const assignments: ShellAssignment[] = [];
    let first = 0;
    while (first < words.length) {
      const word = words[first];
      const match = word === undefined ? null : ASSIGNMENT.exec(word.text);
      if (word === undefined || match?.[1] === undefined) {
        break;
      }
      assignments.push({
        name: match[1],
        value: word.literal ? match[2] : undefined,
      });
      first += 1;
    }

    const reasons = new Set<NotUnderstoodReason>(ownReasons);
    const command = words[first];
    const rest = words.slice(first + 1);
    const program = command?.literal === true ? command.text : undefined;
    const name = program === undefined ? undefined : basename(program);
    const args = rest.filter((word) => word.literal).map((word) => word.text);

    if (command !== undefined && program === undefined && reasons.size === 0) {
      reasons.add("variable");
    }
    if (rest.some((word) => !word.literal) && reasons.size === 0) {
      reasons.add("variable");
    }
    if (
      redirects.some(
        (redirect) =>
          redirect.operator !== "<<" && redirect.target === undefined,
      )
    ) {
      reasons.add("variable");
    }

    // What runs is given at run time, by a pipe or a here-document.
    if (name !== undefined && SHELLS.has(name) && !args.includes("-c")) {
      const scripts = args.filter((arg) => !arg.startsWith("-"));
      if (
        scripts.length === 0 &&
        (input === "pipe" ||
          input === "here-document" ||
          input === "here-string")
      ) {
        reasons.add("dynamic-command");
      }
    }
    if (name === "eval" || name === "source" || name === ".") {
      reasons.add("dynamic-command");
    }
    if (name !== undefined && SHELLS.has(name)) {
      const flagAt = rest.findIndex(
        (word) => word.text === "-c" || /^-[a-z]*c$/.test(word.text),
      );
      const script = flagAt === -1 ? undefined : rest[flagAt + 1];
      if (flagAt !== -1 && script?.literal !== true) {
        reasons.add("dynamic-command");
      }
    }
    if (name !== undefined && SHELLS.has(name) && input === "here-document") {
      this.#hereDocumentIsCode = true;
    }

    // A program produced at run time is still a segment: its arguments are
    // visible, and a restrictive rule about them must be able to match.
    if (
      command !== undefined ||
      assignments.length > 0 ||
      redirects.length > 0
    ) {
      for (const reason of reasons) {
        this.#flag(reason);
      }
      this.#push({
        name,
        program,
        args,
        text: [name ?? "", ...args].join(" ").trim(),
        assignments,
        redirects,
        input,
        understood: reasons.size === 0,
        reasons: [...reasons],
      });
    }

    if (name !== undefined) {
      this.#unwrap(name, rest, input);
    }
  }

  /** The command a wrapper runs becomes a segment of its own. */
  #unwrap(
    name: string,
    rest: readonly Word[],
    input: ShellInput | undefined,
  ): void {
    const literalRest = rest.every((word) => word.literal);

    if (SHELLS.has(name) || name === "eval") {
      const flagAt =
        name === "eval"
          ? -1
          : rest.findIndex(
              (word) => word.text === "-c" || /^-[a-z]*c$/.test(word.text),
            );
      const script =
        name === "eval" ? rest : rest.slice(flagAt + 1, flagAt + 2);
      if (name !== "eval" && flagAt === -1) {
        return;
      }
      if (script.length === 0 || script.some((word) => !word.literal)) {
        this.#flag("dynamic-command");
        return;
      }
      this.#nested(script.map((word) => word.text).join(" "));
      return;
    }

    if (
      PREFIX_WRAPPERS.has(name) ||
      name === "env" ||
      name === "timeout" ||
      name === "watch" ||
      name === "xargs"
    ) {
      let index = 0;
      // Skip the wrapper's own options, and `env`'s assignments.
      while (index < rest.length) {
        const text = rest[index]?.text ?? "";
        if (text.startsWith("-") || (name === "env" && ASSIGNMENT.test(text))) {
          const takesValue =
            (name === "sudo" && /^-[ugpCDhRTU]$/.test(text)) ||
            (name === "env" && /^-[uS]$/.test(text)) ||
            (name === "xargs" && /^-[IELnPsd]$/.test(text)) ||
            (name === "nice" && text === "-n") ||
            (name === "timeout" && /^-[ks]$/.test(text)) ||
            (name === "watch" && /^-[nd]$/.test(text));
          index += takesValue ? 2 : 1;
        } else {
          break;
        }
      }
      if (name === "timeout") {
        index += 1; // the duration
      }
      const inner = rest.slice(index);
      if (inner.length === 0) {
        return;
      }
      if (!literalRest) {
        this.#flag("variable");
      }
      const reasons: NotUnderstoodReason[] =
        name === "xargs" ? ["runtime-arguments"] : [];
      // `curl ... | sudo bash`: the pipe feeds the shell, through the wrapper.
      // `xargs` consumes its input itself and hands over arguments instead.
      this.#segment(inner, [], name === "xargs" ? undefined : input, reasons);
      return;
    }

    if (name === "find") {
      for (let index = 0; index < rest.length; index += 1) {
        const text = rest[index]?.text ?? "";
        if (/^-(exec|execdir|ok|okdir)$/.test(text)) {
          const end = rest.findIndex(
            (word, position) =>
              position > index && (word.text === ";" || word.text === "+"),
          );
          const inner = rest
            .slice(index + 1, end === -1 ? rest.length : end)
            .filter((word) => word.text !== "{}");
          if (inner.length > 0) {
            this.#segment(inner, [], undefined, ["runtime-arguments"]);
          }
          index = end === -1 ? rest.length : end;
        }
      }
    }
  }
}

export function parseShellCommand(source: string): ParsedCommand {
  if (source.length > SHELL_LIMITS.sourceLength) {
    return { segments: [], understood: false, reasons: ["too-long"] };
  }
  const parser = new Parser(source, 0);
  try {
    parser.run();
  } catch {
    // Never throw on the decision path. What could not be read is not understood.
    parser.reasons.add("syntax");
  }
  const reasons = [...parser.reasons];
  return {
    segments: parser.segments,
    understood:
      reasons.length === 0 &&
      parser.segments.length > 0 &&
      parser.segments.every((segment) => segment.understood),
    reasons,
  };
}
