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

/** whisper.cpp's JSON (-ojf with one word per entry): offsets in milliseconds. */
type WhisperEntry = { offsets?: { from?: number; to?: number }; text?: string };

/** Tags Whisper writes for sound that is not speech: [MUSIC], (applause), ♪, [_BEG_]. */
const NOISE = /^(?:[[(*♪♫].*[\])*♪♫]|[♪♫]+|\[_.*)$/;

/** Words from whisper.cpp's JSON output. A piece without a leading space continues the word before it (a comma, "n't"). */
export function parseWhisper(json: unknown): { language: string; words: LyricWord[] } {
  const body = (json ?? {}) as { result?: { language?: string }; transcription?: WhisperEntry[] };
  const words: LyricWord[] = [];
  for (const entry of body.transcription ?? []) {
    const raw = entry.text ?? "";
    const text = raw.trim();
    if (!text || NOISE.test(text)) continue;
    const from = (entry.offsets?.from ?? 0) / 1000, to = (entry.offsets?.to ?? 0) / 1000;
    const prev = words[words.length - 1];
    if (prev && !/^\s/.test(raw)) { prev.w += text; prev.e = Math.max(prev.e, to); continue; }
    words.push({ t: from, e: to, w: text });
  }
  // Times only move forward, and a word lasts at least a moment.
  let last = 0;
  for (const word of words) {
    word.t = Math.max(word.t, last);
    word.e = Math.max(word.e, word.t + 0.05);
    last = word.t;
  }
  return { language: body.result?.language ?? "", words };
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
