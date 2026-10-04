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
   depend on `@reflex/*` by version. **Not yet: the npm scope is not set up.**
3. The security gate is green over the filtered history before the
   repository is made public.

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
`@reflex/*` by published version in its lockfile, never by path, submodule
or subtree. The boundary test of ADR-015 stays in the public repository and
still fails a new package that is in neither table of `docs/open-core.md`.

## Dry run

Steps 1 to 3 were run on 2026-10-04 against the branch of G9 into a scratch
directory. The filtered history holds no private path and the check script
passes on it; `pnpm install --frozen-lockfile` passes as it is (pnpm accepts
a lockfile whose importers for the removed packages are simply unused, so
no lockfile step is needed); lint, typecheck, build and the whole test suite
pass there with the private packages absent, after one test learned to skip
the private manifests when their directories are gone; gitleaks finds
nothing in the filtered history. Steps 4 and 5 are the maintainer's call:
they rename the private repository and, eventually, make source public.
