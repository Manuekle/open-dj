# Open DJ with everything it runs server-side: Demucs for stems (CPU PyTorch), ffmpeg, and the disk backup in /data.
#   docker compose up -d --build   then open http://localhost:3000 (compose.yaml also runs Ollama and pulls its model)
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Demucs pins torchaudio below 2.1, so torch 2.0 on the Python 3.11 that bookworm ships; the CPU wheels keep CUDA out.
# torch's own dependencies come from PyPI first: the PyTorch index's copies do not resolve on this pip.
FROM base AS demucs
ENV TORCH_HOME=/opt/torch
RUN python3 -m venv /opt/demucs \
  && /opt/demucs/bin/pip install --no-cache-dir filelock typing-extensions sympy networkx jinja2 \
  && /opt/demucs/bin/pip install --no-cache-dir --no-deps torch==2.0.1 torchaudio==2.0.2 --index-url https://download.pytorch.org/whl/cpu \
  && /opt/demucs/bin/pip install --no-cache-dir "demucs @ git+https://github.com/Manuekle/demucs" "numpy<2" "setuptools<70" soundfile \
  && /opt/demucs/bin/python -c "from demucs.pretrained import get_model; get_model('htdemucs')"

FROM base AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM base AS run
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data DEMUCS_BIN=/opt/demucs/bin/demucs TORCH_HOME=/opt/torch NEXT_TELEMETRY_DISABLED=1
COPY --from=demucs /opt/demucs /opt/demucs
COPY --from=demucs /opt/torch /opt/torch
COPY --from=build /app ./
VOLUME /data
EXPOSE 3000
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
