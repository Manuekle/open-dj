/* Lyrics with timing, for karaoke. A transcription (whisper.cpp, run by /api/lyrics) gives every sung word a start and an
   end. Those words are what a track keeps; lines are worked out from them when they are shown, so the way lines break can
   change without transcribing again. Pure functions, no DOM: the page and the tests share them. */

/** One sung word: start and end in seconds of the track, and its text with punctuation. */
export type LyricWord = { t: number; e: number; w: string };
export type Lyrics = {
  version: 1;
  /** Language code Whisper heard, "en", "es"… */
  language: string;
  /** What was transcribed: the whole mix, or only the vocals stem (cleaner, so the words and times are better). */
  source: "mix" | "vocals";
  words: LyricWord[];
};
export type LyricLine = { t: number; e: number; text: string; words: LyricWord[] };

/** whisper.cpp's JSON (-ojf with one word per entry): offsets in milliseconds; with -dtw, every token also has t_dtw, its
    start in centiseconds (-1 for special tokens). */
type WhisperToken = { text?: string; t_dtw?: number };
type WhisperEntry = { offsets?: { from?: number; to?: number }; text?: string; tokens?: WhisperToken[] };

/** Tags Whisper writes for sound that is not speech: [MUSIC], (applause), ♪, [_BEG_]. */
const NOISE = /^(?:[[(*♪♫].*[\])*♪♫]|[♪♫]+|\[_.*)$/;

/** A stretch of the track where voice activity detection heard singing: [start, end] in seconds. */
export type Speech = [number, number];

/** Where the first real token of an entry starts by DTW (attention alignment), in seconds, when whisper.cpp computed it. */
function dtwStart(entry: WhisperEntry): number | undefined {
  for (const token of entry.tokens ?? []) {
    if (!token.text || token.text.startsWith("[_")) continue;
    return typeof token.t_dtw === "number" && token.t_dtw >= 0 ? token.t_dtw / 100 : undefined;
  }
}

/**
 * Words from whisper.cpp's JSON output. A piece without a leading space continues the word before it (a comma, "n't").
 *
 * A word starts where DTW put it when whisper.cpp ran with -dtw: Whisper's own timestamp guesses drift over every pause
 * (the first word after an instrumental break often starts where the last phrase ended), the attention alignment does
 * not. `speech`, where voice activity detection heard singing, moves a start still left in a silence to where the
 * singing comes back. A word ends where the next one starts, unless a pause comes between them.
 */
export function parseWhisper(json: unknown, speech: Speech[] = []): { language: string; words: LyricWord[] } {
  const body = (json ?? {}) as { result?: { language?: string }; transcription?: WhisperEntry[] };
  // `from` is Whisper's own start, kept for the word's length: its end minus it.
  let words: (LyricWord & { from: number })[] = [];
  for (const entry of body.transcription ?? []) {
    const raw = entry.text ?? "";
    const text = raw.trim();
    if (!text || NOISE.test(text)) continue;
    const from = (entry.offsets?.from ?? 0) / 1000, to = (entry.offsets?.to ?? 0) / 1000;
    const prev = words[words.length - 1];
    if (prev && !/^\s/.test(raw)) { prev.w += text; prev.e = Math.max(prev.e, to); continue; }
    words.push({ t: dtwStart(entry) ?? from, e: to, w: text, from });
  }
  words = dropHallucinations(words);
  // Times only move forward.
  let last = 0;
  for (const word of words) last = word.t = Math.max(word.t, last);
  if (speech.length) words.forEach((word, i) => snapToSpeech(word, words[i + 1]?.t ?? Infinity, speech));
  return { language: body.result?.language ?? "", words: words.map((word, i) => ({ t: word.t, e: wordEnd(word, words[i + 1], speech), w: word.w })) };
}

/** How close (seconds) a start must be to a stretch of singing to count as inside it. */
const SLACK = 0.15;
const speechAt = (speech: Speech[], time: number) => speech.find(([start, end]) => time >= start - SLACK && time <= end + SLACK);

/** A start left in a silence moves to where the singing comes back, if that is before the next word and not far. */
function snapToSpeech(word: LyricWord, next: number, speech: Speech[]) {
  if (speechAt(speech, word.t)) return;
  const resume = speech.find(([start]) => start > word.t)?.[0];
  if (resume !== undefined && resume < next && resume - word.t < 6) word.t = resume;
}

/**
 * Sung words run into each other, so a word lasts until the next one starts when that is near. Before a pause it lasts
 * what Whisper's timestamps gave it, within reason, and never past the end of its stretch of singing.
 */
function wordEnd(word: LyricWord & { from: number }, next: LyricWord | undefined, speech: Speech[]): number {
  const nextStart = next?.t ?? Infinity;
  const length = Math.min(2.5, Math.max(0.3, word.e - word.from));
  let end = nextStart - word.t <= 1 ? nextStart : Math.min(nextStart, word.t + length);
  const sung = speechAt(speech, word.t);
  if (sung && sung[1] > word.t + 0.1) end = Math.min(end, Math.max(sung[1], word.t + 0.1));
  return Math.max(end, word.t + 0.05);
}

/** What Whisper writes over silence or music when it has nothing to hear, learnt from subtitled videos. */
const HALLUCINATIONS = [
  "you", "bye", "bye bye", "thank you", "thank you very much", "thank you for watching", "thanks for watching",
  "we'll be right back", "see you next time", "please subscribe",
  "like and subscribe", "gracias por ver", "muchas gracias", "suscríbete", "subtítulos realizados por la comunidad de amara.org",
  "subtítulos por la comunidad de amara.org", "subtitles by the amara.org community", "amara.org",
  "sous-titres réalisés par la communauté d'amara.org", "untertitel der amara.org-community", "ご視聴ありがとうございました",
  "字幕由amara.org社区提供",
].map(phrase => phrase.replace(/[^\p{L}\p{N}]+/gu, " ").trim());
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Takes out the phrases Whisper invents for silence ("Thank you.", "Subtítulos por la comunidad de Amara.org"). Only
 * when one stands on its own, with a pause of `gap` seconds (or the track's start or end) on both sides: sung inside a
 * line, "thank you" stays.
 */
function dropHallucinations<T extends LyricWord>(words: T[], gap = 2): T[] {
  const kept: T[] = [];
  let i = 0;
  while (i < words.length) {
    let j = i + 1;
    while (j < words.length && words[j].t - words[j - 1].e < gap) j++;
    const run = words.slice(i, j);
    if (!HALLUCINATIONS.includes(normalize(run.map(w => w.w).join(" ")))) kept.push(...run);
    i = j;
  }
  return kept;
}

/**
 * The stretches of singing in whisper-vad-speech-segments' output: "Speech segment 3: start = 1730.00, end = 1956.00",
 * in centiseconds.
 */
export function parseSpeech(output: string): Speech[] {
  const speech: Speech[] = [];
  for (const match of output.matchAll(/Speech segment \d+: start = ([\d.]+), end = ([\d.]+)/g)) {
    const start = Number(match[1]) / 100, end = Number(match[2]) / 100;
    if (end > start) speech.push([start, end]);
  }
  return speech.sort((a, b) => a[0] - b[0]);
}

const DTW_PRESETS = new Set(["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large.v1", "large.v2", "large.v3", "large.v3.turbo"]);
/** whisper.cpp's alignment-heads preset (-dtw) for a model file, "ggml-large-v3-turbo-q5_0.bin" is "large.v3.turbo", or
    undefined for a model it has none for. */
export function dtwPreset(file: string): string | undefined {
  const name = (file.split(/[\\/]/).pop() ?? "").replace(/^ggml-/, "").replace(/\.bin$/, "").replace(/-q\d_\d$/, "")
    .replace(/^large-v(\d)(-turbo)?$/, (_, version: string, turbo?: string) => `large.v${version}${turbo ? ".turbo" : ""}`);
  return DTW_PRESETS.has(name) ? name : undefined;
}

/** Where a line ends and the next begins. */
export type LineOptions = { gap?: number; chars?: number; words?: number };
const SENTENCE_END = /[.!?…。？！]["')\]]*$/;

/**
 * Words into lines, the way a karaoke screen shows them: a new line after a pause (`gap` seconds), after a sentence ends
 * once the line has a few words, or when the line gets too long for the screen.
 */
export function groupLines(words: LyricWord[], { gap = 1, chars = 42, words: maxWords = 9 }: LineOptions = {}): LyricLine[] {
  const lines: LyricLine[] = [];
  let current: LyricWord[] = [];
  let length = 0;
  const flush = () => {
    if (!current.length) return;
    lines.push({ t: current[0].t, e: current[current.length - 1].e, text: current.map(w => w.w).join(" "), words: current });
    current = []; length = 0;
  };
  for (const word of words) {
    const prev = current[current.length - 1];
    if (prev) {
      const pause = word.t - prev.e >= gap;
      const sentence = SENTENCE_END.test(prev.w) && current.length >= 3;
      const full = length + 1 + word.w.length > chars || current.length >= maxWords;
      if (pause || sentence || full) flush();
    }
    current.push(word);
    length += (current.length > 1 ? 1 : 0) + word.w.length;
  }
  flush();
  return lines;
}

/** Index of the last item that starts at or before `time`, or -1 when none has. `starts` must be sorted. */
export function indexAt(starts: ArrayLike<number>, time: number): number {
  let lo = 0, hi = starts.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** The line being sung at `time`: the last one that has started. Between lines it stays on the one just sung. */
export function lineAt(lines: LyricLine[], time: number): number {
  return indexAt(lines.map(l => l.t), time);
}

/** How much of a word has been sung at `time`, 0..1. */
export function wordFill(word: LyricWord, time: number): number {
  if (time <= word.t) return 0;
  if (time >= word.e) return 1;
  return (time - word.t) / (word.e - word.t);
}

/** A new set of words with every time moved by `seconds` (never before 0): for a transcription that came early or late. */
export function shifted(words: LyricWord[], seconds: number): LyricWord[] {
  return words.map(w => ({ ...w, t: Math.max(0, w.t + seconds), e: Math.max(0.05, w.e + seconds) }));
}

const pad = (n: number, size = 2) => String(n).padStart(size, "0");
/** [mm:ss.xx], the time tag of an LRC file. */
export function lrcTime(seconds: number): string {
  const cs = Math.round(Math.max(0, seconds) * 100);
  return `${pad(Math.floor(cs / 6000))}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}

/**
 * The lyrics as an LRC file, which karaoke and music players read. With `perWord`, every word also carries its own
 * <mm:ss.xx> tag (the "enhanced" LRC format).
 */
export function toLrc(lines: LyricLine[], meta: { title?: string; artist?: string } = {}, perWord = false): string {
  const head = [meta.title && `[ti:${meta.title}]`, meta.artist && `[ar:${meta.artist}]`].filter(Boolean);
  const body = lines.map(line => `[${lrcTime(line.t)}]${perWord ? line.words.map(w => `<${lrcTime(w.t)}>${w.w}`).join(" ") : line.text}`);
  return [...head, ...body].join("\n") + "\n";
}
