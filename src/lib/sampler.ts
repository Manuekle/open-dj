import type { DrumHit, MidiNote } from "@/lib/midi";
import { renderPatch, type Patch } from "@/lib/procedural/synth";

/* The studio's instrument: one sound played at any pitch from a piano, an effects chain on it, and a 16-step drum machine.
   A sound is an AudioBuffer recorded at a root note. Each key plays it back faster or slower by 2^(semitones / 12), the
   way a hardware sampler does, so pitch and length change together. Built-in tones are rendered offline into buffers at
   middle C, so a built-in tone and a dropped-in sample go through the same voice. Drums are synthesized per hit and
   scheduled ahead of time on the audio clock, so the beat stays steady while React renders. */

export const DRUMS = [
  { id: "kick", label: "Kick" },
  { id: "snare", label: "Snare" },
  { id: "clap", label: "Clap" },
  { id: "hat", label: "Closed hat" },
  { id: "open", label: "Open hat" },
  { id: "fx", label: "Sound fx" },
] as const;
export type DrumId = typeof DRUMS[number]["id"];
export const STEPS = 16;
export type Pattern = Record<DrumId, boolean[]>;

const row = (hits: number[]) => Array.from({ length: STEPS }, (_, i) => hits.includes(i));
export const PATTERNS: { id: string; label: string; bpm: number; pattern: Pattern }[] = [
  { id: "four", label: "Four on the floor", bpm: 124, pattern: {
    kick: row([0, 4, 8, 12]), snare: row([]), clap: row([4, 12]), hat: row([2, 6, 10, 14]), open: row([]), fx: row([]) } },
  { id: "house", label: "House", bpm: 122, pattern: {
    kick: row([0, 4, 8, 12]), snare: row([]), clap: row([4, 12]), hat: row([0, 2, 4, 6, 8, 10, 12, 14]), open: row([2, 6, 10, 14]), fx: row([]) } },
  { id: "break", label: "Breakbeat", bpm: 132, pattern: {
    kick: row([0, 6, 10]), snare: row([4, 12]), clap: row([]), hat: row([0, 2, 4, 6, 8, 10, 12, 14]), open: row([15]), fx: row([]) } },
  { id: "hiphop", label: "Hip hop", bpm: 90, pattern: {
    kick: row([0, 3, 8, 10]), snare: row([4, 12]), clap: row([]), hat: row([0, 2, 4, 6, 8, 10, 12, 14]), open: row([]), fx: row([]) } },
  { id: "reggaeton", label: "Dembow", bpm: 96, pattern: {
    kick: row([0, 4, 8, 12]), snare: row([3, 6, 11, 14]), clap: row([]), hat: row([0, 2, 4, 6, 8, 10, 12, 14]), open: row([]), fx: row([]) } },
];
export const emptyPattern = (): Pattern => ({ kick: row([]), snare: row([]), clap: row([]), hat: row([]), open: row([]), fx: row([]) });

export const TONES = [
  { id: "keys", label: "Electric piano" },
  { id: "pluck", label: "Pluck" },
  { id: "lead", label: "Saw lead" },
  { id: "bass", label: "Sub bass" },
  { id: "pad", label: "Pad" },
] as const;
export type ToneId = typeof TONES[number]["id"];

/** MIDI note 60, middle C: the note every built-in tone is rendered at. */
export const MIDDLE_C = 60;
const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
export const noteName = (midi: number) => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
export const isBlack = (midi: number) => [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export type SoundSettings = {
  /** Semitones added to every key, -24..24. */
  transpose: number;
  /** Cents of fine tune, -100..100. */
  fine: number;
  attack: number;
  release: number;
  /** Lowpass cutoff as 0..1 of the audible range. */
  cutoff: number;
  resonance: number;
  drive: number;
  delay: number;
  reverb: number;
  volume: number;
  /** Repeat the sample while the key is held. */
  loop: boolean;
};
export const DEFAULT_SOUND: SoundSettings = {
  transpose: 0, fine: 0, attack: 0.005, release: 0.35, cutoff: 1, resonance: 0.2, drive: 0, delay: 0, reverb: 0.15, volume: 0.8, loop: false,
};

type Voice = { source: AudioBufferSourceNode; gain: GainNode };

async function renderTone(tone: ToneId, sampleRate: number): Promise<AudioBuffer> {
  const seconds = tone === "pad" ? 4 : tone === "bass" ? 2 : 2.5;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const f = hz(MIDDLE_C);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const osc = (type: OscillatorType, freq: number, level: number, detune = 0, into: AudioNode = out) => {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = detune;
    const g = ctx.createGain(); g.gain.value = level; o.connect(g); g.connect(into); o.start(); return g;
  };
  const env = out.gain;
  if (tone === "keys") {
    // A tine and its bell partial, each fading at its own rate.
    osc("sine", f, 0.6); const bell = osc("sine", f * 4, 0.25); osc("triangle", f * 2, 0.08);
    bell.gain.setValueAtTime(0.25, 0); bell.gain.exponentialRampToValueAtTime(0.001, 0.6);
    env.setValueAtTime(0, 0); env.linearRampToValueAtTime(0.9, 0.004); env.exponentialRampToValueAtTime(0.25, 0.8); env.exponentialRampToValueAtTime(0.001, seconds);
  } else if (tone === "pluck") {
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 4; lp.connect(out);
    lp.frequency.setValueAtTime(f * 16, 0); lp.frequency.exponentialRampToValueAtTime(f * 1.5, 0.35);
    osc("sawtooth", f, 0.45, 0, lp); osc("square", f, 0.2, 7, lp);
    env.setValueAtTime(0, 0); env.linearRampToValueAtTime(0.9, 0.003); env.exponentialRampToValueAtTime(0.001, 1.4);
  } else if (tone === "lead") {
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = f * 10; lp.Q.value = 1; lp.connect(out);
    osc("sawtooth", f, 0.3, -9, lp); osc("sawtooth", f, 0.3, 9, lp); osc("square", f / 2, 0.12, 0, lp);
    env.setValueAtTime(0, 0); env.linearRampToValueAtTime(0.7, 0.01); env.setValueAtTime(0.7, seconds - 0.05); env.linearRampToValueAtTime(0, seconds);
  } else if (tone === "bass") {
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = f * 3; lp.connect(out);
    osc("sine", f / 2, 0.8, 0, lp); osc("triangle", f, 0.3, 0, lp);
    env.setValueAtTime(0, 0); env.linearRampToValueAtTime(0.95, 0.006); env.exponentialRampToValueAtTime(0.5, 0.4); env.linearRampToValueAtTime(0, seconds);
  } else {
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = f * 6; lp.connect(out);
    [-14, -5, 5, 14].forEach(d => osc("sawtooth", f, 0.14, d, lp)); osc("sine", f / 2, 0.2, 0, lp);
    env.setValueAtTime(0, 0); env.linearRampToValueAtTime(0.7, 0.6); env.setValueAtTime(0.7, seconds - 0.4); env.linearRampToValueAtTime(0, seconds);
  }
  return ctx.startRendering();
}

function impulse(ctx: BaseAudioContext, seconds = 2.4, decay = 3) {
  const length = Math.ceil(seconds * ctx.sampleRate);
  const ir = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = ir.getChannelData(c);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
  }
  return ir;
}
function driveCurve(amount: number) {
  const k = amount * 60, n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; curve[i] = k ? (1 + k) * x / (1 + k * Math.abs(x)) : x; }
  return curve;
}

export class Sampler {
  readonly context: AudioContext;
  private input: GainNode;
  private shaper: WaveShaperNode;
  private filter: BiquadFilterNode;
  private delayNode: DelayNode;
  private delaySend: GainNode;
  private feedback: GainNode;
  private reverbSend: GainNode;
  private out: GainNode;
  private drums: GainNode;
  private noise: AudioBuffer;
  private voices = new Map<number, Voice>();
  private toneCache = new Map<ToneId, AudioBuffer>();
  private buffer: AudioBuffer | null = null;
  private root = MIDDLE_C;
  private settings: SoundSettings = { ...DEFAULT_SOUND };
  // The sequencer: the next step to schedule, when it plays on the audio clock, and its timer.
  private timer: number | null = null;
  private nextStep = 0;
  private nextTime = 0;
  private bpm = 120;
  private pattern: Pattern = emptyPattern();
  private onStep: ((step: number) => void) | null = null;
  private stepTimers: number[] = [];
  /** Semitones of pitch bend from a keyboard's wheel. */
  private bendBy = 0;
  /** The sound effect the beat's fx row plays. */
  private fxPatch: Patch | null = null;
  // The note player: the song, when its current pass started on the audio clock, the next note to schedule, and the
  // sources and timers it made, so Stop can end them all.
  private song: { notes: MidiNote[]; drums: DrumHit[]; drumIndex: number; bus: GainNode; length: number; loop: boolean; start: number; index: number; timer: number;
    onNote: (midi: number, on: boolean) => void; onEnd: () => void } | null = null;
  private songSources = new Set<AudioBufferSourceNode>();
  private songTimers = new Set<number>();

  constructor(context: AudioContext, destination: AudioNode) {
    this.context = context;
    const ctx = context;
    this.input = ctx.createGain();
    this.shaper = ctx.createWaveShaper(); this.shaper.oversample = "2x";
    this.filter = ctx.createBiquadFilter(); this.filter.type = "lowpass";
    this.out = ctx.createGain();
    this.delayNode = ctx.createDelay(2); this.delaySend = ctx.createGain(); this.feedback = ctx.createGain();
    const reverb = ctx.createConvolver(); reverb.buffer = impulse(ctx); this.reverbSend = ctx.createGain();
    this.input.connect(this.shaper); this.shaper.connect(this.filter); this.filter.connect(this.out);
    this.filter.connect(this.delaySend); this.delaySend.connect(this.delayNode); this.delayNode.connect(this.feedback);
    this.feedback.connect(this.delayNode); this.delayNode.connect(this.out);
    this.filter.connect(this.reverbSend); this.reverbSend.connect(reverb); reverb.connect(this.out);
    this.out.connect(destination);
    this.drums = ctx.createGain(); this.drums.gain.value = 0.8; this.drums.connect(destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const n = this.noise.getChannelData(0); for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;
    this.apply(this.settings);
  }

  /** Loads a built-in tone, rendered once and kept. */
  async useTone(tone: ToneId) {
    let buffer = this.toneCache.get(tone);
    if (!buffer) { buffer = await renderTone(tone, this.context.sampleRate); this.toneCache.set(tone, buffer); }
    this.buffer = buffer; this.root = MIDDLE_C;
  }
  /** Decodes a file as the sound, recorded at the given root note. Throws when the browser cannot decode it. */
  async useFile(file: Blob, root = MIDDLE_C) {
    this.buffer = await this.context.decodeAudioData(await file.arrayBuffer());
    this.root = root;
    return this.buffer.duration;
  }
  setRoot(root: number) { this.root = root; }
  /** Puts an already rendered sound on the keys, such as a sound effect recipe. */
  useBuffer(buffer: AudioBuffer, root: number) { this.buffer = buffer; this.root = root; }

  /* Sound effects from recipes. They play through the same effects chain as the keys, so the filter, drive, delay,
     reverb and pitch knobs shape them too. Recipes are built as quiet interface sounds; the 3x brings them to the level
     of the keys. */
  setFx(patch: Patch | null) { this.fxPatch = patch; }
  playFx(patch: Patch | null = this.fxPatch, when = this.context.currentTime) {
    if (!patch) return;
    if (this.context.state !== "running") void this.context.resume();
    renderPatch(this.context, patch, this.input, when, { volume: 3, detune: (this.settings.transpose + this.settings.fine / 100) * 100 });
  }

  apply(settings: SoundSettings) {
    this.settings = settings;
    const t = this.context.currentTime, s = settings;
    this.shaper.curve = driveCurve(s.drive);
    this.filter.frequency.setTargetAtTime(80 * (20000 / 80) ** s.cutoff, t, 0.02);
    this.filter.Q.setTargetAtTime(0.5 + s.resonance * 14, t, 0.02);
    this.delaySend.gain.setTargetAtTime(s.delay * 0.7, t, 0.02);
    this.feedback.gain.setTargetAtTime(s.delay * 0.55, t, 0.02);
    this.delayNode.delayTime.setTargetAtTime(Math.min(1.5, 60 / this.bpm * 0.75), t, 0.05); // a dotted eighth
    this.reverbSend.gain.setTargetAtTime(s.reverb * 0.9, t, 0.02);
    // Drive adds level; the input trims it back so turning drive changes color, not loudness.
    this.input.gain.setTargetAtTime(1 / (1 + s.drive * 2), t, 0.02);
    this.out.gain.setTargetAtTime(s.volume, t, 0.02);
    // Retune held notes so a pitch knob bends what is sounding.
    this.voices.forEach((v, midi) => v.source.playbackRate.setTargetAtTime(this.rate(midi), t, 0.02));
  }

  private rate(midi: number) { return 2 ** ((midi + this.settings.transpose + this.settings.fine / 100 + this.bendBy - this.root) / 12); }

  /** Bends held notes by -1..1 of the range, two semitones each way as most keyboards expect. */
  bend(amount: number) {
    this.bendBy = amount * 2;
    const t = this.context.currentTime;
    this.voices.forEach((v, midi) => v.source.playbackRate.setTargetAtTime(this.rate(midi), t, 0.005));
  }

  noteOn(midi: number, velocity = 0.9) {
    if (!this.buffer) return;
    if (this.context.state !== "running") void this.context.resume();
    this.noteOff(midi, 0.01);
    const t = this.context.currentTime, s = this.settings;
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.rate(midi);
    source.loop = s.loop;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(velocity, t + Math.max(0.002, s.attack));
    source.connect(gain); gain.connect(this.input);
    source.start(t);
    source.onended = () => { if (this.voices.get(midi)?.source === source) this.voices.delete(midi); gain.disconnect(); };
    this.voices.set(midi, { source, gain });
  }
  noteOff(midi: number, release = this.settings.release) {
    const v = this.voices.get(midi);
    if (!v) return;
    this.voices.delete(midi);
    const t = this.context.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.linearRampToValueAtTime(0, t + Math.max(0.01, release));
    v.source.stop(t + Math.max(0.01, release) + 0.02);
  }
  allOff() { [...this.voices.keys()].forEach(m => this.noteOff(m, 0.05)); }

  /** Plays one note at a set time on the audio clock, for the song player. Notes may overlap, even on one key. */
  private schedule(n: MidiNote, when: number) {
    if (!this.buffer) return;
    const s = this.settings, ctx = this.context;
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.rate(n.midi);
    source.loop = s.loop;
    const gain = ctx.createGain();
    const peak = 0.25 + n.velocity * 0.75, attack = Math.max(0.002, s.attack), release = Math.max(0.01, s.release);
    const end = when + Math.max(n.duration, attack);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(peak, when + attack);
    gain.gain.setValueAtTime(peak, end);
    gain.gain.linearRampToValueAtTime(0, end + release);
    source.connect(gain); gain.connect(this.input);
    source.start(when); source.stop(end + release + 0.02);
    this.songSources.add(source);
    source.onended = () => { this.songSources.delete(source); gain.disconnect(); };
    const on = window.setTimeout(() => { this.songTimers.delete(on); this.song?.onNote(n.midi, true); }, Math.max(0, (when - ctx.currentTime) * 1000));
    const off = window.setTimeout(() => { this.songTimers.delete(off); this.song?.onNote(n.midi, false); }, Math.max(0, (end - ctx.currentTime) * 1000));
    this.songTimers.add(on); this.songTimers.add(off);
  }

  get songPlaying() { return this.song !== null; }
  /** Seconds into the song, or null when none plays. */
  get songPosition() { return this.song ? Math.max(0, this.context.currentTime - this.song.start) : null; }

  /** Plays a song's notes through this sound, scheduled a little ahead like the drums. */
  playSong(notes: MidiNote[], drums: DrumHit[], length: number, options: { loop: boolean; onNote: (midi: number, on: boolean) => void; onEnd: () => void }) {
    this.stopSong();
    if ((!notes.length && !drums.length) || !this.buffer) return;
    if (this.context.state !== "running") void this.context.resume();
    // The song's drums share one bus into the kit, so Stop can silence hits already scheduled.
    const bus = this.context.createGain(); bus.connect(this.drums);
    const song = { notes, drums, drumIndex: 0, bus, length: Math.max(length, 0.1), loop: options.loop, start: this.context.currentTime + 0.08, index: 0, timer: 0, onNote: options.onNote, onEnd: options.onEnd };
    const tick = () => {
      // Two seconds ahead: a browser slows timers in a background tab to about one a second, and a shorter window would
      // leave gaps there. Stop still ends everything at once, since every source scheduled is kept.
      const horizon = this.context.currentTime + 2;
      while (song.index < song.notes.length && song.start + song.notes[song.index].time < horizon) {
        const n = song.notes[song.index++];
        this.schedule(n, song.start + n.time);
      }
      while (song.drumIndex < song.drums.length && song.start + song.drums[song.drumIndex].time < horizon) {
        const d = song.drums[song.drumIndex++];
        this.hitGeneral(d.note, song.start + d.time, d.velocity, song.bus);
      }
      if (song.index < song.notes.length || song.drumIndex < song.drums.length) return;
      if (song.loop) { song.start += song.length; song.index = 0; song.drumIndex = 0; return; }
      if (this.context.currentTime > song.start + song.length + this.settings.release) { const end = song.onEnd; this.stopSong(); end(); }
    };
    this.song = song;
    tick();
    song.timer = window.setInterval(tick, 25);
  }
  setSongLoop(loop: boolean) { if (this.song) this.song.loop = loop; }
  stopSong() {
    const song = this.song;
    if (!song) return;
    window.clearInterval(song.timer);
    this.songTimers.forEach(id => window.clearTimeout(id)); this.songTimers.clear();
    const t = this.context.currentTime;
    this.songSources.forEach(src => { try { src.stop(t + 0.03); } catch { /* already stopped */ } });
    this.songSources.clear();
    song.bus.gain.setTargetAtTime(0, t, 0.01);
    window.setTimeout(() => song.bus.disconnect(), 100);
    this.song = null;
    new Set(song.notes.map(n => n.midi)).forEach(m => song.onNote(m, false));
  }

  /* Drums. Each hit is a few nodes built for that hit and dropped when it ends. */
  hit(drum: DrumId, when = this.context.currentTime) {
    if (this.context.state !== "running") void this.context.resume();
    const ctx = this.context, t = when;
    const env = (node: AudioNode, peak: number, decay: number) => {
      const g = ctx.createGain(); g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.001, t + decay);
      node.connect(g); g.connect(this.drums); return g;
    };
    const noise = (filter: BiquadFilterType, freq: number, peak: number, decay: number) => {
      const src = ctx.createBufferSource(); src.buffer = this.noise;
      const f = ctx.createBiquadFilter(); f.type = filter; f.frequency.value = freq;
      src.connect(f); env(f, peak, decay); src.start(t); src.stop(t + decay + 0.05);
    };
    if (drum === "kick") {
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      env(o, 1, 0.45); o.start(t); o.stop(t + 0.5);
    } else if (drum === "snare") {
      const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(160, t + 0.1);
      env(o, 0.5, 0.12); o.start(t); o.stop(t + 0.15);
      noise("highpass", 1500, 0.6, 0.2);
    } else if (drum === "clap") {
      // Three quick bursts and a tail, the way hands never land at once.
      [0, 0.012, 0.024].forEach(d => {
        const src = ctx.createBufferSource(); src.buffer = this.noise;
        const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1200; f.Q.value = 0.8;
        const g = ctx.createGain(); g.gain.setValueAtTime(0.7, t + d); g.gain.exponentialRampToValueAtTime(0.001, t + d + (d === 0.024 ? 0.22 : 0.03));
        src.connect(f); f.connect(g); g.connect(this.drums); src.start(t + d); src.stop(t + d + 0.3);
      });
    } else if (drum === "hat") {
      noise("highpass", 7000, 0.35, 0.05);
    } else if (drum === "fx") {
      this.playFx(this.fxPatch, t);
    } else {
      noise("highpass", 6500, 0.3, 0.3);
    }
  }

  /** A General MIDI drum note on the kit: kicks, snares, claps and hats map to the drum machine's sounds, toms and
      cymbals get their own. Notes the kit has nothing for fall back to a closed hat, so the groove keeps its pulse. */
  private hitGeneral(note: number, when: number, velocity: number, bus: AudioNode) {
    const ctx = this.context, t = when, level = 0.3 + velocity * 0.7;
    const out = ctx.createGain(); out.gain.value = level; out.connect(bus);
    const into = (fn: () => void) => { const keep = this.drums; this.drums = out; try { fn(); } finally { this.drums = keep; } };
    if (note === 35 || note === 36) into(() => this.hit("kick", t));
    else if (note === 38 || note === 40 || note === 37) into(() => this.hit("snare", t));
    else if (note === 39) into(() => this.hit("clap", t));
    else if (note === 46) into(() => this.hit("open", t));
    else if ([41, 43, 45, 47, 48, 50].includes(note)) {
      // Toms: a pitched body that falls, low tom 41 to high tom 50.
      const o = ctx.createOscillator(), g = ctx.createGain(), f = 80 + (note - 41) * 18;
      o.frequency.setValueAtTime(f * 1.6, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.15);
      g.gain.setValueAtTime(0.8, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.45);
    } else if ([49, 52, 55, 57, 51, 53, 59].includes(note)) {
      // Crash and ride: bright noise, long for a crash, short and quiet for a ride.
      const ride = [51, 53, 59].includes(note), decay = ride ? 0.35 : 1.4;
      const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = ride ? 8000 : 5000;
      const g = ctx.createGain(); g.gain.setValueAtTime(ride ? 0.18 : 0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t + decay);
      src.connect(f); f.connect(g); g.connect(out); src.start(t); src.stop(t + decay + 0.05);
    } else into(() => this.hit("hat", t));
  }

  setDrumVolume(v: number) { this.drums.gain.setTargetAtTime(v, this.context.currentTime, 0.02); }
  setPattern(pattern: Pattern) { this.pattern = pattern; }
  setBpm(bpm: number) { this.bpm = bpm; this.apply(this.settings); }
  /** Where the bars of something else fall on this clock, so the beat plays on them: the tempo it runs at and the
      context time of one of its bar starts. Null, or a function that answers null, leaves the beat on its own tempo. */
  private lock: (() => { bpm: number; barStart: number } | null) | null = null;
  setLock(lock: (() => { bpm: number; barStart: number } | null) | null) { this.lock = lock; }
  get playing() { return this.timer !== null; }

  start(onStep: (step: number) => void) {
    if (this.timer !== null) return;
    if (this.context.state !== "running") void this.context.resume();
    this.onStep = onStep;
    this.nextStep = 0;
    this.nextTime = this.context.currentTime + 0.06;
    const tick = () => {
      // Schedule every step that starts in the next 120 ms; the timer runs every 25 ms, so one late frame never drops a hit.
      const grid = this.lock?.() ?? null;
      if (grid && grid.bpm > 0) {
        // Locked: each step lands on the other clock's sixteenth, its first step on that clock's bar start.
        this.bpm = grid.bpm;
        const len = 60 / grid.bpm / 4;
        let n = Math.round((this.nextTime - grid.barStart) / len);
        if (grid.barStart + n * len < this.context.currentTime + 0.005) n++;
        this.nextTime = grid.barStart + n * len;
        this.nextStep = ((n % STEPS) + STEPS) % STEPS;
      }
      while (this.nextTime < this.context.currentTime + 0.12) {
        const step = this.nextStep, when = this.nextTime;
        DRUMS.forEach(d => { if (this.pattern[d.id]?.[step]) this.hit(d.id, when); });
        const delay = Math.max(0, (when - this.context.currentTime) * 1000);
        this.stepTimers.push(window.setTimeout(() => this.onStep?.(step), delay));
        this.nextTime += 60 / this.bpm / 4;
        this.nextStep = (step + 1) % STEPS;
      }
      if (this.stepTimers.length > 64) this.stepTimers = this.stepTimers.slice(-16);
    };
    tick();
    this.timer = window.setInterval(tick, 25);
  }
  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.stepTimers.forEach(id => window.clearTimeout(id)); this.stepTimers = [];
    this.onStep?.(-1); this.onStep = null;
  }

  destroy() {
    this.stop(); this.stopSong(); this.allOff();
    this.out.disconnect(); this.drums.disconnect();
  }
}
