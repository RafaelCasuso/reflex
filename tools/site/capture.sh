#!/usr/bin/env bash
# RFX-150 — real terminal captures for the public site.
#
# Runs the built CLI (`pnpm build` first) against a temporary REFLEX home
# and a temporary project, and writes what the terminal showed to
# site/captures/*.txt, each starting with the command that was run. The
# only edit is the temporary root, replaced by "~" so that the captures
# read as they would on a user's machine. Nothing is typed by hand; rerun
# this script after a change that alters the output.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="$ROOT/packages/cli/dist/bin.js"
OUT="$ROOT/site/captures"
# The real path: the hook compares the host's working directory with the
# registry's, and macOS spells /var as /private/var.
TMP="$(cd "$(mktemp -d)" && pwd -P)"
REAL_TMP="$TMP"
HOME_DIR="$TMP/.reflex"
TEAM="$TMP/team"
PROJECT="$TMP/work/api"
mkdir -p "$OUT" "$HOME_DIR" "$TEAM" "$PROJECT/.git" "$PROJECT/.reflex"
chmod 700 "$HOME_DIR"

rfx() {
  REFLEX_HOME="$HOME_DIR" node "$CLI" "$@"
}

# Everything the captures say about paths is said as "~": the temporary
# root, and the real home that the host detection prints.
shorten() {
  sed -e "s#$REAL_TMP#~#g" -e "s#$TMP#~#g" -e "s#$HOME#~#g"
}
capture() {
  local name="$1"
  shift
  {
    printf '$ %s\n' "$*"
    "$@" 2>&1 || true
  } | shorten > "$OUT/$name.txt"
}

# The team's policy: one mandate, one default to refine, one production rule.
cat > "$TEAM/organization.yaml" <<'YAML'
version: 1
defaults:
  unresolved: ask
rules:
  - id: org-no-force-push
    name: Never force-push
    effect: deny
    mandatory: true
    conditions:
      - { field: command.name, operator: equals, value: git }
      - { field: command.args, operator: in, value: [--force, -f] }
  - id: org-ask-rm
    name: Ask before rm
    effect: ask
    conditions:
      - { field: command.name, operator: equals, value: rm }
YAML
cat > "$TEAM/production.yaml" <<'YAML'
version: 1
rules:
  - id: prod-no-migrations
    name: No database migrations from an agent in production
    effect: deny
    conditions:
      - { field: command.text, operator: matches, value: "prisma migrate|rails db:migrate|alembic upgrade" }
YAML

# A member's own policy, allowing what the team forbids: it cannot.
cat > "$HOME_DIR/policy.yaml" <<'YAML'
version: 1
defaults:
  unresolved: ask
rules:
  - id: me-git
    name: git is mine
    effect: allow
    conditions:
      - { field: command.name, operator: equals, value: git }
YAML

# The project: a repository on main, mapped to production.
printf 'ref: refs/heads/main\n' > "$PROJECT/.git/HEAD"
printf '[remote "origin"]\n\turl = git@github.com:acme/api.git\n' > "$PROJECT/.git/config"
cat > "$PROJECT/.reflex/policy.yaml" <<'YAML'
version: 1
rules:
  - id: repo-allow-tests
    name: The test runner is fine here
    effect: allow
    conditions:
      - { field: command.name, operator: in, value: [pnpm, npm] }
      - { field: command.args, operator: in, value: [test, lint, typecheck] }
environments:
  production:
    branches: [main, "release/.*"]
    remotes: ["github.com/acme/.*"]
YAML

cd "$PROJECT"
capture init rfx init --dry-run
# For real, for this project only, in Autopilot, so that the hook decides.
rfx init --yes --host claude-code --mode autopilot > /dev/null
capture keygen rfx policy keygen --out "$TEAM/keys"
capture snapshot rfx policy snapshot --policy "$TEAM/organization.yaml" --environment "production=$TEAM/production.yaml" --key "$TEAM/keys/reflex-policy-key.pem" --label 2026.10 --out "$TEAM/reflex-policy.json"
capture subscribe rfx policy subscribe "$TEAM/reflex-policy.json" --key "$TEAM/keys/reflex-policy-key.pub"
rfx trust --yes > /dev/null
capture explain rfx explain git push --force
capture explain-tests rfx explain pnpm test
capture explain-production rfx explain npx prisma migrate deploy
capture doctor rfx doctor

# The hook, as the host runs it: one JSON line back for a denied call.
PAYLOAD="$TMP/payload.json"
node -e '
const fs = require("fs");
const fixture = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
fixture.cwd = process.argv[2];
fixture.tool_use_id = "toolu_capture_0001";
fixture.tool_input = { ...fixture.tool_input, command: "git push --force origin main" };
process.stdout.write(JSON.stringify(fixture));
' "$ROOT/packages/adapter-claude-code/fixtures/claude-code-2.1/pre-tool-use.bash.json" "$PROJECT" > "$PAYLOAD"
{
  printf '$ rfx hook claude-code < pre-tool-use.json\n'
  rfx hook claude-code < "$PAYLOAD" 2>&1 || true
  printf '\n'
} | shorten > "$OUT/hook.txt"
capture status rfx status
rfx uninstall --yes > /dev/null 2>&1 || true
rm -rf "$TMP"
ls "$OUT"
