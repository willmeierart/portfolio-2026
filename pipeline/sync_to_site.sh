#!/usr/bin/env bash
# Copy the published set into the Vite public folder for local dev.
# publish.py already does this; use this after editing assets/publish by hand.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/assets/publish}"
DEST="$ROOT/site/public/prepared"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"
echo "Synced $SRC -> $DEST"
