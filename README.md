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

The interface includes a token-based dark design foundation and a `sodium` body class. To install the official [Sodium design.how](https://design.how) registry theme/components and verify the lint, run `npm run setup:sodium` on a network-connected computer. This script follows the provided shadcn/design.how commands. The remote registry was unavailable from the authoring environment, so no claim is made that the official remote theme was successfully installed.

## Privacy

No authentication, server-side music storage, metadata upload or analytics. Audio stays local in the browser, and recordings are local downloads. Clear the library to delete IndexedDB entries.

## License

MIT. The hardware-like controller appearance is an independent HTML/CSS recreation, not firmware or code from a hardware manufacturer.
