import { CEILING } from "@/lib/audio-engine";
import { peak, renderMix, sine, stepRatio, toneLevel } from "@/lib/mix-render";

/* Checks that need a real browser: what its AudioParam automation does, whether playbackRate keeps pitch, how coarse and
   how steady an HTMLMediaElement's clock is. The automation checks are the same renders the unit tests run on
   node-web-audio-api; here they run on the browser's own engine, so a Chrome or Safari difference shows. The page at
   /diagnostics runs them. */

export type SelfTest = { name: string; pass: boolean; detail: string };
const result = (name: string, pass: boolean, detail: string): SelfTest => ({ name, pass, detail });

/** A mono 16-bit PCM WAV of a sine, as an object URL an <audio> element can play. */
function toneUrl(frequency: number, seconds: number, rate = 22050) {
  const x = sine(frequency, 0.5, seconds, rate);
  const view = new DataView(new ArrayBuffer(44 + x.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + x.length * 2, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) view.setInt16(44 + i * 2, Math.round(x[i] * 32767), true);
  return URL.createObjectURL(new Blob([view.buffer], { type: "audio/wav" }));
}

/** Automation on the browser's own OfflineAudioContext: a blend, a cancel in the middle of one, a tempo re-anchor. */
export async function automationTests(): Promise<SelfTest[]> {
  const Offline = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const rate = 22050, gain = 0.82 * 0.9, amp = 0.3, parts: [number, number][] = [[220, amp], [330, amp]];
  const plain = { volume: "smooth", eq: "none", effect: "none", stems: "none" } as const;
  const base = { sampleRate: rate, seconds: 20, a: sine(220, amp, 20, rate), b: sine(330, amp, 20, rate), plan: plain, start: 2, duration: 12 };
  const tests: SelfTest[] = [];

  const blend = await renderMix(Offline, base);
  const step = stepRatio(blend.out, rate, parts, gain);
  tests.push(result("blend: no step in the output", step < 1.05, `largest step ${step.toFixed(2)}x a sine's`));
  tests.push(result("blend: no clipping", peak(blend.out) <= CEILING, `peak ${peak(blend.out).toFixed(3)}, ceiling ${CEILING}`));
  const end = toneLevel(blend.out, rate, 330, 16, 19) / (amp * gain);
  tests.push(result("blend: ends on the incoming deck alone", Math.abs(end - 1) < 0.02 && toneLevel(blend.out, rate, 220, 16, 19) < 0.002, `incoming at ${(end * 100).toFixed(1)} %`));

  const cancelled = await renderMix(Offline, { ...base, seconds: 30, actions: [{ at: 7, run: h => h.session.cancel() }] });
  const back = toneLevel(cancelled.out, rate, 220, 24, 29) / (amp * gain), stray = toneLevel(cancelled.out, rate, 330, 24, 29);
  tests.push(result("cancel: no click, faders back, nothing left scheduled", stepRatio(cancelled.out, rate, parts, gain) < 1.15 && Math.abs(back - 1) < 0.02 && stray < 0.002,
    `step ${stepRatio(cancelled.out, rate, parts, gain).toFixed(2)}x, outgoing back at ${(back * 100).toFixed(1)} %, stray ${stray.toExponential(1)}`));

  const retimed = await renderMix(Offline, { ...base, actions: [{ at: 7, run: h => h.session.reanchor(h.session.remaining(7) / 1.25) }] });
  tests.push(result("tempo change: lanes re-anchor without a step", stepRatio(retimed.out, rate, parts, gain) < 1.15 && Math.abs(retimed.session.end - (7 + 7 / 1.25)) < 0.1,
    `step ${stepRatio(retimed.out, rate, parts, gain).toFixed(2)}x, ends at ${retimed.session.end.toFixed(2)} s`));
  return tests;
}

/** Frequency of a sine in a float buffer, by interpolated rising zero crossings. */
function frequencyOf(x: Float32Array, rate: number) {
  const crossings: number[] = [];
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  if (crossings.length < 8) return 0;
  return (crossings.length - 1) * rate / (crossings[crossings.length - 1] - crossings[0]);
}

/** Plays a 440 Hz tone at several playbackRates through the media-element path and reads its pitch back. Needs a user
    gesture to start the audio. */
export async function pitchTests(): Promise<SelfTest[]> {
  const ctx = new AudioContext();
  await ctx.resume();
  const media = new Audio(toneUrl(440, 12)); media.loop = true;
  const m = media as HTMLAudioElement & { webkitPreservesPitch?: boolean };
  m.preservesPitch = true; if ("webkitPreservesPitch" in m) m.webkitPreservesPitch = true;
  const analyser = ctx.createAnalyser(); analyser.fftSize = 32768;
  const silent = ctx.createGain(); silent.gain.value = 0;
  ctx.createMediaElementSource(media).connect(analyser); analyser.connect(silent); silent.connect(ctx.destination);
  const tests: SelfTest[] = [];
  try {
    await media.play();
    for (const rate of [1, 1.02, 1.06, 0.94, 1.0004]) {
      media.playbackRate = rate;
      await new Promise(r => setTimeout(r, 900));
      const buf = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(buf);
      const f = frequencyOf(buf, ctx.sampleRate), cents = f ? 1200 * Math.log2(f / 440) : NaN;
      tests.push(result(`pitch kept at playbackRate ${rate}`, Math.abs(cents) < 15, `${f.toFixed(1)} Hz, ${cents.toFixed(1)} cents from 440 Hz (preservesPitch=${String(m.preservesPitch)})`));
    }
  } catch (e) {
    tests.push(result("pitch test could not run", false, e instanceof Error ? e.message : String(e)));
  } finally {
    media.pause(); URL.revokeObjectURL(media.src); void ctx.close();
  }
  return tests;
}

/** How coarse and steady the media clock is, how fast a play() starts, and what the context clock looks like beside it. */
export async function clockTests(): Promise<SelfTest[]> {
  const ctx = new AudioContext();
  await ctx.resume();
  const media = new Audio(toneUrl(220, 12)); media.loop = true;
  const silent = ctx.createGain(); silent.gain.value = 0;
  ctx.createMediaElementSource(media).connect(silent); silent.connect(ctx.destination);
  const tests: SelfTest[] = [];
  try {
    const began = performance.now();
    await media.play();
    while (media.currentTime < 0.01 && performance.now() - began < 3000) await new Promise(r => setTimeout(r, 5));
    const latency = (performance.now() - began) / 1000;
    const media0 = media.currentTime, perf0 = performance.now(), steps = new Set<number>(), residual: number[] = [], ctxSteps = new Set<number>();
    let lastMedia = media0, lastCtx = ctx.currentTime;
    while (performance.now() - perf0 < 3000) {
      await new Promise(r => setTimeout(r, 4));
      const t = media.currentTime, p = performance.now(), c = ctx.currentTime;
      if (t !== lastMedia) steps.add(Math.round((t - lastMedia) * 1000));
      if (c !== lastCtx) ctxSteps.add(Math.round((c - lastCtx) * 1000));
      residual.push((t - media0) - (p - perf0) / 1000);
      lastMedia = t; lastCtx = c;
    }
    const mean = residual.reduce((s, v) => s + v, 0) / residual.length;
    const sd = Math.sqrt(residual.reduce((s, v) => s + (v - mean) ** 2, 0) / residual.length);
    const ext = ctx as AudioContext & { outputLatency?: number };
    tests.push(result("play() until the clock moves", latency < 1, `${(latency * 1000).toFixed(0)} ms`));
    tests.push(result("media clock jitter against the performance clock", sd < 0.02, `sd ${(sd * 1000).toFixed(1)} ms; currentTime steps seen (ms): ${[...steps].sort((a, b) => a - b).join(", ") || "none"}`));
    tests.push(result("context clock", true, `steps seen (ms): ${[...ctxSteps].sort((a, b) => a - b).join(", ") || "none"}; baseLatency ${((ctx.baseLatency ?? 0) * 1000).toFixed(1)} ms; outputLatency ${ext.outputLatency !== undefined ? (ext.outputLatency * 1000).toFixed(1) + " ms" : "not reported"}; ${ctx.sampleRate} Hz`));
  } catch (e) {
    tests.push(result("clock test could not run", false, e instanceof Error ? e.message : String(e)));
  } finally {
    media.pause(); URL.revokeObjectURL(media.src); void ctx.close();
  }
  return tests;
}

/** Two elements started together, one nudged by a small rate: do their media clocks run at the rates asked for? */
export async function driftTests(): Promise<SelfTest[]> {
  const ctx = new AudioContext();
  await ctx.resume();
  const url = toneUrl(220, 12);
  const a = new Audio(url), b = new Audio(url); a.loop = b.loop = true;
  const silent = ctx.createGain(); silent.gain.value = 0; silent.connect(ctx.destination);
  for (const el of [a, b]) ctx.createMediaElementSource(el).connect(silent);
  const tests: SelfTest[] = [];
  try {
    b.playbackRate = 1.003;
    await Promise.all([a.play(), b.play()]);
    await new Promise(r => setTimeout(r, 400));
    const a0 = a.currentTime, b0 = b.currentTime, p0 = performance.now();
    await new Promise(r => setTimeout(r, 6000));
    const dp = (performance.now() - p0) / 1000, ra = (a.currentTime - a0 + 12 * 0) / dp, rb = (b.currentTime - b0) / dp;
    tests.push(result("playbackRate 1 runs at 1", Math.abs(ra - 1) < 0.002, `measured ${ra.toFixed(5)}`));
    tests.push(result("playbackRate 1.003 runs at 1.003", Math.abs(rb - 1.003) < 0.002, `measured ${rb.toFixed(5)} (a trim of 0.3 % is ${(18).toFixed(0)} ms over 6 s)`));
  } catch (e) {
    tests.push(result("drift test could not run", false, e instanceof Error ? e.message : String(e)));
  } finally {
    a.pause(); b.pause(); URL.revokeObjectURL(url); void ctx.close();
  }
  return tests;
}
