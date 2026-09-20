import { RE2JS } from "re2js";

/**
 * RFX-098 — regular expressions that are safe on the hot path.
 *
 * A policy pattern is untrusted input twice over: the pattern comes from a
 * policy file, which a repository can ship (ADR-012), and the text comes from
 * the agent. A backtracking engine lets either of them buy seconds of CPU with
 * thirty characters.
 *
 * Patterns run on a linear-time engine (RE2 semantics, no backtracking), so
 * matching costs at most text length times program size, whatever the pattern
 * and whatever the text. What that engine cannot express in linear time does
 * not compile: backreferences and lookarounds. On top of that a pattern is
 * bounded in length and in compiled size, which bounds the constant too.
 *
 * Matching is unanchored, as in most tools: a pattern matches if it is found
 * anywhere in the text. Anchor with `^` and `$` to match the whole text.
 * Inline flags such as `(?i)` are supported.
 */
export const PATTERN_LIMITS = {
  /** Characters of pattern source. */
  sourceLength: 1_024,
  /**
   * Instructions of the compiled program. Real policy patterns measure 20 to
   * 100; `(.*a){20}` measures 102 and `([a-z]{1,1000}){3}` measures 6,001.
   */
  programSize: 128,
  /**
   * Up to this many characters of text, any pattern that compiles is evaluated
   * within the deterministic budget (`pattern.bench.ts` measures it and names
   * the machine). Beyond it matching is still linear. An `allow` rule
   * then does not match; a `deny` or `ask` rule is evaluated all the same,
   * because a restrictive rule that is skipped is a hole (ADR-011).
   */
  budgetedTextLength: 4_096,
} as const;

export interface CompiledPattern {
  readonly source: string;
  readonly programSize: number;
  /** True when the pattern is found anywhere in `text`. Never throws. */
  test(text: string): boolean;
}

export type PatternCompileResult =
  | { readonly ok: true; readonly pattern: CompiledPattern }
  | { readonly ok: false; readonly message: string };

/** The engine's messages quote the pattern. Ours say what to do instead. */
function explain(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  if (/invalid escape sequence: `\\\d/.test(text)) {
    return "backreferences are not supported: they cannot be matched in linear time";
  }
  if (/\(\?<?[=!]|unsupported Perl syntax|invalid named capture/.test(text)) {
    return "lookaheads and lookbehinds are not supported: they cannot be matched in linear time";
  }
  if (/invalid repeat count|bad repetition/.test(text)) {
    return "a repeat count is too large, or repeats are nested too deeply";
  }
  if (
    /missing closing|missing argument|unexpected|trailing backslash|invalid/.test(
      text,
    )
  ) {
    return `not a valid regular expression (${text
      .replace(/^error parsing regexp: /, "")
      .replace(/: `.*$/s, "")})`;
  }
  return "not a valid regular expression";
}

export function compilePattern(source: string): PatternCompileResult {
  if (source.length === 0) {
    return { ok: false, message: "a pattern must not be empty" };
  }
  if (source.length > PATTERN_LIMITS.sourceLength) {
    return {
      ok: false,
      message: `a pattern holds at most ${String(PATTERN_LIMITS.sourceLength)} characters`,
    };
  }

  let compiled: RE2JS;
  try {
    compiled = RE2JS.compile(source);
  } catch (error) {
    return { ok: false, message: explain(error) };
  }

  const programSize = compiled.programSize();
  if (programSize > PATTERN_LIMITS.programSize) {
    return {
      ok: false,
      message: `the pattern is too complex (size ${String(programSize)}, the limit is ${String(PATTERN_LIMITS.programSize)}): shorten bounded repeats such as {1,500}, or split it into two conditions`,
    };
  }

  return {
    ok: true,
    pattern: {
      source,
      programSize,
      test(text: string): boolean {
        try {
          return compiled.matcher(text).find();
        } catch {
          // An engine failure is not a match. Callers decide what a condition
          // that could not be evaluated means for their rule (ADR-011).
          return false;
        }
      },
    },
  };
}
