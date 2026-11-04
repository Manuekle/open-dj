#!/usr/bin/env bash
# Installs what the /api/lyrics route runs: whisper.cpp (whisper-cli) and a Whisper model in .whisper/.
# Needs ffmpeg on PATH, and Homebrew to install whisper.cpp on a Mac. Pick a model with WHISPER_MODEL_NAME:
#   base (148 MB, quick) · small (488 MB, the default) · medium (1.5 GB) · large-v3-turbo (1.6 GB, best, fast on Apple silicon)
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="${WHISPER_MODEL_NAME:-small}"
command -v ffmpeg >/dev/null || { echo "Install ffmpeg first: brew install ffmpeg" >&2; exit 1; }
if ! command -v whisper-cli >/dev/null; then
  command -v brew >/dev/null || { echo "Install whisper.cpp so that whisper-cli is on PATH: https://github.com/ggml-org/whisper.cpp" >&2; exit 1; }
  brew install whisper.cpp
fi
mkdir -p .whisper
FILE=".whisper/ggml-$NAME.bin"
if [ ! -s "$FILE" ]; then
  # Downloaded to a temporary name, so a stopped download is never taken for a model.
  curl -fL --progress-bar -o "$FILE.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$NAME.bin"
  mv "$FILE.part" "$FILE"
fi
echo "Whisper ready: $FILE"
[ "$NAME" = "small" ] || echo "Set WHISPER_MODEL=$PWD/$FILE to use it."
