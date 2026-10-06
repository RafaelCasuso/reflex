#!/usr/bin/env bash
# RFX-150 — the install command on the public page, run as a visitor would.
#
# The exact line the landing and the install page show, against the
# package on npm, in an empty project, with a temporary REFLEX home: rfx is
# installed, `rfx init` runs (it asks before changing anything and, with no
# terminal to ask, changes nothing and exits 0), then an install with the
# answer given, a first look, a first explanation, and the uninstall. No
# pnpm, no checkout of the packages: what a visitor gets is what is tested.
set -euo pipefail

INSTALL_COMMAND="npm install -g @reflex-control/cli && rfx init"

WORK="$(mktemp -d)"
export REFLEX_HOME="$WORK/home"
export npm_config_prefix="$WORK/prefix"
mkdir -p "$WORK/project" "$REFLEX_HOME" "$npm_config_prefix"
export PATH="$npm_config_prefix/bin:$PATH"
cd "$WORK/project"
git init -q .

echo "+ $INSTALL_COMMAND"
bash -c "$INSTALL_COMMAND"

echo "+ rfx --version"
rfx --version

echo "+ rfx init --yes --host claude-code"
rfx init --yes --host claude-code

echo "+ rfx status"
rfx status

echo "+ rfx explain git push --force"
rfx explain git push --force

echo "+ rfx doctor"
rfx doctor

echo "+ rfx uninstall --yes"
rfx uninstall --yes

rm -rf "$WORK"
echo "the install command works against the released package"
