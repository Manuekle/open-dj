#!/usr/bin/env bash
# Builds Shift for Mac: the Next.js standalone server, then the .dmg (dist-desktop/Shift-<version>-arm64.dmg).
# Executables put in desktop/bin (ffmpeg, yt-dlp, whisper-cli) are bundled; without them the app uses Homebrew's.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname)" = Darwin ] || { echo "The Mac app builds on a Mac." >&2; exit 1; }
rm -rf .next/standalone
SHIFT_DESKTOP=1 npx next build
# The standalone server leaves the static files and the public folder to whoever serves it.
cp -R .next/static .next/standalone/.next/static
[ -d public ] && cp -R public .next/standalone/public
# Next's traces drag in the repo's own files (the routes read process.cwd()); the server needs only these.
find .next/standalone -mindepth 1 -maxdepth 1 ! -name server.js ! -name package.json ! -name .next ! -name node_modules ! -name public -exec rm -rf {} +
# Signed with a Developer ID when CSC_NAME or CSC_LINK names one (notarized too with APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD
# and APPLE_TEAM_ID); otherwise ad-hoc, which runs on this Mac and on others after right-click > Open.
if [ -z "${CSC_NAME:-}${CSC_LINK:-}" ]; then
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  set -- -c.mac.identity=- "$@"
fi
npx electron-builder --mac "$@"
