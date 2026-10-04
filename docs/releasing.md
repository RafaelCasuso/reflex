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
lockfile, runs lint, typecheck and test, sets every publishable package's
`version` and the CLI's own constant from the tag (`tools/release/set-version.mjs`),
builds, packs every publishable `@reflex-control/*` package once, attaches a
build-provenance attestation to those tarballs, and publishes those same
tarballs to npm with provenance, one `npm publish` each. There is no
`workflow_dispatch` and no publish step on a branch; a laptop cannot publish,
and `tests/ci.test.ts` holds the workflow to that, and holds that what is
published is what was attested.

## What is published

The open packages of `docs/open-core.md`, each with `publishConfig.access:
public`, `publishConfig.provenance: true` and a `files` list that names
`dist` and, where a consumer can hold itself to it, data (the frozen
`fixtures/` of `contracts`, which the private `rdm/` reads from the installed
package; the `corpus/` and `benchmarks/` of `evals`), never sources:
`@reflex-control/contracts`, `policy-engine`, `command-classifier`, `core`,
`context-compiler`, `semantic-provider`, `provider-jev`, `provider-local`,
`adapter-claude-code`, `adapter-codex`, `adapter-mcp`, `cli`,
`decision-gateway`, `telemetry`, `evals`, `sdk-typescript`. The private
packages (`@reflex-control/api`, `@reflex-control/dashboard`, `@reflex-control/auth`) are
`private: true` and can never be published; `tests/workspace.test.ts` holds
both halves. Workspace dependencies are declared `workspace:*` and rewritten
to the released version by pnpm when it packs, so the published `@reflex-control/cli`
depends on the published `@reflex-control/decision-gateway` of the same version.

Every package is `0.0.0` in the repository, and so is `CLI_VERSION` in
`packages/cli/src/version.ts`, what `rfx --version` prints. The tag is the
version; the script writes it into the manifests and into that constant
inside the job, before the build that is packed, and nothing is committed
back.

## Verifying a release

For a package installed from npm:

```
npm audit signatures
```

reports whether every installed package has a valid registry signature and,
for packages published with provenance, a valid Sigstore attestation that
names this repository, the workflow and the commit.

For a tarball, the one npm serves:

```
npm pack @reflex-control/cli@0.1.2
gh attestation verify ./reflex-control-cli-0.1.2.tgz --repo RafaelCasuso/reflex
```

verifies the build-provenance attestation the release job attached: the
subject digest, the workflow (`.github/workflows/release.yml`), the commit
and the tag. It holds because the job publishes the very files it attested.
One version does not have it: `v0.1.1` attested the tarballs of `pnpm pack`
and published the ones `pnpm publish` packed again, which differ in bytes,
so `gh attestation verify` finds nothing for its tarballs. Its npm
provenance is intact, and `npm audit signatures` verifies it.

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

Done on 2026-10-04: the sixteen packages were published at `0.1.0` by hand
(no provenance), a trusted publisher was set on each, and the `NPM_TOKEN`
secret was deleted. From `v0.1.1` on, CI publishes.

## Status

Sixteen packages are on npm under `@reflex-control`. `0.1.0` is the bootstrap
by hand (2026-10-04, no provenance). `v0.1.1` is the first release from CI,
through trusted publishing: every package carries npm provenance, and an
install of `@reflex-control/cli@0.1.1` passes `npm audit signatures` with a
verified attestation on every REFLEX package. `gh attestation verify` fails
on `v0.1.1` for the reason above; the next tag is the first whose GitHub
attestation names the tarballs npm serves.
