# The local provider and its wire contract

`@reflex/provider-local` (RFX-144, ADR-016 §1) is the provider behind
`--semantic-provider local`: a client for an inference server on this
machine that speaks the canonical contract. RDM and Laya are checkpoints
behind such a server; REFLEX does not know which, and does not need to.
This page is what a server has to speak, and what the client holds it to.

## 1. The wire

One request per assessment:

```
POST /v1/assess
content-type: application/json
accept: application/json

<SemanticDecisionRequest as JSON>
```

The body is the `SemanticDecisionRequest` of `@reflex/contracts`, as the
context compiler produced it: the fields a provider is given, selected by
name, redacted and under the token budget (ADR-006). It carries no
identity, no working directory, no adapter metadata, and no raw argument
value.

The answer is a `SemanticAssessment` as JSON, status 200:

```json
{
  "objectiveAlignment": { "value": 67, "confidence": 0.8 },
  "destructiveRisk": { "value": 0, "confidence": 0.9 },
  "reversibility": { "value": 100, "confidence": 0.9 },
  "externalSideEffect": { "value": false, "confidence": 0.9 },
  "privilegeEscalation": { "value": 0, "confidence": 0.9 },
  "secretAccess": { "value": 0, "confidence": 0.9 },
  "sensitiveDataExposure": { "value": 0, "confidence": 0.9 },
  "financialConsequence": { "value": 0, "confidence": 0.9 },
  "productionMutation": { "value": 0, "confidence": 0.9 },
  "unusualScope": { "value": 0, "confidence": 0.9 },
  "untrustedInput": { "value": 0, "confidence": 0.9 },
  "provider": "rdm-server",
  "model": "rdm-0.1.0",
  "latencyMs": 7
}
```

Every one of the eleven dimensions, with a value and a confidence; `model`
naming the checkpoint that answered, pinned to a version. `provider` and
`latencyMs` are the server's own and are replaced by the client: the
assessment REFLEX records says `provider: "local"` and the client's
measured round trip.

## 2. What the client holds the server to

- **Strict.** The answer is read with `parseSemanticAssessment`: a missing
  dimension, an out-of-range value, an extra field or a body that is not
  JSON is `invalid-response`, never a default (ADR-005 §3). A partial
  assessment must never become an implicit allow.
- **The model must match.** The client is built with the checkpoint it
  expects (`--semantic-model`); an answer in another checkpoint's name, or
  in none, is `invalid-response`. A checkpoint swapped under the server
  cannot answer in another's name.
- **Status.** 429 is `rate-limited`; 400, 401, 403 and 422 are
  `rejected-request`; anything else that is not 200 is `unavailable`. A
  server that is not there is `unavailable`. The request's deadline is the
  client's timeout; the caller's abort is told apart from it.
- **One connection, no retry.** `fetch` keeps the connection open across
  assessments; the decision path never retries (`isRetryable` says what a
  background caller may do).
- **This machine only.** The endpoint must be on `127.0.0.1`, `::1` or
  `localhost`; anything else is refused when the provider is built. That is
  what lets the provider declare `onMachine`, and what lets a local shadow
  be sampled on the actions policy resolved (ADR-016 §3, ADR-010): nothing
  it is given leaves the machine.

## 3. In the daemon

```
--semantic-provider local --semantic-model rdm-0.1.0
  [--semantic-endpoint http://127.0.0.1:8765/v1/assess]
```

The model is required and pinned; the endpoint defaults to port 8765 on
the loopback. As a shadow: `--shadow-provider local --semantic-model
<pin>`, and `--shadow-sample all` is accepted for it alone.

## 4. What does not exist yet

No server. `rdm/inference` (ADR-016 §5) is the server RDM and Laya will
load into, and RFX-147 measures Laya through it. The client is tested
against a fake server on the loopback (`src/server.test.ts`) and the
daemon end to end against another; both speak exactly what this page says.
