#!/usr/bin/env bash
# Installs what the /api/lyrics route runs: whisper.cpp (whisper-cli), a Whisper model and the Silero voice activity
# detection model in .whisper/. Needs ffmpeg on PATH, and Homebrew to install whisper.cpp on a Mac. Pick a model with
# WHISPER_MODEL_NAME:
#   large-v3 (3.1 GB, the default: the most accurate on sung lyrics) · large-v3-turbo (1.6 GB, nearly as good, faster)
#   medium (1.5 GB) · small (488 MB) · base (148 MB, quick)
# The route uses the most accurate model in .whisper/, so a smaller one fetched earlier can stay.
set -euo pipefail
cd "$(dirname "$0")/.."
# SHIFT_DIR installs elsewhere: the Mac app looks in ~/Library/Application Support/Shift (npm run setup:whisper -- --desktop).
[ "${1:-}" = "--desktop" ] && SHIFT_DIR="$HOME/Library/Application Support/Shift"
mkdir -p "${SHIFT_DIR:-.}" && cd "${SHIFT_DIR:-.}"
NAME="${WHISPER_MODEL_NAME:-large-v3}"
command -v ffmpeg >/dev/null || { echo "Install ffmpeg first: brew install ffmpeg" >&2; exit 1; }
if ! command -v whisper-cli >/dev/null; then
  command -v brew >/dev/null || { echo "Install whisper.cpp so that whisper-cli is on PATH: https://github.com/ggml-org/whisper.cpp" >&2; exit 1; }
  brew install whisper.cpp
fi
mkdir -p .whisper
# Downloaded to a temporary name, so a stopped download is never taken for a model.
fetch() {
  [ -s "$2" ] && return
  curl -fL --progress-bar -o "$2.part" "$1"
  mv "$2.part" "$2"
}
fetch "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$NAME.bin" ".whisper/ggml-$NAME.bin"
fetch "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" ".whisper/ggml-silero-v5.1.2.bin"
echo "Whisper ready: .whisper/ggml-$NAME.bin"
