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
every publishable `@reflex-control/*` package to npm with provenance. There is no
`workflow_dispatch` and no publish step on a branch; a laptop cannot publish,
and `tests/ci.test.ts` holds the workflow to that.

## What is published

The open packages of `docs/open-core.md`, each with `publishConfig.access:
public`, `publishConfig.provenance: true` and `files: ["dist"]`:
`@reflex-control/contracts`, `policy-engine`, `command-classifier`, `core`,
`context-compiler`, `semantic-provider`, `provider-jev`, `provider-local`,
`adapter-claude-code`, `adapter-codex`, `adapter-mcp`, `cli`,
`decision-gateway`, `telemetry`, `evals`, `sdk-typescript`. The private
packages (`@reflex-control/api`, `@reflex-control/dashboard`, `@reflex-control/auth`) are
`private: true` and can never be published; `tests/workspace.test.ts` holds
both halves. Workspace dependencies are declared `workspace:*` and rewritten
to the released version by pnpm at publish time, so the published `@reflex-control/cli`
depends on the published `@reflex-control/decision-gateway` of the same version.

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

## How publishing authenticates

Trusted publishing: the release job presents its OIDC token to npm, and npm
accepts it because each package names this repository and `release.yml` as
its trusted publisher. There is no token and no secret in the repository.
Provenance is published with it. npm tokens that bypass two-factor
authentication are deprecated, and a token that does not bypass it cannot
publish from CI, which is what the first attempt (run of tag `v0.1.0`,
2026-10-04) showed: `403 Two-factor authentication or granular access token
with bypass 2fa enabled is required to publish packages`.

Trusted publishing has one gap: it can only be configured on a package that
already exists on npm. So the **first version of each package is published
once by the maintainer, by hand, with their own 2FA**, and from the second
version on CI does it. The first version therefore has no provenance; the
first attested version is the next tag.

## Bootstrapping a new package (done once per package)

From a clean checkout of the tag to publish, on Node 24:

```
git clone --branch v0.1.0 https://github.com/RafaelCasuso/reflex.git reflex-0.1.0
cd reflex-0.1.0
corepack enable
pnpm install --frozen-lockfile
pnpm build
node tools/release/set-version.mjs 0.1.0
npm login
pnpm -r publish --access public --no-git-checks
```

`pnpm -r publish` publishes every publishable package whose version is not on
the registry yet, in dependency order, and asks for a one-time password when
the registry requires it; `--otp <code>` can be given instead. A run that
stops halfway can simply be repeated: what is already published is skipped.

Then, for each package, on npmjs.com, `https://www.npmjs.com/package/@reflex-control/<name>/access`,
"Trusted Publisher", GitHub Actions: owner `RafaelCasuso`, repository
`reflex`, workflow filename `release.yml`, no environment. After that, the
next tag publishes from CI with provenance, and any `NPM_TOKEN` secret can be
deleted.

## Status

The workflow, the manifests, the version script and the audits are in place,
and the repository is public. Tag `v0.1.0` ran the whole job and failed only
at publish, for the reason above; nothing was published. The bootstrap of
the sixteen packages and their trusted publishers is the maintainer's step;
the first attested release is the tag after it.
