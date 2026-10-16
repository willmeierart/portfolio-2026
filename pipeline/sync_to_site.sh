#!/usr/bin/env bash
# Copy prepared assets into the Vite public folder for local/dev deploys.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/assets/prepared}"
DEST="$ROOT/site/public/prepared"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"
echo "Synced $SRC -> $DEST"
