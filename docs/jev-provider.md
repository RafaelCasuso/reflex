# Jev as a semantic provider

What is known about Jev from its vendor's documentation and from measuring it,
and what that means for Gate G4. This is the written result RFX-107 asks for.

Jev is one provider behind `SemanticDecisionProvider` (`CLAUDE.md` principle 3).
Nothing here changes that: its request and answer shapes stay inside
`packages/provider-jev`.

## 1. What Jev is

Jev is TypeSafe's "System One" model. It is not a language model and generates
no text. A request carries a `state` (a string, an object or an array of text)
and a map of typed `questions`; the response carries one typed answer per
question. All questions of a request are evaluated in parallel against one
reading of the state, and cannot see each other's answers.

| Question | Asks                         | Answer                                                              | Confidence |
| -------- | ---------------------------- | ------------------------------------------------------------------- | ---------- |
| `noul`   | whether a condition holds    | `noul`: the probability of yes                                      | **none**   |
| `choice` | one option of a defined set  | `choice`, and `probabilities` per option                            | yes        |
| `score`  | a position on ordered levels | `score` (probability-weighted), `legend`, `probabilities` per level | yes        |

Two routes speak the same shapes:

- **TypeSafe direct:** `POST https://api.typesafe.ai/v1/systemone`, bearer key,
  models `jev-1.13.0` and the aliases `jev-latest` and `jev-preview`. This is
  what was measured.
- **OpenRouter:** `POST https://openrouter.ai/api/alpha/decisions`, models
  `typesafe/jev-1.13` and `~typesafe/jev-latest`. An alpha endpoint, and one
  more network hop. Not measured.

Price: $0.042 per million input tokens, output free. Limits, as documented on
2026-09-20 and stated by the vendor to change without notice: 64k tokens per
request, 1,200 requests per minute, 250,000 tokens per second.

## 2. What was measured (RFX-107)

`packages/provider-jev/live/probe-latency.mjs` assessed the eleven dimensions
of `SemanticAssessment` for one synthetic action (`rm -rf dist coverage && pnpm
test`, in an invented repository), ten `score` questions and one `noul`. Forty
measured samples per variant after three warm-ups, variants interleaved so that
drift lands on all of them alike, no retries. Model pinned to `jev-1.13.0`,
2026-09-20, from a laptop (macOS, Node 24.9) whose round trip to the API is
about 160 ms. The record is checked in under `live/results/`, and
`src/live-evidence.test.ts` holds this table to it in CI.

"Wall" is what a caller waits for one governed action: all requests sent at
once, done when the slowest is done. "Service" is per request, as the provider
reports it in its `x-envoy-upstream-service-time` header: the time spent behind
its proxy, without the network between the caller and it.

| Variant                  | Requests per action | Wall p50 (ms) | Wall p95 (ms) | Service p50 (ms) | Service p95 (ms) | Input tokens per action | Cost per 1,000 actions |
| ------------------------ | ------------------- | ------------- | ------------- | ---------------- | ---------------- | ----------------------- | ---------------------- |
| `one-call`               | 1                   | 264           | 372           | 95               | 148              | 1669                    | $0.070                 |
| `one-call-minimal-state` | 1                   | 332           | 410           | 96               | 170              | 1457                    | $0.061                 |
| `one-call-cold`          | 1                   | 605           | 801           | 87               | 132              | 1669                    | $0.070                 |
| `batched-3`              | 3                   | 279           | 358           | 89               | 147              | 2857                    | $0.120                 |
| `parallel-11`            | 11                  | 334           | 445           | 90               | 151              | 7609                    | $0.320                 |

- `one-call`: one request with all eleven questions, the context `CLAUDE.md`
  principle 9 describes, connection kept open.
- `one-call-minimal-state`: the same with only the goal and the action as
  state.
- `one-call-cold`: the same as `one-call` with a new TLS connection every time,
  which is what a hook process per call would pay.
- `batched-3`: three concurrent requests of four, four and three questions.
- `parallel-11`: eleven concurrent requests of one question each, which is what
  RFX-028 assumed.

Only actions that reach the semantic stage pay any of this. An action resolved
by deterministic policy costs nothing and waits for nothing.

### What the numbers say

1. **The provider's own time fits the budget; the network from a laptop does
   not.** The service answers eleven questions in 95 ms at p50 and 148 ms at
   p95. From this machine about 160 ms of round trip come on top, so the caller
   sees 264 ms at p50, against a target of 150 ms, and 372 ms at p95, against a
   target of 400 ms. The p50 target is reachable only from somewhere close to
   the provider. Where that is, is not known: the API does not say which region
   serves it.
2. **One request beats eleven on every axis.** `parallel-11` is slower at p95
   (445 ms, over budget: the action waits for the slowest of eleven), costs 4.6
   times as much because the state is sent and billed eleven times, and spends
   eleven requests of a 1,200 per minute allowance, which caps one account at
   about 109 governed actions a minute.
3. **Asking together changes no answer.** Every dimension got the same answer
   alone as next to the other ten, within what the same request shows from one
   run to the next. One request does not trade accuracy for speed.
4. **A connection that is not kept open costs more than the request itself.**
   `one-call-cold` adds about 340 ms at p50: TCP is connected after 161 ms, TLS
   after 328 ms, and only then does the request itself start, about 275 ms more. Whatever calls the
   provider has to be a process that stays up.
5. **Less state did not make it faster.** The service time is the same with and
   without the task summary, environment and prior actions (95 ms and 96 ms);
   the difference in wall time between those two rows is network jitter. It did
   change the answers: without context `unusualScope` rose from 0.27 to 0.54 of
   3 and `objectiveAlignment` fell from 2.62 to 2.27. Context is worth its
   tokens.
6. **Answers repeat closely, not exactly.** Over forty identical requests, four
   dimensions were identical every time and the largest standard deviation was
   0.02 on a scale of 0 to 3, under one point in 100. Replay against the golden
   corpus is meaningful, and any threshold needs a margin wider than that.

### Recommendation for RFX-028

Assess all eleven dimensions in **one request**. RFX-028's premise, parallel
per-dimension calls with bounded concurrency, does not hold for this provider:
the provider already evaluates the questions in parallel, and doing it from the
outside is slower at p95, several times dearer and rate-limited eleven times
sooner.

How many requests an assessment takes is the provider's business. It belongs
inside `packages/provider-jev`, not in `SemanticDecisionProvider`: a provider
built on a language model may well need the opposite.

### What this means for ADR-010

RFX-088 showed that a Node process per hook call costs about 49 ms before doing
anything. This adds the other half: a process per call also cannot keep a
connection open, and would pay about 600 ms per semantic assessment from this
machine instead of about 260 ms. Both point the same way, to a resident process
holding the connection. Whether that is a local daemon or the decision gateway
is ADR-010's decision, which is still the maintainer's to make. A gateway
placed close to the provider is the only arrangement measured here that could
meet the 150 ms p50.

## 3. What the mapping must get right (input for RFX-027)

- **A `noul` has no confidence, and the contract requires one for every
  dimension.** `externalSideEffect` is the contract's only boolean. The mapping
  has to define its confidence (from the distance of the probability to 0.5, or
  by asking a two-option `choice` instead) and must never fill it with a
  constant. The vendor warns that a `noul` and a `choice` about the same thing
  are not interchangeable, so this is a choice to evaluate, not to assume.
- **Jev's `confidence` measures how concentrated the distribution is, not how
  reliable the answer is.** In the measured run `objectiveAlignment` came back
  as 2.62 of 3 with a confidence of 0.62, because the probability was split
  between "a reasonable step" and "directly required". Both are fine. Reading
  that as doubt would turn a safe action into an `ask` and cost autonomy for
  nothing. For a risk dimension, the probability mass at or above a dangerous
  level says more than `confidence` does. The full `probabilities` are returned
  for exactly this.
- **Scale.** A `score` is a position from 0 to the number of levels minus one,
  and can fall between levels. The contract wants integers from 0 to 100. The
  vendor says not to read exact magnitudes out of the space between two levels,
  so the mapping should be coarse on purpose.
- **Pin the model.** The response names the versioned model that answered.
  Record it with every assessment, request a versioned ID and never an alias:
  an alias moves when a release ships, and the vendor itself says to pin once
  thresholds are tuned.
- **Malformed or partial output never becomes an allow** (RFX-027's
  acceptance). A missing answer, an unknown `type`, probabilities that do not
  sum to one or a model other than the one requested are provider failures, to
  be handled by the fallback class, not defaults to fill in.
- **No retry on the decision path** (RFX-026). The documented retryable errors
  are 429 and 529. A retry spends the latency budget twice.

## 4. Weaknesses the vendor documents, and where REFLEX already covers them

From the vendor's own "jaggedness" page for `jev-1.13`:

| Weakness                                                                                                                                                 | What it means here                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Adversarial content.** The state is not treated as hostile; injected instructions, or text that argues for its own classification, can move the answer | This is the attack that makes REFLEX allow what it should not: a command or a file that says "this is safe". It is why a deterministic deny cannot be overridden by a semantic answer and why assessments are evidence and not decisions. G6 needs an adversarial corpus aimed at this provider specifically |
| Literal reading, and trouble with indirection                                                                                                            | Questions have to state the exact condition. Wording is an eval subject, not a constant                                                                                                                                                                                                                      |
| Unreliable at counting, arithmetic, numeric and date comparison                                                                                          | Those stay in code: the policy engine and the command classifier                                                                                                                                                                                                                                             |
| Accuracy falls as the state fills with irrelevant detail                                                                                                 | Backs `CLAUDE.md` principle 9, minimal context, and makes it a matter of accuracy as well as of cost                                                                                                                                                                                                         |
| English is the strongest language                                                                                                                        | Commands and paths are mostly English-like. User objectives may not be                                                                                                                                                                                                                                       |

## 5. What is not known

- Where the API is served from, and therefore what latency a deployed gateway
  would see. Every wall-clock number here is from one laptop on one network on
  one afternoon.
- Behavior under load. The probe never exceeded twelve request starts a second
  and saw no 429 or 529.
- Accuracy. Nothing here says Jev's answers are right. One synthetic action was
  assessed, and its answers looked sensible (deleting build output: level 1 of
  destructiveness with full confidence). That is an anecdote. Accuracy is G6's
  question, against the golden corpus.
- An independent evaluation published by LangChain on 2026-09-18 reports Jev as
  a judge of agent runs agreeing with a human on 500 of 500 binary decisions,
  with a score variance 92 to 913 times lower than three language models, at
  0.44 s and $0.00035 per call. It is five cases of one weather agent, and its
  authors call it early. It is consistent with the repeatability measured here
  and proves nothing about safety decisions.

## 6. Where these facts come from

| Fact                                                            | Source                                                                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Request and answer shapes, limits, price, aliases, errors       | TypeSafe documentation, `docs.typesafe.ai` (`/api`, `/models`, `/confidence`, `/concepts/state`, `/primitives`), read 2026-09-19 and 2026-09-20 |
| Documented weaknesses                                           | `docs.typesafe.ai/model-jaggedness/jev-1.13`, last reviewed by the vendor 2026-09-17                                                            |
| OpenRouter route                                                | OpenRouter's Decisions API reference. The path was checked without a key: it answers 401, the `/api/v1/` variants 404                           |
| Latency, cost, repeatability, real answer shapes                | Measured, this document, `packages/provider-jev/live/results/jev-1.13.0.json`                                                                   |
| Vendor latency claims ("about 100 ms", 70 to 500 ms end to end) | Vendor material. The measured service time agrees with them; the end-to-end time depends on where the caller is                                 |

### Running the probe again

```sh
cd packages/provider-jev
node --env-file=../../.env live/probe-latency.mjs             # usage, sends nothing
node --env-file=../../.env live/probe-latency.mjs --dry-run   # the plan, sends nothing
node --env-file=../../.env live/probe-latency.mjs --run       # about 730 requests, under 3 cents
```

It needs `TYPESAFE_API_KEY` in the repository's `.env`, which git ignores. It
sends nothing without `--run`, treats an unknown flag as an error, sends only
synthetic data, never writes the key anywhere and refuses to write a record
that contains anything shaped like one. It is not part of `pnpm test`.
