# Deploying Shift on a VPS

Shift runs Demucs, Whisper, ffmpeg, yt-dlp and Ollama on the server, so it needs a real machine, not a serverless
platform. This setup is the stock `compose.yaml` plus Caddy for HTTPS and a password.

## Server

- Ubuntu 22.04/24.04 (or Debian 12), 8 GB RAM minimum, 4+ vCPU recommended, 30 GB disk (Demucs, Torch and the Ollama model take ~10 GB).
- Hetzner (CPX31/CCX13) or DigitalOcean work well. Stems on CPU take a few minutes per track.
- A domain with an A record pointing at the server's IP.
- Firewall: allow 22, 80, 443 only.

## Steps

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/Manuekle/shift.git && cd shift
```

Create the password hash (Caddy's bcrypt):

```bash
docker run --rm caddy:2 caddy hash-password --plaintext 'your-password'
```

Create `.env`. Every `$` in the hash must be doubled (`$$`) or Compose will try to expand it:

```bash
SITE_DOMAIN=shift.example.com
BASIC_AUTH_USER=manu
BASIC_AUTH_HASH=$$2a$$14$$....
# OLLAMA_MODEL=qwen2.5:3b
```

Start:

```bash
docker compose -f compose.yaml -f compose.prod.yaml up -d --build
```

The first build takes 10 to 15 minutes. Caddy gets the certificate on the first request to `https://SITE_DOMAIN`.

## Update

```bash
git pull && docker compose -f compose.yaml -f compose.prod.yaml up -d --build
```

## Notes

- Projects are backed up in `./data`; back that folder up.
- Only Caddy is exposed. The app and Ollama have no published ports.
- `/api/import-url` (yt-dlp) downloads from third-party sites; YouTube often blocks datacenter IPs and downloading may breach its terms. Keep the site private.
- Logs: `docker compose logs -f app caddy`.
