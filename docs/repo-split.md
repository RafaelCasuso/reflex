# Splitting the repositories (RFX-149)

ADR-015 opens the local plane under Apache-2.0 and keeps the control plane
and RDM private. This page is the procedure that turns the one private
monorepo into a public `reflex` and a private `reflex-cloud`, what is
already in place for it, and what has to be true before it runs.

## What is in place

- `tools/private-paths.txt` names the private paths, and only them:
  `apps/api`, `apps/dashboard`, `packages/auth`, `rdm`. A test holds the list
  equal to the private table of `docs/open-core.md`.
- `tools/check-public-history.sh` fails when any of those paths exists in the
  working tree or was touched by any commit reachable from any ref.
  `.github/workflows/public-history.yml` runs it on every push and pull
  request where the repository variable `REFLEX_PUBLIC` is `true`, so a pull
  request that adds a file under a private path fails in the public
  repository; in the private monorepo the job is skipped by design.
- The quality gates tolerate the public layout: the workspace tests require
  every open package to be present and every present package to be
  documented, and check the private ones only when they are there; the rdm
  steps of `ci.yml` run only where `rdm/pyproject.toml` exists.
- Releases (`docs/releasing.md`) publish the open packages from CI with
  provenance; the private side consumes them by version.

## Preconditions

1. `rfx init` gives first value (G9: RFX-050 to RFX-054). Done.
2. A first version is published to npm (RFX-127), so that `reflex-cloud` can
   depend on `@reflex-control/*` by version. Done: `0.1.0` by hand, `0.1.1`
   from CI, on 2026-10-04.
3. The security gate is green over the filtered history before the
   repository is made public. Done.

## Procedure

Run from a clean clone of the private monorepo. `git filter-repo` runs
through `uv` so nothing is installed globally.

```
# 1. A fresh clone to filter; the original is untouched.
git clone --no-local https://github.com/RafaelCasuso/reflex.git /tmp/reflex-public
cd /tmp/reflex-public

# 2. Drop the private paths from every commit.
uvx --from git-filter-repo git-filter-repo \
  --invert-paths \
  --path apps/api --path apps/dashboard --path packages/auth --path rdm \
  --force

# 3. Prove it.
bash tools/check-public-history.sh
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build
# gitleaks over the whole filtered history (the Security workflow's command):
gitleaks git . --no-banner --redact --exit-code 1

# 4. The repositories. The current private repository becomes reflex-cloud;
#    the filtered history becomes the new reflex, private at first.
gh repo rename reflex-cloud --repo RafaelCasuso/reflex --yes
gh repo create RafaelCasuso/reflex --private --source /tmp/reflex-public --push
gh variable set REFLEX_PUBLIC --body true --repo RafaelCasuso/reflex

# 5. In the new repository: branch protection on main (Quality gates,
#    Security gates, Public history), Dependabot, the host-schema canary.
#    When CI is green there and a version is published: make it public.
gh repo edit RafaelCasuso/reflex --visibility public --accept-visibility-change-consequences
```

`reflex-cloud` then removes the open packages from its tree and depends on
`@reflex-control/*` by published version in its lockfile, never by path, submodule
or subtree. The boundary test of ADR-015 stays in the public repository and
still fails a new package that is in neither table of `docs/open-core.md`.

## Executed on 2026-10-04

Steps 1 to 4 were run on 2026-10-04 from main `448dc67` of the private
monorepo: the filtered history (97 commits) holds no private path, the check
script passes on it, `pnpm install --frozen-lockfile` passes as it is (no
lockfile step is needed), lint, typecheck, test and build pass with the
private packages absent, and gitleaks finds nothing in the filtered history.
The private repository is now `RafaelCasuso/reflex-cloud`; this repository,
`RafaelCasuso/reflex`, holds the filtered history, has `REFLEX_PUBLIC=true`,
and protects `main` with Quality gates, Security gates and Public history
check. Its first runs on `main` are green, Public history included.

Step 5 followed the same day: the repository is public since 2026-10-04.
Tag `v0.1.0` ran the release job and failed at publish (npm no longer takes
a CI token without a 2FA bypass, and those are deprecated); the maintainer
published `0.1.0` by hand, a trusted publisher was set on each package, the
`NPM_TOKEN` secret was deleted, and `v0.1.1` published the sixteen packages
from CI with provenance (`docs/releasing.md`).

Still to do: `reflex-cloud` drops the open packages and depends on them by
version, which closes RFX-149. It needs `v0.1.2`, the first version whose
`@reflex-control/contracts` ships `fixtures/`: `rdm/` reads the frozen
contract fixtures, and in `reflex-cloud` it reads them from the installed
package instead of the path `packages/contracts/fixtures`.

Until that last step, open code and documentation are developed here first
and mirrored into `reflex-cloud`; a change made there to an open path is
cherry-picked here.
