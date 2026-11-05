// Word-timed lyrics for the landing page's karaoke: transcribes the vocals stem of its Outside excerpt
// (docs/media/stems/outside-vocals.mp3, split by Demucs) with whisper.cpp the same way /api/lyrics does, and writes
// docs/media/stems/outside-lyrics.json as { words: [{ t, e, w }] } with times in seconds from the start of the excerpt.
// Needs ffmpeg and whisper.cpp with a model in .whisper/ (npm run setup:whisper). Run: node scripts/demo-lyrics.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dtwPreset, parseSpeech, parseWhisper } from "../src/lib/lyrics.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vocals = process.env.DEMO_VOCALS ?? path.join(root, "docs/media/stems/outside-vocals.mp3");
const out = process.env.DEMO_OUT ?? path.join(root, "docs/media/stems/outside-lyrics.json");
const whisper = process.env.WHISPER_BIN ?? "whisper-cli";
const vadBin = process.env.WHISPER_VAD_BIN ?? "whisper-vad-speech-segments";
const vadModel = path.join(root, ".whisper/ggml-silero-v5.1.2.bin");
const model = process.env.WHISPER_MODEL
  ?? ["large-v3", "large-v3-turbo", "medium", "small", "base"].map(n => path.join(root, `.whisper/ggml-${n}.bin`)).find(f => existsSync(f));

if (!existsSync(vocals)) throw new Error(`Missing ${vocals}`);
if (!model) throw new Error("No Whisper model in .whisper/. Run npm run setup:whisper.");

const dir = mkdtempSync(path.join(tmpdir(), "shift-demo-lyrics-"));
try {
  const wav = path.join(dir, "vocals.wav");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", vocals, "-af", "pan=mono|c0=0.5*c0+0.5*c1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
  const threads = String(Math.max(2, Math.min(8, availableParallelism() - 1)));
  // Where the voice is (Silero VAD), to pull stray words back to where the singing starts. Optional, as in /api/lyrics.
  let speech = [];
  if (existsSync(vadModel)) {
    const vad = spawnSync(vadBin, ["-f", wav, "-vm", vadModel, "-vt", "0.3", "-vsd", "300", "-vp", "200", "-t", threads], { encoding: "utf8" });
    if (vad.status === 0) speech = parseSpeech((vad.stdout ?? "") + (vad.stderr ?? ""));
  }
  const args = ["-m", model, "-f", wav, "-l", "en", "-ml", "1", "-sow", "-mc", "0", "-sns", "-ojf", "-of", path.join(dir, "out"), "-t", threads];
  const dtw = dtwPreset(model);
  if (dtw) args.push("-dtw", dtw, "-nfa");
  execFileSync(whisper, args, { stdio: ["ignore", "ignore", "inherit"] });
  const { words } = parseWhisper(JSON.parse(readFileSync(path.join(dir, "out.json"), "utf8")), speech);
  writeFileSync(out, JSON.stringify({ words }));
  console.log(`Wrote ${words.length} words to ${path.relative(root, out)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
