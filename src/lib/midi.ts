/* MIDI for the studio: a reader for Standard MIDI Files (.mid), and the note and pedal messages a MIDI keyboard sends.
   A file is read into plain notes in seconds, with its tempo changes already applied, so the player only has to
   schedule them. Notes on channel 10, the General MIDI drum channel, come out as a separate drum part: a pitched
   sampler would play them as a melody of random notes, so they go to the drum kit instead. */

export type MidiNote = { midi: number; time: number; duration: number; velocity: number };
export type DrumHit = { note: number; time: number; velocity: number };
export type MidiSong = {
  name: string | null;
  notes: MidiNote[];
  /** Seconds from the start to the last note's end. */
  duration: number;
  /** The first tempo in the file, or 120 when it has none. */
  bpm: number;
  /** Channel 10, by General MIDI drum note. */
  drums: DrumHit[];
};

const DRUM_CHANNEL = 9;
type Event = { tick: number; order: number; kind: "on" | "off"; key: number; velocity: number } | { tick: number; order: number; kind: "tempo"; mpqn: number };

export function parseMidi(data: ArrayBuffer): MidiSong {
  const v = new DataView(data);
  let p = 0;
  const u8 = () => v.getUint8(p++);
  const u16 = () => { const x = v.getUint16(p); p += 2; return x; };
  const u32 = () => { const x = v.getUint32(p); p += 4; return x; };
  const text = (n: number) => { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(p + i)); p += n; return s; };
  const vlq = () => { let x = 0, b: number; do { b = u8(); x = (x << 7) | (b & 0x7f); } while (b & 0x80); return x; };

  if (data.byteLength < 14 || text(4) !== "MThd") throw new Error("This is not a MIDI file.");
  const headerLength = u32();
  u16(); // format: 0, 1 and 2 all read the same here, every track merged onto one timeline
  const trackCount = u16();
  const division = u16();
  p = 8 + headerLength;

  const events: Event[] = [];
  let name: string | null = null;
  let order = 0;
  for (let t = 0; t < trackCount && p + 8 <= data.byteLength; t++) {
    const id = text(4), length = u32(), end = Math.min(data.byteLength, p + length);
    if (id !== "MTrk") { p = end; continue; }
    let tick = 0, running = 0;
    // A damaged track keeps the events read before the break; the next track starts at its declared offset.
    try { while (p < end) {
      tick += vlq();
      let status = v.getUint8(p);
      if (status < 0x80) status = running; // running status: the data byte follows the last channel status
      else { p++; if (status < 0xf0) running = status; }
      if (status === 0xff) {
        const type = u8(), len = vlq();
        if (type === 0x51 && len === 3) events.push({ tick, order: order++, kind: "tempo", mpqn: (v.getUint8(p) << 16) | (v.getUint8(p + 1) << 8) | v.getUint8(p + 2) });
        if (type === 0x03 && !name && len) name = text(len).trim() || null; else p += len;
        if (type === 0x2f) break;
      } else if (status === 0xf0 || status === 0xf7) {
        p += vlq();
      } else {
        const type = status & 0xf0, channel = status & 0x0f;
        const d1 = u8(), d2 = type === 0xc0 || type === 0xd0 ? 0 : u8();
        const key = channel * 128 + d1;
        if (type === 0x90 && d2 > 0) events.push({ tick, order: order++, kind: "on", key, velocity: d2 / 127 });
        else if (type === 0x80 || type === 0x90) events.push({ tick, order: order++, kind: "off", key, velocity: 0 });
      }
    } } catch { /* keep what was read */ }
    p = end;
  }

  // Ticks to seconds. A note off sorts before a note on at the same tick, so a repeated note ends before it starts again.
  const rank = { tempo: 0, off: 1, on: 2 };
  events.sort((a, b) => a.tick - b.tick || rank[a.kind] - rank[b.kind] || a.order - b.order);
  const smpte = division & 0x8000;
  const ticksPerBeat = division & 0x7fff;
  const smpteRate = smpte ? -((division >> 8) << 24 >> 24) * (division & 0xff) : 0;
  let mpqn = 500000, lastTick = 0, lastSeconds = 0;
  let firstTempo: number | null = null;
  const seconds = (tick: number) => smpte ? tick / smpteRate : lastSeconds + (tick - lastTick) * mpqn / 1e6 / ticksPerBeat;

  const open = new Map<number, { time: number; velocity: number }[]>();
  const notes: MidiNote[] = [];
  const drums: DrumHit[] = [];
  for (const e of events) {
    const time = seconds(e.tick);
    if (e.kind === "tempo") {
      lastSeconds = time; lastTick = e.tick; mpqn = e.mpqn;
      if (firstTempo === null) firstTempo = e.mpqn;
      continue;
    }
    if (Math.floor(e.key / 128) === DRUM_CHANNEL) { if (e.kind === "on") drums.push({ note: e.key % 128, time, velocity: e.velocity }); continue; }
    const stack = open.get(e.key) ?? [];
    if (e.kind === "on") { stack.push({ time, velocity: e.velocity }); open.set(e.key, stack); continue; }
    const start = stack.shift();
    if (start) notes.push({ midi: e.key % 128, time: start.time, duration: Math.max(0.03, time - start.time), velocity: start.velocity });
  }
  // A note with no note off runs for a beat.
  open.forEach((stack, key) => stack.forEach(s => notes.push({ midi: key % 128, time: s.time, duration: 0.5, velocity: s.velocity })));
  notes.sort((a, b) => a.time - b.time);
  // Leading silence is cut, so play starts on the first note or hit.
  const offset = Math.min(notes[0]?.time ?? Infinity, drums[0]?.time ?? Infinity);
  if (Number.isFinite(offset)) { notes.forEach(n => { n.time -= offset; }); drums.forEach(d => { d.time -= offset; }); }
  const duration = Math.max(notes.reduce((max, n) => Math.max(max, n.time + n.duration), 0), drums.reduce((max, d) => Math.max(max, d.time + 0.3), 0));
  return { name, notes, duration, bpm: Math.round(60e6 / (firstTempo ?? 500000) * 10) / 10, drums };
}

/* A keyboard's messages, decoded. Note on with velocity 0 is a note off, as most keyboards send it. */
export type MidiMessage =
  | { type: "on"; note: number; velocity: number }
  | { type: "off"; note: number }
  | { type: "sustain"; down: boolean }
  | { type: "bend"; amount: number };
export function decodeMessage(data: Uint8Array): MidiMessage | null {
  const [status = 0, d1 = 0, d2 = 0] = data;
  const type = status & 0xf0;
  if (type === 0x90 && d2 > 0) return { type: "on", note: d1, velocity: d2 / 127 };
  if (type === 0x80 || type === 0x90) return { type: "off", note: d1 };
  if (type === 0xb0 && d1 === 64) return { type: "sustain", down: d2 >= 64 };
  if (type === 0xe0) return { type: "bend", amount: (((d2 << 7) | d1) - 8192) / 8192 };
  return null;
}
