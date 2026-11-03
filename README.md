# Open DJ

A browser-based two-deck DJ mixing workstation built with Next.js, React, TypeScript and Web Audio.

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:3000. Add your own MP3, WAV, M4A or OGG files. Files stay on your machine (IndexedDB); the audio is never uploaded to a server.

## Controls

- Load a song into Deck A or B from the library (A/B buttons, or double click).
- Play/pause, cue, hot cues, beat sync (estimated BPM), jog seek, looping, tempo, EQ, filters, FX and crossfader.
- Record the master output using the browser's MediaRecorder, then download it. The recording codec depends on browser support (usually WebM/Opus or MP4/AAC). Unavailable recording formats are not mislabeled as MP3.
- Audio runs locally with the Web Audio API. Analysis BPM is approximate.

## Sodium setup

This repository includes Sodium's official CSS tokens, styles, base stylesheet, portal and skill (sourced from the public [arla6ka/design.how](https://github.com/arla6ka/design.how) repository), with its dark theme enabled on the root element. The interactive DJ hardware and workstation currently use project-specific controls; full per-component Sodium migration and its lint have **not** been completed. On a network-connected computer run `npm run setup:sodium` to install the registry theme, additional design.how skills and the strict Sodium lint. Then follow `.agents/skills/sodium/SKILL.md` for the remaining UI migration.

## Privacy

No authentication, server-side music storage, metadata upload or analytics. Audio stays local in the browser, and recordings are local downloads. Clear the library to delete IndexedDB entries.

## License

MIT. The hardware-like controller appearance is an independent HTML/CSS recreation, not firmware or code from a hardware manufacturer.
