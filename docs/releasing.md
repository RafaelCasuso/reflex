# Releasing

How a version of REFLEX is built, signed and published (RFX-127), and how
anyone verifies that what they installed is what CI built.

## A release is a tag

```
git tag v0.1.0
git push origin v0.1.0
```

Nothing else publishes. `.github/workflows/release.yml` runs only for a tag of
the form `vMAJOR.MINOR.PATCH` (or a pre-release `v…-rc.1`) pushed to this
repository: it checks out the tagged commit, installs with the frozen
lockfile, runs lint, typecheck, test and build, sets every publishable
package's `version` from the tag (`tools/release/set-version.mjs`), packs the
tarballs, attaches a build-provenance attestation to them, and publishes
every publishable `@reflex/*` package to npm with provenance. There is no
`workflow_dispatch` and no publish step on a branch; a laptop cannot publish,
and `tests/ci.test.ts` holds the workflow to that.

## What is published

The open packages of `docs/open-core.md`, each with `publishConfig.access:
public`, `publishConfig.provenance: true` and `files: ["dist"]`:
`@reflex/contracts`, `policy-engine`, `command-classifier`, `core`,
`context-compiler`, `semantic-provider`, `provider-jev`, `provider-local`,
`adapter-claude-code`, `adapter-codex`, `adapter-mcp`, `cli`,
`decision-gateway`, `telemetry`, `evals`, `sdk-typescript`. The private
packages (`@reflex/api`, `@reflex/dashboard`, `@reflex/auth`) are
`private: true` and can never be published; `tests/workspace.test.ts` holds
both halves. Workspace dependencies are declared `workspace:*` and rewritten
to the released version by pnpm at publish time, so the published `@reflex/cli`
depends on the published `@reflex/decision-gateway` of the same version.

Every package is `0.0.0` in the repository. The tag is the version; the
script writes it into the manifests inside the job and nothing is committed
back.

## Verifying a release

For a package installed from npm:

```
npm audit signatures
```

reports whether every installed package has a valid registry signature and,
for packages published with provenance, a valid Sigstore attestation that
names this repository, the workflow and the commit.

For a tarball:

```
gh attestation verify ./reflex-cli-0.1.0.tgz --repo RafaelCasuso/reflex
```

verifies the build-provenance attestation the release job attached: the
subject digest, the workflow (`.github/workflows/release.yml`), the commit
and the tag.

## What the maintainer sets up once

- The npm scope `@reflex` must be owned by the maintainer and the packages
  configured for publishing from this repository: either npm trusted
  publishing (OIDC, no token; the job already asks for `id-token: write`) or
  an `NPM_TOKEN` repository secret with publish rights. Until one of these
  exists the job fails at "Publish with provenance" and nothing is released,
  which is the intended failure.
- Branch protection on `main` already requires the quality gates; tags are
  cut from `main`.

## Status

The workflow, the manifests, the version script and the audits are in place.
No version has been published yet: the npm scope is not set up. That is the
one step a workflow cannot do.
