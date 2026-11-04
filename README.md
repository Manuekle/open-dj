<p align="center">
  <img src="src/app/icon.svg" alt="Shift logo" width="128" height="128">
</p>

<h1 align="center">Shift</h1>

<p align="center">
  A two-deck DJ workstation in your browser, with stem separation, automatic transition planning,<br>
  a local AI second opinion, a four-track voice studio and a rhythm game. Everything runs on your own machine.
</p>

<p align="center">
  <a href="https://github.com/Manuekle/open-dj/actions/workflows/ci.yml"><img src="https://github.com/Manuekle/open-dj/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933.svg" alt="Node.js 22 or newer">
</p>

Shift is built with Next.js, React, TypeScript and the Web Audio API. It splits tracks into stems with [Demucs](https://github.com/facebookresearch/demucs), analyzes tempo, key, loudness and frequency bands in the browser, plans transitions between tracks, asks a local model through [Ollama](https://ollama.com) for a second opinion, and saves every project as you work. There are no accounts, no analytics and no cloud services.

## Contents

- [Quick start](#quick-start)
- [Features](#features)
- [Pages](#pages)
- [Configuration](#configuration)
- [Running without Docker](#running-without-docker)
- [Development](#development)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [Design](#design)
- [Privacy](#privacy)
- [License and credits](#license-and-credits)

## Quick start

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine with Compose), with at least 8 GB of memory for Docker and about 10 GB of free disk.

```bash
git clone https://github.com/Manuekle/open-dj.git && cd open-dj && docker compose up -d --build
```

Open http://localhost:3000.

That one command builds the app image (Node, ffmpeg, Demucs and its model), starts Ollama, downloads the AI model and loads it into memory. The first run takes 10 to 15 minutes, mostly downloads; later starts take seconds. The app works as soon as it is up. The **AI plan** button turns on once the model download finishes (`docker compose logs -f model` shows progress).

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

## Features

### Decks and mixer

- Two decks with play, cue, 8 hot cues, beat sync on the estimated BPM, beat jumps, loops (in, out, auto, 1/4 to 32 beats), tempo ±25%, jog wheels and a waveform per deck.
- A mixer with trim, 3-band EQ, a color filter, channel faders, level meters, master and crossfader, plus a beat FX unit (echo, reverb, filter, flanger, phaser, bitcrush).
- **Manual tempo**: type a BPM for a track the analysis gave no tempo (a loose live take, an orchestra) or the wrong one (half or double time). It becomes a constant beat grid, so sync, bar extrapolation and the planner treat it like any steady track. The range is 40 to 240 BPM.
- Keyboard shortcuts for both decks (press `?` to list them).
- Recording of the master output with MediaRecorder (WebM/Opus or M4A, whatever the browser supports), saved under Recordings.

### Mixing analysis

Every track is analyzed in the browser on import (`src/lib/analyze.ts`, with the signal processing in `src/lib/analyze-dsp.ts`, run in a Web Worker):

- **Tempo and beat grid**: onset strength, autocorrelation for the tempo, and a comb filter for the phase of the first beat.
- **Key**: a chromagram (4096-point FFT every half second, 65 Hz to 2.1 kHz folded onto 12 pitch classes) correlated with the Krumhansl-Kessler major and minor profiles, given as a key and a Camelot code with a clarity score.
- **Loudness**: integrated LUFS per ITU-R BS.1770-4 (K-weighting, 400 ms blocks, the -70 LUFS and -10 LU gates). Decks trim toward -11 LUFS on load.
- **Bands**: power per second in the DJ-mixer bands, low 20-250 Hz, mid 250-2500 Hz, high 2.5-5.5 kHz, in dB.
- **Stems**: level per second of vocals, drums, bass and melody, once a track is split.

### Transitions

The transition editor shows both waveforms around the mix, with the volume, bass and effect curves drawn on them. Drag a waveform to move its point (it snaps to the beat), then pick the shape:

| Option | Choices |
|---|---|
| Length | 1 to 16 bars |
| Volume curve | Crossfade, Linear, S-curve, Overlap, Early in, Hold out, Fade out/in, Cut, or **Custom** (click a curve to add a point, drag to move it, double-click or `Delete` to remove it) |
| Bass / EQ | None, Bass swap, Gradual |
| Effect | Low pass out, High pass out, High pass in, Low pass in, Filter swap, Echo out, Dub echo, Reverb wash, Flanger |
| Stem move | Vocal handover, Bass stem swap, Drums first, Acapella over, Full stem blend |

**Mix now** runs the transition at once. The curves live in `src/lib/transition.ts`, shared by the audio engine and the editor, so what is drawn is what plays. A transition can also be rendered offline through the real deck graph (`src/lib/mix-render.ts`), which is how the tests look at the actual samples.

### Smart AutoMix

AutoMix is an Auto DJ that plays a queue deck after deck (`src/lib/automix.ts`). While one track plays it analyzes the next, loads it on the other deck, plans the transition (or uses the plan you saved for that pair), waits for the out point and mixes. The queue holds track ids in any order, supports loop, and the **Smart** order sorts it by how well tracks go together (tempo, key on the Camelot wheel and energy flow), against **Original** order. Skips, queue edits, manual loads and stop all cancel stale work through an epoch counter, so a late answer never lands on a newer situation.

The AutoMix panel shows the queue, a countdown to the next mix, the transition curves, the score of the coming pair and the state of the AI and stem services. Settings let you force a style, length, tempo matching (Off, Gentle, Standard), energy flow (Auto, Maintain, Build, Relax) and any of the volume, EQ, effect and stem moves, or leave each on Auto. Switches turn on the AI plan and automatic stem splitting for the queue.

The set timeline lays the whole queue out on one clock, with each track entering at the out point of the one before.

#### The transition planner

For two loaded tracks, `src/lib/transition-planner.ts` builds candidates from six strategies, each at its own lengths and at a few out points (where the outgoing body ends by the loudness heuristic, 8 bars before that, the last bar that fits, your own point) and in points (timed so the incoming body arrives as the blend ends, or from its first beat):

- **Smooth Blend**: 16 beat-matched bars, equal power; only for keys known to sit together and a tempo change under 4%.
- **Beatmatch**: 8 or 4 beat-matched bars with the bass swapped at the middle; up to an 8% tempo change.
- **Energy Boost**: the new track in early at full level behind an opening high pass; only where the heard level rises (after load trims) or the keys make a boost move on the Camelot wheel.
- **EQ Transition**: bass swap plus a filter swap that hides the mids, the pick for clashing keys.
- **Quick Cut**: 1 or 2 bars on a bar line; past an 8% tempo change the incoming track keeps its own tempo and the old one echoes out.
- **Smart Fallback**: a crossfade that does not lean on the beat grid, taken when nothing else can play (no tempo, a track too short), when the best score is under 45 or when the analysis confidence is under 30%.

Each candidate gets a score from 0 to 100, the weighted mean of tempo, harmony, energy flow, structure, bass, vocals, beat grid, fit and continuity (weights are configurable), and a separate confidence in the analysis behind it (beat strength, key clarity, loudness series, bands, analysis version). A criterion with no data drops out of the score instead of being guessed, and the notes say which. Structure means the loudness heuristics only: the planner does not detect verses, choruses or downbeats.

The chosen plan is an ordinary transition plan, so the editor, its draggable points and **Mix now** work on it as before, and a plan you edit is rated again with the same criteria. Its reasons are listed under the editor.

### AI transitions

**AI plan** in the transition header gives a local model, through Ollama, both tracks' analysis (per-bar loudness, bands and stems, key, tempo, LUFS) and the automatic plan (`src/app/api/mix/route.ts`). Ollama holds the answer to a JSON schema: phrase-aligned out and in bars, length, curve, EQ, effect and stem move, with a reason per decision. The plan is kept like one you edited, tagged AI. Nothing is sent outside your machine.

### Stems

Press **Split** in the library's Stems column, or **Split stems** in a deck's Stems pad mode. `src/app/api/stems/route.ts` runs Demucs (`htdemucs`) on the machine serving the app, about half the track's length on an Apple M2 CPU, and merges the four stems (vocals, drums, bass, melody) into one 8-channel FLAC that the browser keeps with the track.

A deck plays that file through one gain per stem (`src/lib/audio-engine.ts`), so the stems stay sample-locked through tempo, seeks and loops. The Stems pads mute each stem, or jump to **Vox** (vocals only), **Inst** (no vocals), **Beat** (drums and bass) or **All**. The [Stems page](#pages) shows every stem on its own lane, like a DAW playlist, with mute, solo and level per lane.

### Studio

The [Studio page](#pages) is a four-track workspace for recording your voice over your library (`src/components/studio/`, `src/lib/studio.ts`):

- Each of the four lanes takes a track, a stem of a track, or a microphone take. Arm a lane to record over the others, with mute, solo, level and a nudge of ±300 ms per lane.
- A latency slider lines the recorded voice up with what the singer heard through the speakers.
- **Autotune** corrects a take offline to a key and scale (chromatic, major, minor or minor pentatonic) with a retune speed and an amount (`src/lib/autotune.ts`). It tracks pitch with YIN and retunes with pitch-synchronous overlap-add, so the length and the formants stay. The original take is kept, so you can tune again.
- **Export WAV** renders the mix down.

### Lyrics and karaoke

**Transcribe** in the library's Lyrics column writes a track's lyrics with a start and an end for every word, using [whisper.cpp](https://github.com/ggml-org/whisper.cpp) on the machine serving the app (`src/app/api/lyrics/route.ts`). The words stay with the track; the lines are worked out when they are shown (`src/lib/lyrics.ts`). When the track has stems, only its **vocals** stem is transcribed: no drums to mistake for words, and tighter times.

The [Karaoke page](#pages) plays the track with its words lighting up as they are sung: the line now sung is large, the words already sung are dark and the current word is marked. Click a line to jump to it. With stems, **Vocals** turns the singer off and leaves the instrumental. **Earlier** and **Later** move every time by 0.1 s when Whisper ran a little off, and **Download LRC** saves the lyrics as an enhanced LRC file (a tag per line and per word) that karaoke and music players read.

Language is detected by default; pick one in the Karaoke page before transcribing when detection guesses wrong on a short or noisy track. Whisper does not know the real lyrics, it writes what it hears, so check sung or mumbled passages. Run `npm run setup:whisper` once (it needs [Homebrew](https://brew.sh) on a Mac, or `whisper-cli` on your `PATH`, and ffmpeg). The model is `small` (488 MB) by default; `WHISPER_MODEL_NAME=large-v3-turbo npm run setup:whisper` fetches a better one.

### Sampler and drum machine

On the main page, below the decks, a sampler and 16-step drum machine feed the same master, so a recording takes them too. Play a built-in tone or a dropped-in sample from the on-screen piano, the computer keyboard or a MIDI keyboard, shape it with an effects chain, and play back Standard MIDI Files (`src/components/studio.tsx`, `src/lib/sampler.ts`, `src/lib/midi.ts`).

### Rhythm game

The [Rhythm page](#pages) turns any track from your library, or a file you drop in, into a falling-tiles rhythm game charted from the audio alone (`src/lib/rhythm-game/`). Onset envelopes say where something happens and the beat grid says where a player would feel it. Low sounds go to the left lanes and bright ones to the right.

| Difficulty | Lanes | Keys |
|---|---|---|
| Easy, Normal | 4 | `D` `F` `J` `K` |
| Hard | 6 | `S` `D` `F` `J` `K` `L` |
| Expert | 7 | `S` `D` `F` `Space` `J` `K` `L` |

Scroll speed and timing offset are adjustable and remembered.

### Projects and saving

Each project is a set with its own tracks and the whole session: what each deck holds and where it is, tempo, EQ, trim, color, effects, stem mutes, the mixer, the play queue, saved transition plans, auto mix and hot cues per track. Pick, create, rename or delete projects from the header; switching saves the one you leave. Tracks you add go to the open project.

Saving is automatic, and the header shows when it last happened. Every change reaches the browser's IndexedDB within a second (`src/hooks/use-projects.ts`), and `src/app/api/backup/route.ts` mirrors projects, their tracks (audio, stems, cover, analysis) and recordings to `./data` every few seconds and once more as the tab closes. On open, the newer copy of each project wins, and anything the browser lost comes back from disk, so a cleared browser, another browser or a crash costs at most the last few seconds. If the `data` folder is lost instead, any browser that still has the projects fills it again.

To move a set to another computer, copy the `data` folder next to `compose.yaml` there and start it.

### Import from a link

**From link** in the library downloads one track's audio and imports it like a dropped file, optionally cut to a start and end (`MM:SS`, `HH:MM:SS` or plain seconds). `src/app/api/import-url/route.ts` runs [yt-dlp](https://github.com/yt-dlp/yt-dlp) and ffmpeg on the machine serving the app. The audio is kept as published (AAC in M4A preferred, otherwise Opus or MP3) with no re-encoding, and files are capped at 150 MB.

The Docker image includes ffmpeg but **not yt-dlp**, so this feature needs yt-dlp installed on the machine running the app (without Docker) or added to the image. `YTDLP_BIN` and `FFMPEG_BIN` override their paths. Use it only for audio you have the right to copy: public domain, Creative Commons or your own.

## Pages

| Route | What it is |
|---|---|
| `/` | The DJ workstation: library, two decks, mixer, transition editor, AutoMix, set timeline, sampler and drum machine. |
| `/stems` | Every stem of a track on its own lane, with mute, solo and level. |
| `/lyrics` | Karaoke: the lyrics of a track with the timing of every word, an instrumental mode when the track has stems, LRC export. |
| `/studio` | Four-track studio: record your voice over stems of your library, autotune it, export the mix. |
| `/play` | The rhythm game. |
| `/diagnostics` | An audio self-test (automation, pitch, clock and drift checks) to run in each browser you care about and compare. |

## Configuration

Copy `.env.example` to `.env` and uncomment what you want to change, then run `docker compose up -d` again.

| Variable | Default | What it sets |
|---|---|---|
| `PORT` | `3000` | Port on this machine. The app only listens on localhost, since it has no accounts. |
| `DATA_PATH` | `./data` | Folder for the project backup (mounted as `/data` in Docker). |
| `OLLAMA_MODEL` | `qwen2.5:3b` in Docker, `qwen2.5:7b` otherwise | Model for AI transitions. `qwen2.5:7b` plans better and needs about 6 GB of Docker memory. |
| `OLLAMA_URL` | `http://ollama:11434` in Docker, `http://127.0.0.1:11434` otherwise | Where the app finds Ollama. |

Without Docker, the routes also read these (all optional):

| Variable | Default | Used by |
|---|---|---|
| `DATA_DIR` | `./data` | Disk backup. |
| `DEMUCS_BIN` | `.demucs/bin/demucs` | Stem separation. |
| `DEMUCS_MODEL` | `htdemucs` | Stem separation. |
| `DEMUCS_DEVICE` | unset (Demucs picks) | `cpu`, `mps` or `cuda`. |
| `FFMPEG_BIN` | `ffmpeg` | Stems, lyrics and link import. |
| `WHISPER_BIN` | `whisper-cli` | Lyrics. |
| `WHISPER_MODEL` | `.whisper/ggml-small.bin` | Lyrics: path of the Whisper model. |
| `YTDLP_BIN` | `yt-dlp` | Link import. |

### Faster AI on a Mac

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

Open http://localhost:3000. Stems, lyrics and AI are optional: without Demucs the Split buttons stay disabled, without Whisper (`npm run setup:whisper`) the Transcribe buttons do, and without Ollama the AI plan button does.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server. |
| `npm run build` / `npm start` | Production build and server. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint. |
| `npx eslint -c sodium.eslint.config.mjs .` | The Sodium design system lint. |
| `npm test` | Vitest: analysis, planner, AutoMix, transitions, studio, autotune, rhythm game and the offline audio renders. |

CI (`.github/workflows/ci.yml`) runs typecheck, lint and build on Node 22 for every push to `main` and every pull request.

## Project layout

| Path | What it holds |
|---|---|
| `src/app` | Pages (`/`, `/stems`, `/studio`, `/play`, `/diagnostics`), the app icon and the API routes. |
| `src/app/api/stems` | Demucs stem separation jobs. |
| `src/app/api/mix` | The AI planner, on Ollama. |
| `src/app/api/backup` | The disk backup of projects, tracks and recordings. |
| `src/app/api/import-url` | Audio import from a link with yt-dlp and ffmpeg. |
| `src/app/api/lyrics` | Word-timed lyrics with whisper.cpp. |
| `src/hooks/use-dj.ts` | All audio and session state: decks, mixer, transitions, stems, AI plans, AutoMix host. |
| `src/hooks/use-projects.ts` | Projects, autosave and the disk backup sync. |
| `src/lib/audio-engine.ts`, `deck-graph.ts` | The Web Audio graph: per-deck stems, trim, EQ, filters, effects, crossfader, recorder. |
| `src/lib/analyze.ts`, `analyze-dsp.ts` | Tempo, beat grid, key, LUFS, bands and stem levels. |
| `src/lib/transition.ts`, `transition-options.ts` | Transition curves, structure heuristics, the rule-based plan and the option names. |
| `src/lib/transition-planner.ts` | Smart AutoMix's planner: candidates, scoring, confidence, strategy choice. |
| `src/lib/automix.ts`, `queue.ts`, `planner.ts` | The Auto DJ state machine, the play queue and queue-level planning (Smart ordering, skips). |
| `src/lib/lyrics.ts` | Whisper output into timed words and lines, the line under the playhead, LRC export. |
| `src/lib/autotune.ts`, `studio.ts`, `sampler.ts`, `midi.ts` | Studio: pitch correction, timeline helpers, sampler and MIDI. |
| `src/lib/rhythm-game` | Chart generation, judging and the canvas playfield. |
| `src/lib/procedural` | Procedural sound effects for the studio (see credits). |
| `src/components` | The interface, built on the Sodium design system. |
| `scripts/setup-demucs.sh` | Demucs install for running without Docker. |
| `scripts/setup-whisper.sh` | whisper.cpp and Whisper model install for lyrics. |
| `docs/superpowers/specs` | Design notes for larger features. |

## Troubleshooting

- **The AI plan button stays off.** Ollama is not reachable or the model is not pulled. With Docker, `docker compose logs model` shows the download; without Docker, run `ollama serve` and `ollama pull qwen2.5:7b`. Hovering the button says which.
- **An AI plan times out.** The model is too large for the memory or CPU Docker has. Use `OLLAMA_MODEL=qwen2.5:3b`, give Docker more memory, or use Ollama on the host as described under [Faster AI on a Mac](#faster-ai-on-a-mac).
- **The Split buttons stay off.** Demucs is not installed: run `npm run setup:stems`, or use Docker, which includes it.
- **The Transcribe buttons stay off.** whisper.cpp or its model is missing: run `npm run setup:whisper`. The Docker image does not ship whisper.cpp (like yt-dlp), so lyrics need the app running without Docker, or whisper.cpp added to the image.
- **The lyrics come out in the wrong language, or as nonsense.** Pick the language on the Karaoke page before transcribing instead of detecting it, split the track into stems first (the vocals stem is cleaner), or try a larger model.
- **The words light up a little early or late.** Use Earlier and Later on the Karaoke page.
- **From link says `yt-dlp is not installed`.** Install yt-dlp on the machine running the app (see [Import from a link](#import-from-a-link)); the Docker image does not ship it.
- **Port 3000 is in use.** Set `PORT=3001` in `.env` (or run `PORT=3001 docker compose up -d`).
- **Stems play as plain stereo in Safari or Firefox.** Multichannel stem playback is verified in Chromium browsers (Chrome, Edge, Arc, Brave). Open `/diagnostics` in each browser to compare.
- **Recorded voice in the Studio sits early or late.** Adjust the latency slider, or nudge that single lane.

## Design

The interface uses the [Sodium](https://design.how/systems/sodium) design system (dark theme), installed from the design.how registry into `src/components/sodium`. Follow `.claude/skills/sodium/SKILL.md` for UI changes and run its lint (`npx eslint -c sodium.eslint.config.mjs .`). Icons come from Hugeicons, swapped in through Sodium's single icon file (`src/components/sodium/icon.tsx`). Sodium has no rotary control or platter, so the knobs and jog wheels are flat line drawings on Sodium's line and data tokens, animated with GSAP.

The logo (`src/app/icon.svg`) is four mirrored ellipses in an orange gradient on a dark tile. The same glyph is drawn in the header by `src/components/app-mark.tsx`.

## Privacy

No accounts, no analytics, no cloud services. Audio, analysis and recordings stay in the browser and in the `data` folder on the machine running the app. Stem separation and lyrics transcription run there in a temporary folder that is deleted once the result comes back, and AI transitions run on the local Ollama model. The app only listens on localhost. The one outbound request is the one you ask for: **From link** contacts the site you paste.

## License and credits

MIT, see [LICENSE](LICENSE). The hardware-like controller appearance is an independent HTML/CSS recreation, not firmware or code from a hardware manufacturer.

Built on [Next.js](https://nextjs.org), [React](https://react.dev), [GSAP](https://gsap.com), [Demucs](https://github.com/facebookresearch/demucs), [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [Ollama](https://ollama.com), [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org). The studio's sound effects use recipes from [procedural-sounds](https://github.com/m1ckc3s/procedural-sounds); see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
