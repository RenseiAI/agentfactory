#!/bin/bash
# Rewrite the 6 publish-target packages' `name` from @donmai/* to @renseiai/*,
# and rewrite any internal cross-deps (dependencies / peerDependencies /
# devDependencies / optionalDependencies) so `workspace:*` resolution still
# works when pnpm publishes the tarballs to GitHub Packages.
#
# Why: GitHub Packages rejects @donmai/* uploads because no `donmai` GH org
# owns the scope. Republishing under @renseiai/* (the actual repo owner)
# lets GHP accept the artifacts as a secondary registry.

set -euo pipefail

PKGS=(
  "packages/linear"
  "packages/architectural-intelligence"
  "packages/core"
  "packages/server"
  "packages/dashboard"
  "packages/mcp-server"
)

rewrite() {
  local pj="$1"
  local tmp
  tmp="$(mktemp)"
  jq '
    .name |= sub("^@donmai/"; "@renseiai/")
    | (if .dependencies then
        .dependencies |= with_entries(.key |= sub("^@donmai/"; "@renseiai/"))
       else . end)
    | (if .peerDependencies then
        .peerDependencies |= with_entries(.key |= sub("^@donmai/"; "@renseiai/"))
       else . end)
    | (if .devDependencies then
        .devDependencies |= with_entries(.key |= sub("^@donmai/"; "@renseiai/"))
       else . end)
    | (if .optionalDependencies then
        .optionalDependencies |= with_entries(.key |= sub("^@donmai/"; "@renseiai/"))
       else . end)
  ' "$pj" > "$tmp"
  mv "$tmp" "$pj"
}

for d in "${PKGS[@]}"; do
  pj="$d/package.json"
  if [ ! -f "$pj" ]; then
    echo "::warning::missing $pj — skipping"
    continue
  fi
  rewrite "$pj"
  echo "renamed $pj -> $(jq -r '.name' "$pj")"
done
