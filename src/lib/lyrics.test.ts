import { describe, expect, it } from "vitest";
import { dtwPreset, groupLines, indexAt, lineAt, lrcTime, parseSpeech, parseWhisper, shifted, toLrc, wordFill, type LyricWord } from "@/lib/lyrics";

const entry = (from: number, to: number, text: string) => ({ offsets: { from, to }, text });
const word = (t: number, e: number, w: string): LyricWord => ({ t, e, w });

describe("parseWhisper", () => {
  it("reads one word per entry, in seconds", () => {
    const { language, words } = parseWhisper({ result: { language: "en" }, transcription: [entry(90, 250, " one"), entry(250, 790, " two,")] });
    expect(language).toBe("en");
    expect(words).toEqual([word(0.09, 0.25, "one"), word(0.25, 0.79, "two,")]);
  });

  it("joins a piece with no leading space to the word before it", () => {
    const { words } = parseWhisper({ transcription: [entry(0, 300, " don"), entry(300, 450, "'t"), entry(450, 600, ",")] });
    expect(words).toEqual([word(0, 0.6, "don't,")]);
  });

  it("drops empty entries and sound tags", () => {
    const { words } = parseWhisper({ transcription: [entry(0, 90, ""), entry(90, 400, " [MUSIC]"), entry(400, 600, " ♪"), entry(600, 700, " (applause)"), entry(700, 900, " yes")] });
    expect(words.map(w => w.w)).toEqual(["yes"]);
  });

  it("keeps times moving forward and every word at least a moment long", () => {
    const { words } = parseWhisper({ transcription: [entry(1000, 2000, " a"), entry(900, 900, " b")] });
    expect(words[1].t).toBeGreaterThanOrEqual(words[0].t);
    expect(words[1].e).toBeGreaterThan(words[1].t);
  });

  it("answers no words for a body that is not a transcription", () => {
    expect(parseWhisper(null).words).toEqual([]);
    expect(parseWhisper({}).language).toBe("");
  });

  // With -dtw, every token carries its start in centiseconds; special tokens ([_BEG_], [_TT_42]) have -1.
  const timed = (from: number, to: number, text: string, dtw: number) => ({ offsets: { from, to }, text, tokens: [{ text: "[_BEG_]", t_dtw: -1 }, { text, t_dtw: dtw }] });

  it("starts a word where DTW aligned it, not where Whisper's timestamps drifted", () => {
    // Whisper's guess stretches "look" over the 10 s intro; DTW puts it where it is sung.
    const { words } = parseWhisper({ transcription: [timed(0, 2400, " look", 990), timed(2400, 3600, " at", 1020)] });
    expect(words.map(w => w.t)).toEqual([9.9, 10.2]);
    expect(words[0].e).toBe(10.2);
  });

  it("ends a word where the next starts, but not across a pause", () => {
    const { words } = parseWhisper({ transcription: [timed(1000, 1400, " one", 100), timed(1400, 1800, " two", 140), timed(1800, 2200, " three", 900)] });
    expect(words[0].e).toBe(1.4);
    expect(words[1].e).toBeCloseTo(1.8);
  });

  it("moves a start left in a silence to where the singing comes back", () => {
    const speech: [number, number][] = [[1, 2], [5, 7]];
    const { words } = parseWhisper({ transcription: [timed(1000, 3000, " oh", 100), timed(3000, 5300, " so", 300), timed(5300, 5600, " you", 540)] }, speech);
    expect(words[1].t).toBe(5);
    // A word sung at the end of a stretch stops with it.
    expect(words[0].e).toBe(2);
  });

  it("leaves a start in a silence alone when the singing comes back after the next word", () => {
    const { words } = parseWhisper({ transcription: [timed(0, 500, " a", 300), timed(500, 900, " b", 400)] }, [[5, 6]]);
    // "a" stays, or it would land after "b"; "b", the last word, moves.
    expect(words.map(w => w.t)).toEqual([3, 5]);
  });

  it("drops the phrases Whisper makes up for silence, when they stand alone", () => {
    const { words } = parseWhisper({ transcription: [entry(1000, 1500, " hold"), entry(1500, 2000, " on"), entry(30000, 30500, " Thank"), entry(30500, 31000, " you.")] });
    expect(words.map(w => w.w)).toEqual(["hold", "on"]);
  });

  it("keeps such a phrase when it is sung inside a line", () => {
    const { words } = parseWhisper({ transcription: [entry(1000, 1500, " I"), entry(1500, 2000, " said"), entry(2000, 2500, " thank"), entry(2500, 3000, " you")] });
    expect(words.map(w => w.w)).toEqual(["I", "said", "thank", "you"]);
  });
});

describe("parseSpeech", () => {
  it("reads whisper-vad-speech-segments' centiseconds as seconds, in order", () => {
    const output = "Detected 2 speech segments:\nSpeech segment 1: start = 1350.00, end = 1486.00\nSpeech segment 0: start = 972.00, end = 1220.00\n";
    expect(parseSpeech(output)).toEqual([[9.72, 12.2], [13.5, 14.86]]);
    expect(parseSpeech("no speech")).toEqual([]);
  });
});

describe("dtwPreset", () => {
  it("names the alignment heads of a model file", () => {
    expect(dtwPreset("/x/.whisper/ggml-large-v3.bin")).toBe("large.v3");
    expect(dtwPreset("ggml-large-v3-turbo-q5_0.bin")).toBe("large.v3.turbo");
    expect(dtwPreset("ggml-small.en.bin")).toBe("small.en");
    expect(dtwPreset("my-finetune.bin")).toBeUndefined();
  });
});

describe("groupLines", () => {
  const run = (texts: string[], start = 0, step = 0.4) => texts.map((w, i) => word(start + i * step, start + i * step + 0.3, w));

  it("breaks after a pause", () => {
    const lines = groupLines([...run(["la", "la", "la"]), ...run(["na", "na"], 5)]);
    expect(lines.map(l => l.text)).toEqual(["la la la", "na na"]);
  });

  it("breaks after a sentence once the line has a few words", () => {
    const lines = groupLines(run(["so", "it", "goes.", "then", "it", "ends"]));
    expect(lines.map(l => l.text)).toEqual(["so it goes.", "then it ends"]);
  });

  it("does not leave a one-word line at a full stop", () => {
    const lines = groupLines(run(["no.", "I", "said"]));
    expect(lines).toHaveLength(1);
  });

  it("breaks a long run by its length", () => {
    const lines = groupLines(run(Array.from({ length: 20 }, () => "word")), { words: 6 });
    expect(lines).toHaveLength(4);
    expect(lines.every(l => l.words.length <= 6)).toBe(true);
  });

  it("gives each line its first start and last end", () => {
    const [line] = groupLines(run(["a", "b", "c"]));
    expect(line.t).toBe(0);
    expect(line.e).toBeCloseTo(1.1);
  });

  it("answers no lines for no words", () => {
    expect(groupLines([])).toEqual([]);
  });
});

describe("following the track", () => {
  it("finds the last start at or before a time", () => {
    const starts = [1, 3, 5];
    expect(indexAt(starts, 0)).toBe(-1);
    expect(indexAt(starts, 1)).toBe(0);
    expect(indexAt(starts, 4.9)).toBe(1);
    expect(indexAt(starts, 99)).toBe(2);
  });

  it("stays on the line just sung between two lines", () => {
    const lines = groupLines([word(1, 1.5, "a"), word(8, 8.5, "b")]);
    expect(lineAt(lines, 0.5)).toBe(-1);
    expect(lineAt(lines, 4)).toBe(0);
    expect(lineAt(lines, 8)).toBe(1);
  });

  it("fills a word as it is sung", () => {
    const w = word(2, 4, "x");
    expect(wordFill(w, 1)).toBe(0);
    expect(wordFill(w, 3)).toBe(0.5);
    expect(wordFill(w, 5)).toBe(1);
  });

  it("moves every time and never before zero", () => {
    expect(shifted([word(0.2, 0.5, "a"), word(1, 2, "b")], -0.5)).toEqual([word(0, 0.05, "a"), word(0.5, 1.5, "b")]);
  });
});

describe("LRC", () => {
  it("writes mm:ss.xx", () => {
    expect(lrcTime(0)).toBe("00:00.00");
    expect(lrcTime(75.5)).toBe("01:15.50");
    expect(lrcTime(3599.994)).toBe("59:59.99");
  });

  it("writes a tag per line, with the title and artist first", () => {
    const lines = groupLines([word(1, 1.4, "hi"), word(1.5, 2, "you"), word(9, 9.5, "bye")]);
    expect(toLrc(lines, { title: "Song", artist: "Me" })).toBe("[ti:Song]\n[ar:Me]\n[00:01.00]hi you\n[00:09.00]bye\n");
  });

  it("can tag every word", () => {
    const lines = groupLines([word(1, 1.4, "hi"), word(1.5, 2, "you")]);
    expect(toLrc(lines, {}, true)).toBe("[00:01.00]<00:01.00>hi <00:01.50>you\n");
  });
});
