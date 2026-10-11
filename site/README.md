# The public site

Static HTML and CSS, self-hosted fonts and one script of its own, built
from this repository's files by `site/src/build.mjs` (RFX-150, RFX-137,
RFX-136).
Nothing on it is typed twice: the positioning comes from `docs/product.md`,
the consent statement from the built semantic-provider package, every
number from the benchmark record, the hook cost table and the corpus files,
every terminal block from a capture that `tools/site/capture.sh` made by
running the CLI, and the plans from the pricing hypothesis in
`docs/product.md`. `tests/site.test.ts` holds each page to its source.

## The console

The whole site is one screen: an amber CRT whose pages are what the console
printed, with a prompt at the bottom (`site/src/console.js`, served hashed
as `console.<hash>.js`). `help` lists the commands: `ls` and `open` move
around the page's sections, `install`, `plans` and `docs` change page,
`explain` prints the real capture, `allow`, `ask` and `deny` light a lamp,
`phosphor` changes the colour (kept in this browser's localStorage, the one
thing the site remembers). There are hidden commands and a sequence every
arcade knew; each one says it is the console's own joke, never a decision
REFLEX made, because no policy is loaded on a web page. Without the script
every page reads as a document: the prompt is not shown and the F-keys are
plain links. The script makes no request anywhere; `tests/site.test.ts`
holds it to that, and `site/public/_headers` serves a content security
policy with `script-src 'self'` and nothing inline.

## Build and check

```sh
pnpm build                                  # the consent statement needs the built packages
SITE_BASE_PATH=/ node site/src/build.mjs    # into site/dist, for the root of an origin
SITE_BASE_PATH=/ node site/src/check-links.mjs
```

`SITE_BASE_PATH` is where the site is served from under its origin (`/` on
Cloudflare Pages or any host that serves the directory at the root;
`/reflex` on GitHub Pages, which serves a project site under the
repository's name). `SITE_ORIGIN` is the origin written into `sitemap.txt`
and `robots.txt`; it defaults to the GitHub Pages one.

To regenerate the captures after a change to the CLI's output, build the
packages and run `bash tools/site/capture.sh`; the captures are real runs,
with the temporary root replaced by `~`.

## Where it is deployed

- **GitHub Pages**, today: `.github/workflows/pages.yml` deploys every push to
  `main` at `https://rafaelcasuso.github.io/reflex/`.
- **Cloudflare Pages**, when it is connected: `.github/workflows/cloudflare-pages.yml`
  builds the site for the root, checks the links and deploys with wrangler.
  The job is skipped until the repository variable
  `CLOUDFLARE_PAGES_PROJECT` is set, so the workflow can live on `main`
  before the account exists.

### Connecting Cloudflare Pages

Once, by the maintainer, in the Cloudflare dashboard and in this
repository's settings:

1. Create a Pages project (direct upload, not Git integration, so that this
   repository's workflow stays the only thing that deploys), for example
   `reflex`. Its address is `<project>.pages.dev` until a custom domain is
   attached in the project's settings.
2. Create an API token with the permission **Cloudflare Pages: Edit** on the
   account, and read the account id from the dashboard's overview.
3. In the repository: secrets `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`; variables `CLOUDFLARE_PAGES_PROJECT` (the
   project's name) and `SITE_ORIGIN` (`https://<project>.pages.dev`, or the
   custom domain with its scheme).
4. Push to `main`, or run the workflow by hand. Every push to `main` deploys
   from then on.

The `_headers` file in `site/public/` is copied into the built site and
Cloudflare Pages serves it: a content security policy that allows styles and
fonts from the site's own origin and nothing else, `nosniff`, no framing, a
strict referrer policy, and a year of immutable caching for the hashed
stylesheet and the fonts. GitHub Pages ignores the file.

If the Git integration is preferred instead of the workflow, the settings
are: build command
`corepack enable && pnpm install --frozen-lockfile && pnpm build && SITE_BASE_PATH=/ node site/src/build.mjs`,
output directory `site/dist`, environment variable `NODE_VERSION` at the
value of `.nvmrc`, and `SITE_ORIGIN` at the site's address.

## Changing the contact address

The early-access button and the plans open a mail to the address in
`CONTACT_EMAIL` at the top of `site/src/build.mjs`.
