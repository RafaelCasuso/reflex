#!/usr/bin/env bash
# Installs a pinned gitleaks release and refuses to run it unless the archive
# matches the recorded SHA-256. A scanner fetched at CI time is itself part of
# the supply chain (RFX-090).
#
# To upgrade: change VERSION and SHA256 together. The checksum comes from
# gitleaks_<version>_checksums.txt on the GitHub release. Dependabot does not
# see this file, so it is upgraded by hand.
set -euo pipefail

VERSION="8.30.1"
SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
ARCHIVE="gitleaks_${VERSION}_linux_x64.tar.gz"
DEST="${RUNNER_TEMP:-/tmp}/gitleaks"

mkdir -p "$DEST"
curl --fail --silent --show-error --location \
  --output "$DEST/$ARCHIVE" \
  "https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${ARCHIVE}"
echo "${SHA256}  ${DEST}/${ARCHIVE}" | sha256sum --check --strict
tar -xzf "$DEST/$ARCHIVE" -C "$DEST" gitleaks
echo "$DEST" >> "${GITHUB_PATH:-/dev/null}"
"$DEST/gitleaks" version
