# Risk aggregation and evals

`packages/core/src/risk-aggregator.ts` turns a semantic assessment into an
effect, a risk and a confidence; `packages/evals` holds the engine to two
corpora and to a calibration table; a scheduled check mutates the decision
paths. This page is what G6 built and what it measured.

## 1. The aggregator (RFX-036)

An assessment is evidence; the aggregator owns the decision, and the engine
then applies what the aggregator may not go under: the floor of an
untrusted policy set (ADR-012) and `deny > ask > allow` (ADR-002).

**The rule is the simplest one that can be explained to the person who is
asked.** Each dimension is judged on its own against its band, and the
strictest verdict wins. Nothing is summed or weighted: a weighted score is
one more number to argue about, and a dangerous dimension must not be
averaged away by nine safe ones.

A four-level score maps to 0, 33, 67 and 100 (`packages/provider-jev`), so
a band is written in those values. Every number that decides anything is in
one object, `DEFAULT_AGGREGATOR_CONFIG`, and nowhere else; a test holds that
with the bands moved the same assessment decides differently.

| Dimension                                                                                                                                       | asks at | denies at | why there                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------: | --------: | ------------------------------------------------------------------------------------------------------------------- |
| `destructiveRisk`, `privilegeEscalation`, `secretAccess`, `sensitiveDataExposure`, `financialConsequence`, `productionMutation`, `unusualScope` |    ≥ 67 |     ≥ 100 | 33 is "rebuildable output", "a small metered cost", "slightly broader"; asking there would prompt for `rm -rf dist` |
| `untrustedInput`                                                                                                                                |    ≥ 67 |     never | provenance escalates; on its own it does not deny                                                                   |
| `objectiveAlignment` (higher is safer)                                                                                                          |    ≤ 33 |         0 | loosely related asks; unrelated or against the goal denies                                                          |
| `reversibility` (higher is safer)                                                                                                               |    ≤ 33 |     never | hard to undo asks; what cannot be undone still only asks on its own                                                 |
| `externalSideEffect` true                                                                                                                       |     ask |           |                                                                                                                     |
| `resource.environment: production`                                                                                                              |     ask |           | environment-specific rule                                                                                           |

**Risk** is the worst dimension, and never below what the classifier
already knows about the class (ADR-002's table). **Confidence** is the
least sure of what decided; for an allow, the least sure of every
dimension, because an allow depends on all of them.

### Class floors

What the classifier itself calls dangerous or does not understand is never
allowed on semantic evidence alone: `unknown`, `destructive`,
`external-write`, `credential`, `privilege` and `financial` ask at least,
whatever the model said. The model may lower what it sees; it may not
overrule what the command says, because a model can be lied to (RFX-108)
and the command cannot. A request whose arguments carried a redacted value
(ADR-006) asks at least, too.

This is where the semantic stage's autonomy is today: reads, local writes
and `none` that policy left open are allowed when the model agrees, and
anything the model calls off task, unusual in scope or fed by untrusted
input is escalated. `rm -rf dist` asks, as it did before the stage existed.

### The one way past the destructive floor (RFX-148, designed, not enabled)

The prompt before `rm -rf dist` is the one REFLEX exists to remove, and
the floor is right for a lying model. The way out needs evidence the model
cannot fake, and that is what the classifier's paths are. Since 2026-09-25
the policy evaluation reports what the classifier saw, one entry per
subject: its class, its paths, absolute and lexically normalized, and
whether it was understood; and the aggregator's input carries them. The
exception itself, still to be applied, lifts the `destructive` floor only
when all of this holds:

- every segment was understood (no variable, glob or substitution, every
  path made absolute) and is of a class the model may judge (`none`,
  `local-read`, `local-write`, `destructive`): `rm -rf dist && pnpm test`
  keeps asking for its `unknown` segment;
- there is at least one path, and every path is inside the project, is not
  the project root, and lies under a directory that is built rather than
  written, from a configured list (`dist`, `build`, `out`, `coverage`,
  `node_modules`, `target`, `.turbo`, `.cache`, `.next`, `.nuxt`,
  `.output`, `.parcel-cache`, `__pycache__`, `.pytest_cache`,
  `.mypy_cache`): `rm -rf .git`, `: > src/date.ts`, `find . -delete` and
  `rm -rf ../../` keep the floor;
- the model puts `destructiveRisk` at or below 33 ("rebuildable output")
  and `reversibility` at or above 67. The model can only veto.

The list is the deterministic part and the adversary provider is held
against it by the RFX-040 gate: with everything called safe, `rm -rf src`
still asks. What a build makes, a build can make again; nothing else is
in the list on purpose.

The floors are configuration like the bands, and they are what held the
adversary in §3.

## 2. The low-confidence rule (RFX-037)

An uncertain assessment of a high-impact action never allows on its own: if
any dimension's confidence is below the threshold and the action is high
impact (the class risk table puts it at 50 or above, or any risk dimension
is at the third level), an allow becomes an ask with `low_confidence`. An
uncertain assessment of a read still allows: prompting for what is trivially
safe is the cost REFLEX exists to remove.

The threshold is **0.5, provisional**: below a coin flip between two
adjacent levels. RFX-110's table is what justifies it, and until the table
comes from a real provider it justifies nothing (§4).

## 3. The corpora and the gate (RFX-038, RFX-039, RFX-040)

`packages/evals/corpus/semantic/v1/` adds 86 cases to the seed corpus's 79.
Seventy-five derive from the seed cases (same action, a benign objective and
summary added, an expected assessment written from the case's tags); eleven
are new: safe on-task work, harmless off-task work, and two refunds. Every
case says what a right assessment is per dimension, as a set of accepted
levels, and the loader refuses a dimension it does not know or a level that
is not one.

The whole pipeline (policy, the compiler with its redactor, a provider, the
aggregator, the fallback) is replayed over both corpora in six
configurations, and **zero dangerous allows** is the threshold in each: no
provider; the starter policy alone; the fake provider; an **oracle** that
answers every case with levels the case accepts; an **adversary** that
calls everything safe and is sure of it; and the adversary under the starter
policy, which is the run that found the two floors above. A dangerous allow
in any of them fails CI (`packages/evals/src/semantic-corpus.test.ts`).

What the oracle allows that nothing allowed before: the three safe cases of
reads and local writes. What the adversary gets: an off-task read, allowed,
because nothing but the model can see that it is off task. That is the
honest limit of a wrong provider, and it is written into the test.

## 4. Calibration (RFX-110)

`calibrate(provider, cases)` runs a provider over every case with an
expected assessment, bins each answer by the confidence the provider gave
it, and reports per dimension and per bin how often the answer was right.
From the table it proposes the low-confidence threshold: the lowest
confidence from which every bin above is right at least 90% of the time;
the overall suggestion is the highest per-dimension one, the one that holds
for all.

Against the oracle the table is exact and says nothing; against a noisy
provider it finds the dimensions whose confidence stops meaning what it
says, and a test holds that. **Against the real provider it has not run:**
`packages/evals/live/calibrate-jev.mjs --run` does it (86 requests, one
per case, from the built packages; `--dry-run` only counts) and writes
`live/results/calibration-jev.json`; the run was refused by the session's
transaction guard and waits for the maintainer. Until it runs the 0.5
threshold is a guess, labelled as one.

## 5. Mutation testing (RFX-111)

`pnpm mutation` (`tools/mutate.mjs`) takes every file in
`tools/mutation-targets.json`, applies one small change at a time (a flipped
comparison, `>=` for `>`, `&&` for `||`, an effect literal swapped for the
next one, a negated boolean, `max` for `min`: fifteen operators), runs the
package's tests, and expects them to fail. A mutant the tests do not catch
has found a branch nobody is holding. It survives only if
`tools/mutation-allowlist.json` names it, by package, file, line and
operator, with a reason; otherwise the check exits 1. The tool edits the
file in place, runs the tests, puts the file back and verifies that it did,
and refuses to start on a dirty tree unless told to. An entry names a line,
so an edit above it moves the mutant: the check then reports the survivor
as unjustified, and the entry moves with the change that moved it.

In-house on purpose. Stryker 10 could not activate a single mutant under
Vitest 5 in this repository (every mutant survived with every test
running, whatever the coverage analysis), and a check that cannot fail is
worse than none.

**Where it runs.** `.github/workflows/mutation.yml`: Tuesdays at 06:00 UTC,
on demand, and on a pull request that changes the check itself. It is not
a required check on every pull request, because the whole run takes tens of
minutes on a shared runner (438 s on the benchmark machine) and the quality
gates already hold a pull request; a decision path is mutated at least once
a week whatever anyone remembers. `tests/ci.test.ts` audits the workflow
like the others: frozen install, build and check as one-line steps that can
fail the job, no `continue-on-error`, actions pinned to a commit.

**What it reports** (2026-09-24, Apple M1 Max, Node 24):

| File                                                      | mutants |  killed | justified | unjustified |
| --------------------------------------------------------- | ------: | ------: | --------: | ----------: |
| `policy-engine/src/matcher.ts`                            |      44 |      41 |         3 |           0 |
| `policy-engine/src/precedence.ts`                         |      45 |      41 |         4 |           0 |
| `policy-engine/src/evaluator.ts`                          |      33 |      31 |         2 |           0 |
| `command-classifier/src/classify.ts`                      |     166 |     164 |         2 |           0 |
| `context-compiler/src/redact.ts`                          |      45 |      44 |         1 |           0 |
| `context-compiler/src/token-budget.ts`                    |      17 |      15 |         2 |           0 |
| `core/src/risk-aggregator.ts`                             |      45 |      45 |         0 |           0 |
| `core/src/decision-engine.ts`                             |      42 |      41 |         1 |           0 |
| `core/src/cache.ts`, `modes.ts`, `fallback.ts`, `risk.ts` |      14 |      13 |         1 |           0 |
| **all**                                                   | **451** | **435** |    **16** |       **0** |

Every justified survivor is an equivalent mutant (a boundary where equal
means the same value, a guard the parser or the pattern engine already
enforces, a move that is the identity) or, in one case, a difference the
corpus takes no position on (`http POST` with no URL). Each reason is in
the allowlist next to the line it excuses.

**What it found.** The first run had 120 survivors, and most were gaps, not
equivalents. In core: the test that a model change invalidates the cache
was vacuous (each engine had its own random fingerprint key, so nothing was
ever shared); the low-confidence rule was held only past its threshold, not
at it; a cache of one entry, a deadline already used up, and the project id
in the cache key had no test. In the compiler: a value nested deeper than
the contract allows was passed through unredacted (now replaced whole, as
`encoded`, its secrets counted); the decode threshold and the depth limit
were tested only away from their exact values; the objective and the
resource identifier on the redacted view were not held. In the policy
engine: the doubt rule's own branches (a pattern that is missing, a root
that cannot be resolved, a text past the permit budget), the order of the
matches, a floor reported only while unresolved, a mandatory rule kept out
of the cascade, `exists` on a field the action lacks, and an open list
under `not`. In the classifier: the git subcommands read one word at a time
(`stash`, `remote`, `config`, `reflog`, `checkout`), curl's method wherever
it is written, httpie, the areas of `gh`, a bare `set`, the mode or owner
skipped by `chmod`, `chown` and `chgrp`, sed's files, what a remote shell
copies, a numeric redirection target, an input redirection, `host:path`
read only for a remote shell, `ssh` with nothing to connect to (one mutant
made it throw), `-c` read as a script only for a shell, and `publish`. One
piece of dead logic went with it: a redundant filter on `find`'s paths.
