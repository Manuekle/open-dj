#!/usr/bin/env bash
# Renders scripts/og/og.html to the 1200x630 social card used by the landing page and the app.
# Needs Google Chrome (or Chromium) and network access for the Sodium fonts.
set -euo pipefail
cd "$(dirname "$0")/../.."

CHROME="${CHROME:-}"
if [[ -z "$CHROME" ]]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [[ -x "$c" ]]; then CHROME="$c"; break; fi
  done
fi
[[ -n "$CHROME" ]] || { echo "Chrome not found; set CHROME=/path/to/chrome" >&2; exit 1; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1200,630 --virtual-time-budget=6000 \
  --screenshot="$tmp/og.png" "file://$PWD/scripts/og/og.html" >/dev/null 2>&1

# JPEG keeps the film grain under ~300 KB, which WhatsApp and some crawlers need; PNG lands near 650 KB.
out="docs/og.jpg"
if command -v sips >/dev/null 2>&1; then
  sips -s format jpeg -s formatOptions 86 "$tmp/og.png" --out "$out" >/dev/null
else
  convert "$tmp/og.png" -quality 86 "$out"
fi
cp "$out" src/app/opengraph-image.jpg
cp "$out" src/app/twitter-image.jpg
echo "wrote $out ($(du -k "$out" | cut -f1) KB), src/app/opengraph-image.jpg, src/app/twitter-image.jpg"
