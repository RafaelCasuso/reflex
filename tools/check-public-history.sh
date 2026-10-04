#!/usr/bin/env bash
# RFX-149 — the public repository's history holds no private path.
#
# Reads tools/private-paths.txt and fails when any commit reachable from any
# ref touched one of those paths, or when the working tree holds one. Runs in
# the public repository's CI on every push and pull request; in the private
# monorepo it would fail by design, so its workflow runs only where the
# repository variable REFLEX_PUBLIC is "true".
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

paths=()
while IFS= read -r line; do
  line="${line%%#*}"
  line="$(printf '%s' "$line" | tr -d '[:space:]')"
  [ -n "$line" ] && paths+=("$line")
done < tools/private-paths.txt

status=0
for path in "${paths[@]}"; do
  if [ -e "$path" ]; then
    echo "private path present in the working tree: $path" >&2
    status=1
  fi
  touched="$(git log --all --oneline -- "$path" | head -n 5 || true)"
  if [ -n "$touched" ]; then
    echo "private path touched in history: $path" >&2
    echo "$touched" | sed 's/^/  /' >&2
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "public history is clean of: ${paths[*]}"
fi
exit "$status"
