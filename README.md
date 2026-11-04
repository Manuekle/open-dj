# Shift

A two-deck DJ workstation in the browser, built with Next.js, React, TypeScript and Web Audio. It splits tracks into stems with Demucs, plans transitions from key, tempo, loudness and frequency bands, asks a local AI model (Ollama) for a second opinion, and saves every project as you work. Everything runs on your own machine.

## Quick start

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine with Compose) with at least 8 GB of memory for Docker and about 10 GB of free disk.

```bash
git clone https://github.com/Manuekle/open-dj.git && cd open-dj && docker compose up -d --build
```

Open http://localhost:3000.

That one command builds the app image (Node, ffmpeg, Demucs and its model), starts Ollama, downloads the AI model and loads it into memory. The first run takes 10 to 15 minutes, mostly downloads; later starts take seconds. The app works as soon as it is up; the **AI plan** button turns on once the model download finishes (`docker compose logs -f model` shows it).

| Service | What it does |
|---|---|
| `app` | The site on http://localhost:3000, stem separation with Demucs, the AI and backup routes. Projects are backed up to `./data`. |
| `ollama` | The local model server. Models live in the `ollama` Docker volume. |
| `model` | Pulls `OLLAMA_MODEL` into Ollama once, then exits. |

### Everyday commands

```bash
docker compose up -d --build
```
Start, or update after a `git pull`.

```bash
docker compose down
```
Stop everything. Projects stay in `./data` and the model stays in its volume.

```bash
docker compose logs -f app
```
Follow the app's log.

```bash
docker compose down -v
```
Stop and also delete the downloaded model (it is pulled again on the next start). `./data` is never deleted by Docker.

### Settings

Copy `.env.example` to `.env` and uncomment what you want to change, then run `docker compose up -d` again.

| Variable | Default | What it sets |
|---|---|---|
| `PORT` | `3000` | Port on this machine. The app only listens on localhost, since it has no accounts. |
| `DATA_PATH` | `./data` | Folder for the project backup. |
| `OLLAMA_MODEL` | `qwen2.5:3b` | Model for AI transitions. `qwen2.5:7b` plans better and needs about 6 GB of Docker memory. |
| `OLLAMA_URL` | `http://ollama:11434` | Where the app finds Ollama. |

Ollama in Docker on a Mac runs on the CPU only, so a plan for a new pair of tracks takes one to two and a half minutes (the button shows Planning meanwhile). With [Ollama](https://ollama.com) installed on the Mac itself it uses the GPU and is several times faster: run `ollama pull qwen2.5:7b`, then set `OLLAMA_URL=http://host.docker.internal:11434` and `OLLAMA_MODEL=qwen2.5:7b` in `.env`.

## Running without Docker

For development. You need Node.js 22, ffmpeg, [uv](https://docs.astral.sh/uv/) (for Demucs) and [Ollama](https://ollama.com).

```bash
npm install
```

```bash
npm run setup:stems
```
Installs Demucs from [Manuekle/demucs](https://github.com/Manuekle/demucs) into `.demucs/` (Python 3.11 and PyTorch 2.0, about 1 GB) and downloads the htdemucs model.

```bash
ollama pull qwen2.5:7b
```

```bash
npm run dev
```

Open http://localhost:3000. Stems and AI are optional: without Demucs the Split buttons stay disabled, and without Ollama the AI plan button does. Other scripts: `npm run typecheck`, `npm run lint`, `npm run build`, and the design system lint `npx eslint -c sodium.eslint.config.mjs .`.

## Features

### Decks and mixer

- Two decks with play, cue, 8 hot cues, beat sync on the estimated BPM, beat jumps, loops (in, out, auto, 1/4 to 32 beats), tempo ±25%, jog wheels and a waveform per deck.
- A mixer with trim, 3-band EQ, a color filter, channel faders, level meters, master and crossfader, plus a beat FX unit (echo, reverb, filter, flanger, phaser, bitcrush).
- Keyboard shortcuts for both decks (press `?`).
- Recording of the master output with MediaRecorder (WebM/Opus or M4A, whatever the browser supports), saved under Recordings.

### Transitions

The transition editor shows both waveforms around the mix, with the volume, bass and effect curves drawn on them. Drag a waveform to move its point (it snaps to the beat), and pick the length (1 to 16 bars), volume curve, bass swap, effect and stem move. **Mix now** runs it at once; **Auto mix** runs each transition at its out point and loads the next track. The curves live in `src/lib/transition.ts`, shared by the audio and the editor, so what is drawn is what plays.

### Mixing analysis

Every track is analyzed in the browser on import (`src/lib/analyze.ts`):

- **Tempo and beat grid**: onset strength, autocorrelation for the tempo, and a comb filter for the phase of the first beat.
- **Key**: a chromagram (4096-point FFT every half second, 65 Hz to 2.1 kHz folded onto 12 pitch classes) correlated with the Krumhansl-Kessler major and minor profiles, given as a key and a Camelot code with a clarity score.
- **Loudness**: integrated LUFS per ITU-R BS.1770-4 (K-weighting, 400 ms blocks, the -70 LUFS and -10 LU gates). Decks trim toward -11 LUFS on load.
- **Bands**: power per second in the DJ-mixer bands, low 20-250 Hz, mid 250-2500 Hz, high 2.5-5.5 kHz, in dB.
- **Stems**: level per second of vocals, drums, bass and melody, once a track is split.

The automatic plan comes from Smart AutoMix's transition planner (`src/lib/transition-planner.ts`). For the two loaded tracks it builds candidates from six strategies, each at its own lengths and at a few out points (where the outgoing body ends by the loudness heuristic, 8 bars before that, the last bar that fits, your own point) and in points (timed so the incoming body arrives as the blend ends, or from its first beat):

- **Smooth Blend**: 16 beat-matched bars, equal power; only for keys known to sit together and a tempo change under 4%.
- **Beatmatch**: 8 or 4 beat-matched bars with the bass swapped at the middle; up to an 8% tempo change.
- **Energy Boost**: the new track in early at full level behind an opening high pass; only where the heard level rises (after load trims) or the keys make a boost move on the Camelot wheel.
- **EQ Transition**: bass swap plus a filter swap that hides the mids, the pick for clashing keys.
- **Quick Cut**: 1 or 2 bars on a bar line; past an 8% tempo change the incoming track keeps its own tempo and the old one echoes out.
- **Smart Fallback**: a crossfade that does not lean on the beat grid, taken when nothing else can play (no tempo, a track too short), when the best score is under 45 or when the analysis confidence is under 30%.

Each candidate gets a score from 0 to 100, the weighted mean of tempo, harmony, energy flow, structure, bass, vocals, beat grid, fit and continuity (weights are configurable), and a separate confidence in the analysis behind it (beat strength, key clarity, loudness series, bands, analysis version). A criterion with no data drops out of the score instead of being guessed, and the notes say which. Structure means the loudness heuristics only: the planner does not detect verses, choruses or downbeats. The chosen plan is an ordinary transition plan, so the editor, its draggable points and **Mix now** work on it as before, and a plan you edit is rated again with the same criteria. Its reasons are listed under the editor. The earlier rule-based `autoPlan` in `src/lib/transition.ts` is still there, and the AI plan still receives the automatic plan.

### AI transitions

**AI plan** in the transition header gives both tracks' analysis (per-bar loudness, bands and stems, key, tempo, LUFS) and the automatic plan to a local model through Ollama (`src/app/api/mix/route.ts`). Ollama holds the answer to a JSON schema: phrase-aligned out and in bars, length, curve, eq, effect and stem move, with a reason per decision. The plan is kept like one you edited, tagged AI. Nothing is sent outside your machine.

### Stems

Press **Split** in the library's Stems column, or **Split stems** in a deck's Stems pad mode. `src/app/api/stems/route.ts` runs Demucs (htdemucs) on the machine serving the app, about half the track's length on an Apple M2 CPU, and merges the four stems into one 8-channel FLAC that the browser keeps with the track. A deck plays that file through one gain per stem (`src/lib/audio-engine.ts`), so the stems stay sample-locked through tempo, seeks and loops. The Stems pads mute each stem, or jump to Vox (vocals only), Inst (no vocals), Beat (drums and bass) or All.

Without Docker, the route reads `DEMUCS_BIN` (default `.demucs/bin/demucs`), `DEMUCS_MODEL` (default `htdemucs`), `DEMUCS_DEVICE` (`cpu`, `mps` or `cuda`; Demucs picks when unset) and `FFMPEG_BIN`.

### Projects and saving

Each project is a set with its own tracks and the whole session: what each deck holds and where it is, tempo, EQ, trim, color, effects, stem mutes, the mixer, saved transition plans, auto mix and hot cues per track. Pick, create, rename or delete projects from the header; switching saves the one you leave. Tracks you add go to the open project.

Saving is automatic, and the header shows when it last happened. Every change reaches the browser's IndexedDB within a second (`src/hooks/use-projects.ts`), and `src/app/api/backup/route.ts` mirrors projects, their tracks (audio, stems, cover, analysis) and recordings to `./data` every few seconds and once more as the tab closes. On open, the newer copy of each project wins, and anything the browser lost comes back from disk, so a cleared browser, another browser or a crash costs at most the last few seconds. If the `data` folder is lost instead, any browser that still has the projects fills it again.

To move a set to another computer, copy the `data` folder next to `compose.yaml` there and start it.

### Import from a link

**From link** in the library downloads one track's audio and imports it like a dropped file, optionally cut to a start and end (`MM:SS` or `HH:MM:SS`). `src/app/api/import-url/route.ts` runs [yt-dlp](https://github.com/yt-dlp/yt-dlp) (the maintained youtube-dl fork) and ffmpeg on the machine serving the app, so both must be installed (`YTDLP_BIN` and `FFMPEG_BIN` override their paths). Use it only for audio you have the right to copy: public domain, Creative Commons or your own.

### Studio

A sampler and 16-step drum machine on the same master, so a recording takes it too: play a built-in tone or a dropped-in sample from the on-screen piano, the computer keyboard or a MIDI keyboard, shape it with an effects chain, and play back Standard MIDI Files (`src/components/studio.tsx`, `src/lib/sampler.ts`, `src/lib/midi.ts`).

## Project layout

| Path | What it holds |
|---|---|
| `src/hooks/use-dj.ts` | All audio and session state: decks, mixer, transitions, stems, AI plans. |
| `src/hooks/use-projects.ts` | Projects, autosave, and the disk backup sync. |
| `src/lib/audio-engine.ts` | The Web Audio graph: per-deck stems, trim, EQ, filters, effects, crossfader, recorder. |
| `src/lib/analyze.ts` | Tempo, beat grid, key, LUFS, bands and stem levels. |
| `src/lib/transition.ts` | Transition curves, structure heuristics and the rule-based plan. |
| `src/lib/transition-planner.ts` | Smart AutoMix's transition planner: candidates, scoring, confidence, strategy choice. |
| `src/app/api/stems` | Demucs stem separation jobs. |
| `src/app/api/mix` | The AI planner, on Ollama. |
| `src/app/api/backup` | The disk backup of projects, tracks and recordings. |
| `src/components` | The interface, built on the Sodium design system. |
| `scripts/setup-demucs.sh` | Demucs install for running without Docker. |

## Troubleshooting

- **The AI plan button stays off.** Ollama is not reachable or the model is not pulled. With Docker, `docker compose logs model` shows the download; without Docker, run `ollama serve` and `ollama pull qwen2.5:7b`. Hovering the button says which.
- **An AI plan times out.** The model is too large for the memory or CPU Docker has. Use `OLLAMA_MODEL=qwen2.5:3b`, give Docker more memory, or use Ollama on the host as described under Settings.
- **The Split buttons stay off.** Demucs is not installed: run `npm run setup:stems`, or use Docker, which includes it.
- **Port 3000 is in use.** Set `PORT=3001` in `.env` (or run `PORT=3001 docker compose up -d`).
- **Stems play as plain stereo in Safari or Firefox.** Multichannel stem playback is verified in Chromium browsers (Chrome, Edge, Arc, Brave).

## Design

The interface uses the [Sodium](https://design.how/systems/sodium) design system (dark theme), installed from the design.how registry into `src/components/sodium`. Follow `.claude/skills/sodium/SKILL.md` for UI changes and run its lint (`npx eslint -c sodium.eslint.config.mjs .`). Icons come from Hugeicons, swapped in through Sodium's single icon file (`src/components/sodium/icon.tsx`). Sodium has no rotary control or platter, so the knobs and jog wheels are flat line drawings on Sodium's line and data tokens, animated with GSAP.

## Privacy

No accounts, no analytics, no cloud services. Audio, analysis and recordings stay in the browser and in the `data` folder on the machine running the app. Stem separation runs there in a temporary folder that is deleted once the stems come back, and AI transitions run on the local Ollama model. The app only listens on localhost.

## License

MIT, see [LICENSE](LICENSE). The hardware-like controller appearance is an independent HTML/CSS recreation, not firmware or code from a hardware manufacturer.
