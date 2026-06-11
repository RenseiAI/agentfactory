#!/usr/bin/env bash
# check-publish-surface.sh — guard the publishable surface of the @donmai/* packages.
#
# Run after `pnpm build`. Fails (exit 1) when:
#   1. A published package would pack test artifacts (*.test.js, *.test.d.ts,
#      __tests__/, __fixtures__/ …) into its npm tarball.
#   2. A published package would pack a file containing a RENSEI_-prefixed
#      environment variable name (the OSS packages use DONMAI_*).
#   3. Any packages/*/README.md contains a private reference (Linear ticket
#      IDs, private repo links) — these ship verbatim in every tarball.
#
# Uses `npm pack --dry-run --json` so the check sees exactly what `pnpm publish`
# would ship, including `files` globs and negations.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Keep in sync with the publish steps in .github/workflows/release.yml.
PUBLISHED_PACKAGES=(linear architectural-intelligence core server dashboard mcp-server)

TEST_ARTIFACT_RE='(^|/)__(tests|fixtures|mocks)__(/|$)|\.test\.(js|jsx|ts|tsx|mjs|cjs|d\.ts)(\.map)?$'
PRIVATE_REF_RE='REN-[0-9]|REN2-[0-9]|SUP-[0-9]|rensei-architecture|rensei-ops|RenseiAI/rensei'

fail=0

for dir in "${PUBLISHED_PACKAGES[@]}"; do
  pkgdir="$ROOT/packages/$dir"
  name="$(node -p "require('$pkgdir/package.json').name")"

  files="$(
    cd "$pkgdir" && npm pack --dry-run --json 2>/dev/null | node -e '
      let d = ""
      process.stdin.on("data", (c) => (d += c))
      process.stdin.on("end", () => {
        for (const f of JSON.parse(d)[0].files) console.log(f.path)
      })'
  )"

  if [ -z "$files" ]; then
    echo "::error::$name packs zero files — did the build run?"
    fail=1
    continue
  fi

  if [ "$(echo "$files" | grep -cE '^(dist|src)/')" -eq 0 ]; then
    echo "::error::$name packs no dist/ or src/ payload — did the build run?"
    fail=1
  fi

  bad="$(echo "$files" | grep -E "$TEST_ARTIFACT_RE" || true)"
  if [ -n "$bad" ]; then
    echo "::error::$name would publish test artifacts:"
    echo "$bad" | sed "s/^/  $name: /"
    fail=1
  fi

  branded="$(
    echo "$files" | while IFS= read -r f; do
      [ -f "$pkgdir/$f" ] || continue
      if grep -lq 'RENSEI_' "$pkgdir/$f" 2>/dev/null; then echo "$f"; fi
    done
  )"
  if [ -n "$branded" ]; then
    echo "::error::$name would publish RENSEI_-branded env names (use DONMAI_*):"
    echo "$branded" | sed "s/^/  $name: /"
    fail=1
  fi

  private="$(
    echo "$files" | while IFS= read -r f; do
      [ -f "$pkgdir/$f" ] || continue
      if grep -lqE "$PRIVATE_REF_RE" "$pkgdir/$f" 2>/dev/null; then echo "$f"; fi
    done
  )"
  if [ -n "$private" ]; then
    echo "::error::$name would publish private references (Linear IDs, private repo links):"
    echo "$private" | sed "s/^/  $name: /"
    fail=1
  fi
done

# Private references in publishable READMEs (see CLAUDE.md "Publishing Hygiene").
if grep -nE "$PRIVATE_REF_RE" "$ROOT"/packages/*/README.md; then
  echo "::error::Private references found in packages/*/README.md — strip before publishing"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "publish surface clean: ${#PUBLISHED_PACKAGES[@]} packages, no test artifacts, no RENSEI_ env names, no private references"
