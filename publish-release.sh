#!/usr/bin/env bash
# Build, sign, and publish one complete GitHub release.
# Usage: ./publish-release.sh <version> [notes-file]
set -euo pipefail

VERSION="${1:?Usage: ./publish-release.sh <version> [notes-file]}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NOTES_FILE="${2:-$HERE/docs/releases/v$VERSION.md}"
REPO="${CODEWHALE_GITHUB_REPO:-felixgo2140/CodeWhale-GUI}"
TARGET_BRANCH="${CODEWHALE_RELEASE_TARGET:-main}"
OUT="$HERE/dist/$VERSION"

[ -f "$NOTES_FILE" ] || { echo "Error: release notes not found: $NOTES_FILE" >&2; exit 1; }
[ "$(cat "$HERE/VERSION")" = "$VERSION" ] || {
  echo "Error: VERSION does not match requested release" >&2
  exit 1
}
git -C "$HERE" diff --quiet
git -C "$HERE" diff --cached --quiet
gh auth status >/dev/null
if gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  echo "Error: release v$VERSION already exists" >&2
  exit 1
fi

MANIFEST_NOTES="${CODEWHALE_MANIFEST_NOTES:-CodeWhale GUI v$VERSION 正式整合发布}"
CODEWHALE_RELEASE_OUT="$OUT" "$HERE/make-release.sh" "$VERSION" "$MANIFEST_NOTES"
"$HERE/package-installer.sh" "$OUT/codewhale-installer.tar.gz"

(
  cd "$OUT"
  shasum -a 256 \
    "gui-$VERSION.tar.gz" \
    "harness-$VERSION.tar.gz" \
    codewhale-installer.tar.gz \
    manifest.json manifest.json.sig \
    > SHA256SUMS
)

ASSETS=(
  "$OUT/gui-$VERSION.tar.gz"
  "$OUT/harness-$VERSION.tar.gz"
  "$OUT/codewhale-installer.tar.gz"
  "$OUT/manifest.json"
  "$OUT/manifest.json.sig"
  "$OUT/SHA256SUMS"
)
for optional in codewhale-claude codewhale-tui CodeWhale.app.tar.gz; do
  [ ! -f "$OUT/$optional" ] || ASSETS+=("$OUT/$optional")
done

gh release create "v$VERSION" \
  --repo "$REPO" \
  --target "$TARGET_BRANCH" \
  --title "CodeWhale GUI v$VERSION" \
  --notes-file "$NOTES_FILE" \
  --latest \
  "${ASSETS[@]}"

echo "Published: https://github.com/$REPO/releases/tag/v$VERSION"
