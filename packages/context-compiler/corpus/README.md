# Redaction corpora (RFX-031, RFX-035)

Two files, one rule: **no secret-shaped literal exists in this repository.**
Every case names a kind and a template; the secret itself is generated at
test time from the kind's shape with a seeded generator, so that the
Security gate (gitleaks over every commit) has nothing to find here and its
allowlist stays as narrow as it is.

- `secrets-v1.json`: the golden corpus. One or more cases per secret kind,
  each a template with `{secret}` where the value goes, in the frame a
  developer would meet it: an environment line, a header, a URL, a JSON
  member, a shell command, a file.
- `adversarial-v1.json`: the same secrets encoded, quoted and embedded
  (base64, percent-encoding, inside JSON strings, inside here-documents,
  inside a data URL, split across a shell continuation), where a redactor
  that only looks for the plain shape would miss them.

`src/corpus.test.ts` generates each case, runs it through the redactor, and
holds that the raw secret survives nowhere in the output, that the output
names the kind, and that the placeholder is stable for the same secret and
different for another. A case that a redactor cannot be expected to catch
(a secret split so that no single string holds it) is marked
`expect: "survives"` and counted, not hidden.
