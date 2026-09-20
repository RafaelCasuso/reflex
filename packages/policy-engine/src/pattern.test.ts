import { describe, expect, it } from "vitest";

import { PATTERN_LIMITS, compilePattern } from "./pattern.js";

/** RFX-098 — bounded regular expressions. */
function compiled(source: string) {
  const result = compilePattern(source);
  if (!result.ok) {
    throw new Error(`${source} does not compile: ${result.message}`);
  }
  return result.pattern;
}

const messageOf = (source: string): string => {
  const result = compilePattern(source);
  return result.ok ? "" : result.message;
};

describe("RFX-098 bounded patterns", () => {
  it("finds a pattern anywhere in the text, and anchors when asked", () => {
    const token = compiled("sk-live-[0-9a-f]{12}");
    expect(token.test("curl -H 'Bearer sk-live-5e8b1f0a9c3d' https://x")).toBe(
      true,
    );
    expect(token.test("curl https://example.test")).toBe(false);

    const gitReads = compiled("^git (status|diff|log)( |$)");
    expect(gitReads.test("git status")).toBe(true);
    expect(gitReads.test("git status --short")).toBe(true);
    expect(gitReads.test("echo git status")).toBe(false);
    expect(gitReads.test("git statusx")).toBe(false);
  });

  it("supports inline flags and Unicode classes", () => {
    expect(compiled("(?i)drop\\s+table").test("DROP   TABLE users")).toBe(true);
    expect(compiled("^\\p{L}+$").test("héllo")).toBe(true);
  });

  // `$` must not be fooled by a trailing newline: "git status\nrm -rf ~".
  it("does not let a newline end the text early", () => {
    const whole = compiled("^git status$");
    expect(whole.test("git status")).toBe(true);
    expect(whole.test("git status\nrm -rf ~")).toBe(false);
    expect(whole.test("git status\n")).toBe(false);
  });

  it.each([
    ["a backreference", "(a)\\1", /backreferences are not supported/],
    ["a lookahead", "a(?=b)", /lookaheads and lookbehinds/],
    ["a negative lookahead", "a(?!b)", /lookaheads and lookbehinds/],
    ["a lookbehind", "(?<=a)b", /lookaheads and lookbehinds/],
    ["an unclosed group", "(a", /not a valid regular expression/],
    ["a dangling quantifier", "*a", /not a valid regular expression/],
    ["a huge repeat", "a{100000}", /repeat count is too large/],
    ["nested repeats", "(a{1000}){1000}", /repeat count is too large/],
    ["an empty pattern", "", /must not be empty/],
  ])("does not compile %s, and says why", (_label, source, message) => {
    expect(messageOf(source)).toMatch(message);
  });

  it("rejects a pattern whose program is too large", () => {
    expect(messageOf("[a-z0-9]{1,500}")).toMatch(/too complex \(size \d+/);
    expect(messageOf("(.*a){40}")).toMatch(/too complex/);
    expect(messageOf("x".repeat(PATTERN_LIMITS.sourceLength + 1))).toMatch(
      /at most 1024 characters/,
    );
  });

  it("never puts the pattern itself in an error message", () => {
    const secretLooking = "(sk-live-5e8b1f0a9c3d";
    expect(messageOf(secretLooking)).not.toContain("sk-live");
  });

  it("accepts the patterns a real policy needs", () => {
    for (const source of [
      "\\bAKIA[0-9A-Z]{16}\\b",
      "\\bgh[pousr]_[A-Za-z0-9]{36}\\b",
      "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
      "(?i)(password|passwd|secret|token|api[_-]?key)\\s*[=:]\\s*\\S+",
      "-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----",
      "xox[baprs]-[0-9A-Za-z-]{10,48}",
      "(?i)\\b(drop|truncate)\\s+(table|database|schema)\\b",
    ]) {
      expect(compilePattern(source).ok, source).toBe(true);
    }
  });

  // Adversarial. Each of these takes a backtracking engine from seconds to
  // longer than the age of the universe on the text below. Here the cost is
  // linear in the text, so a generous bound holds on any machine; the numbers
  // for the named benchmark machine are in `pattern.bench.ts`.
  describe("catastrophic backtracking corpus", () => {
    const text = `${"a".repeat(PATTERN_LIMITS.budgetedTextLength - 1)}!`;
    const words = `${"word ".repeat(PATTERN_LIMITS.budgetedTextLength / 5 - 1)}!`;

    it.each([
      ["(a+)+$", text],
      ["(a*)*$", text],
      ["(a|aa)+$", text],
      ["(a|a?)+$", text],
      ["^(a+)+b", text],
      ["(.*a){12}", text],
      ["^(([a-z])+.)+[A-Z]([a-z])+$", text],
      ["([a-z]+)*\\d", text],
      ["(\\w+\\s*)+$", words],
      ["^(\\w+\\s?)*$", words],
      ["(x+x+)+y", "x".repeat(PATTERN_LIMITS.budgetedTextLength)],
    ])("%s stays linear", (source, input) => {
      const pattern = compiled(source);
      pattern.test(input); // warm-up
      const started = performance.now();
      const found = pattern.test(input);
      const elapsed = performance.now() - started;
      expect(typeof found).toBe("boolean");
      expect(elapsed).toBeLessThan(100);
    });

    it("costs in proportion to the text, not exponentially", () => {
      const pattern = compiled("(a+)+$");
      const time = (length: number): number => {
        const input = `${"a".repeat(length)}!`;
        pattern.test(input);
        const started = performance.now();
        for (let run = 0; run < 5; run += 1) {
          pattern.test(input);
        }
        return (performance.now() - started) / 5;
      };
      const small = time(2_000);
      const large = time(32_000);
      // Sixteen times the text. Exponential growth would be astronomically
      // more; linear growth stays within a small multiple of sixteen.
      expect(large).toBeLessThan(Math.max(small, 0.05) * 16 * 6);
    });
  });
});
