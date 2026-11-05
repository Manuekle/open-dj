#!/usr/bin/env bash
# Installs Demucs (https://github.com/Manuekle/demucs) into .demucs/, the Python environment the
# /api/stems route runs. Needs uv (https://docs.astral.sh/uv/) and ffmpeg on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
# SHIFT_DIR installs elsewhere: the Mac app looks in ~/Library/Application Support/Shift (npm run setup:stems -- --desktop).
[ "${1:-}" = "--desktop" ] && SHIFT_DIR="$HOME/Library/Application Support/Shift"
mkdir -p "${SHIFT_DIR:-.}" && cd "${SHIFT_DIR:-.}"
command -v uv >/dev/null || { echo "Install uv first: brew install uv" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "Install ffmpeg first: brew install ffmpeg" >&2; exit 1; }
# Demucs pins torchaudio below 2.1, which needs torch 2.0 and Python 3.11.
uv venv .demucs --python 3.11 --allow-existing
uv pip install --python .demucs/bin/python "demucs @ git+https://github.com/Manuekle/demucs" "numpy<2" "setuptools<70" soundfile
# Downloads the htdemucs weights once, so the first separation does not wait on them.
.demucs/bin/python -c "from demucs.pretrained import get_model; get_model('htdemucs')"
echo "Demucs ready: .demucs/bin/demucs"
