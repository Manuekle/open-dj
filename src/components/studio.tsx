"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/sodium/utils";
import type { DJ } from "@/hooks/use-dj";
import { decodeMessage, parseMidi, type MidiSong } from "@/lib/midi";
import { DEFAULT_SOUND, DRUMS, MIDDLE_C, PATTERNS, STEPS, Sampler, TONES, emptyPattern, isBlack, noteName, type DrumId, type Pattern, type SoundSettings, type ToneId } from "@/lib/sampler";
import { Knob } from "@/components/console";
import { Hint } from "@/components/hint";
import { TextSwap } from "@/components/motion";
import { Frame, FrameActions, FrameBody, FrameHeader, FrameStatus, FrameTitle, FrameValue } from "@/components/sodium/ui/frame";
import { Button } from "@/components/sodium/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/sodium/ui/button-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/sodium/ui/segmented-control";
import { Pick } from "@/components/pick";
import { Switch } from "@/components/sodium/ui/switch";
import { Field, FieldLabel } from "@/components/sodium/ui/field";
import { Status } from "@/components/sodium/ui/status";
import { Kbd } from "@/components/sodium/ui/kbd";
import { Input } from "@/components/sodium/ui/input";
import { toast } from "@/components/sodium/ui/toast";
import { Add, Icon, Pause, Play, Subtract, TrashCan, Upload } from "@/components/sodium/icon";
import { formatTime } from "@/lib/types";
import { FX_CATEGORIES, FX_LIBRARY, type FxCategory } from "@/lib/procedural/library";
import { patchBuffer, patchRoot } from "@/lib/procedural/synth";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const semis = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v)} st`;
const cents = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v)} ct`;
const ms = (v: number) => v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
const SAMPLE = "sample";
const FX = "fx";
const MIDI_FILE = /\.(mid|midi|smf)$/i;
/** Two octaves and the C above, from the chosen octave's C. */
const SPAN = 25;
/** Computer keys over the piano: the home row plays white keys, the row above plays black keys, as on most DAWs. */
const KEYMAP = ["a", "w", "s", "e", "d", "f", "t", "g", "y", "h", "u", "j", "k", "o", "l", "p", ";", "'"];
const ROOTS = Array.from({ length: 49 }, (_, i) => 36 + i).map(m => ({ value: String(m), label: noteName(m) }));
// Keys go to the field or menu that has focus, never to the piano.
const OWNS_KEYS = "textarea, select, [contenteditable]:not([contenteditable=false]), input:not([type=range], [type=checkbox], [type=radio], [type=button]), [role=dialog], [role=alertdialog], [role=listbox], [role=menu], [role=combobox], [role=slider]";

/* Sodium has no piano. This one is drawn from its tokens as a row of square keys under 1px rules. The app is pinned to
   the dark theme, so white keys take text-1 and black keys the page; a held key goes a step darker. Each key is a
   role=button, so Tab reaches it and Space or Enter holds it down. */
function Piano({ from, held, keyLabels, onDown, onUp }: {
  from: number; held: Set<number>; keyLabels: Map<number, string> | null;
  onDown: (midi: number) => void; onUp: (midi: number) => void;
}) {
  const notes = Array.from({ length: SPAN }, (_, i) => from + i);
  const whites = notes.filter(n => !isBlack(n));
  const width = 100 / whites.length;
  const dragging = useRef(false);
  const key = (midi: number, black: boolean, style?: React.CSSProperties) => {
    const down = held.has(midi);
    const label = keyLabels?.get(midi);
    return <div key={midi} role="button" tabIndex={0} aria-label={noteName(midi)} aria-pressed={down} style={style} draggable={false}
      className={cn("flex cursor-pointer touch-none select-none flex-col items-center justify-end gap-1.5 pb-2",
        black ? "absolute top-0 z-(--z-raised) h-3/5 border-x border-b border-line bg-page text-text-2" : "h-full flex-1 border-e border-line bg-text-1 text-text-inverse last:border-e-0",
        // Solid fills only: a translucent wash on a black key shows the white keys through it.
        down && "bg-text-3 text-text-inverse")}
      onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.releasePointerCapture(e.pointerId); dragging.current = true; onDown(midi); }}
      onPointerUp={() => { dragging.current = false; onUp(midi); }}
      onPointerEnter={() => { if (dragging.current) onDown(midi); }}
      onPointerLeave={() => { if (held.has(midi)) onUp(midi); }}
      onKeyDown={e => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); onDown(midi); } }}
      onKeyUp={e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); onUp(midi); } }}
      onBlur={() => { if (held.has(midi)) onUp(midi); }}>
      {/* The computer key in a box, so it never reads as the note's name; the note name sits under it on white keys. */}
      {label && <span className="flex size-5 items-center justify-center border border-current type-micro" aria-hidden>{label}</span>}
      {!black && <span className={cn("type-micro", midi % 12 !== 0 && !down && "text-text-3")} aria-hidden>
        {midi % 12 === 0 ? noteName(midi) : noteName(midi).replace(/-?\d+$/, "")}
      </span>}
    </div>;
  };
  return <div className="overflow-x-auto" onPointerUp={() => { dragging.current = false; }} onPointerLeave={() => { dragging.current = false; }}>
    <div role="group" aria-label={`Piano, ${noteName(from)} to ${noteName(from + SPAN - 1)}`} className="relative flex h-40 min-w-xl border-b border-line">
      {whites.map(n => key(n, false))}
      {notes.filter(isBlack).map(n => {
        const left = whites.filter(w => w < n).length * width;
        return key(n, true, { left: `${left - width * 0.3}%`, width: `${width * 0.6}%` });
      })}
    </div>
  </div>;
}

export function Studio({ dj }: { dj: DJ }) {
  const sampler = useRef<Sampler | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [tone, setTone] = useState<ToneId | typeof SAMPLE | typeof FX>("keys");
  // The sound effect pads: which aisle of the library is shown, the pad chosen, and the one put on the keys, if any.
  const [fxCategory, setFxCategory] = useState<FxCategory>("success");
  const [fxIndex, setFxIndex] = useState(0);
  const [fxOnKeys, setFxOnKeys] = useState<{ category: FxCategory; index: number } | null>(null);
  const [sample, setSample] = useState<{ name: string; seconds: number } | null>(null);
  const [root, setRoot] = useState(MIDDLE_C);
  const [octave, setOctave] = useState(4);
  const [sound, setSound] = useState<SoundSettings>(DEFAULT_SOUND);
  const [held, setHeld] = useState<Set<number>>(new Set());
  const [typing, setTyping] = useState(false);
  const [pattern, setPattern] = useState<Pattern>(PATTERNS[0].pattern);
  const [preset, setPreset] = useState(PATTERNS[0].id);
  const [bpm, setBpm] = useState(PATTERNS[0].bpm);
  const [drumVolume, setDrumVolume] = useState(0.8);
  const [beating, setBeating] = useState(false);
  /** The beat follows the live deck: its tempo, and its steps on the deck's bars. */
  const [locked, setLocked] = useState(false);
  const [step, setStep] = useState(-1);
  // MIDI: the keyboards found (null until connected), and an imported song with the keys it is holding down.
  const [keyboards, setKeyboards] = useState<string[] | null>(null);
  const [song, setSong] = useState<{ title: string; data: MidiSong } | null>(null);
  const [songPlaying, setSongPlaying] = useState(false);
  const [songLoop, setSongLoop] = useState(false);
  const [songHeld, setSongHeld] = useState<Set<number>>(new Set());
  const [songAt, setSongAt] = useState(0);
  const midiInput = useRef<HTMLInputElement>(null);
  const midiAccess = useRef<MIDIAccess | null>(null);
  const from = (octave + 1) * 12;
  const latest = useRef({ tone, root, sound, pattern, bpm, drumVolume, from, fxCategory, fxIndex });
  const lockRef = useRef(false);
  useEffect(() => { lockRef.current = locked; }, [locked]);
  useEffect(() => { latest.current = { tone, root, sound, pattern, bpm, drumVolume, from, fxCategory, fxIndex }; });

  // The live deck's bar grid on the audio clock: its tempo as heard and the context time of its last bar start. The media
  // clock is read every scheduler tick, so a tempo change, a seek or a mix into the other deck carries the beat with it.
  const djRef = useRef(dj);
  useEffect(() => { djRef.current = dj; });
  const deckGrid = useCallback(() => {
    const d = djRef.current, out = d.output();
    const id = d.live, track = d.liveTrack, deck = d.decks[id];
    if (!out || !track?.bpm || !deck.playing) return null;
    const bpm = track.bpm * (deck.rate || 1), beat = 60 / track.bpm;
    const beats = (d.mediaTime(id) - (track.firstBeat ?? 0)) / beat;
    const intoBar = ((beats % 4) + 4) % 4;
    return { bpm, barStart: out.context.currentTime - intoBar * 60 / bpm };
  }, []);
  /* The sampler lives on the DJ engine's clock and plays into its master, so the record button takes it too. It is made
     on first use, and again if the engine was rebuilt. */
  const ensure = useCallback(async () => {
    const out = dj.output();
    if (!out) return null;
    if (!sampler.current || sampler.current.context !== out.context) {
      sampler.current?.destroy();
      const s = new Sampler(out.context, out.master);
      const l = latest.current;
      s.apply(l.sound); s.setPattern({ ...emptyPattern(), ...l.pattern }); s.setBpm(l.bpm); s.setDrumVolume(l.drumVolume);
      await s.useTone(l.tone === SAMPLE || l.tone === FX ? "keys" : l.tone);
      s.setFx(FX_LIBRARY[l.fxCategory][l.fxIndex]);
      s.setLock(lockRef.current ? deckGrid : null);
      sampler.current = s;
    }
    return sampler.current;
  }, [dj, deckGrid]);

  useEffect(() => { sampler.current?.apply(sound); }, [sound]);
  useEffect(() => { sampler.current?.setPattern(pattern); }, [pattern]);
  useEffect(() => { sampler.current?.setBpm(bpm); }, [bpm]);
  useEffect(() => { sampler.current?.setDrumVolume(drumVolume); }, [drumVolume]);
  useEffect(() => { sampler.current?.setLock(locked ? deckGrid : null); }, [locked, deckGrid]);
  useEffect(() => () => { sampler.current?.destroy(); sampler.current = null; }, []);

  const heldRef = useRef(new Set<number>());
  const down = useCallback(async (midi: number, velocity = 0.9) => {
    if (heldRef.current.has(midi)) return;
    heldRef.current.add(midi); setHeld(new Set(heldRef.current));
    const s = await ensure();
    if (!s) return;
    s.noteOn(midi, velocity);
    if (!heldRef.current.has(midi)) s.noteOff(midi); // let go while the first sound was still loading
  }, [ensure]);
  const up = useCallback((midi: number) => {
    if (!heldRef.current.delete(midi)) return;
    setHeld(new Set(heldRef.current));
    sampler.current?.noteOff(midi);
  }, []);

  /* Computer keys, once switched on. They listen first and claim the key, so the DJ shortcuts under them stay quiet. */
  useEffect(() => {
    if (!typing) return;
    const map = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return null;
      if (e.target instanceof Element && e.target.closest(OWNS_KEYS)) return null;
      return e.key.toLowerCase();
    };
    const onDown = (e: KeyboardEvent) => {
      const k = map(e); if (k === null) return;
      if (k === "z" || k === "x") { e.preventDefault(); if (!e.repeat) setOctave(o => Math.max(1, Math.min(6, o + (k === "z" ? -1 : 1)))); return; }
      const i = KEYMAP.indexOf(k); if (i < 0) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) void down(latest.current.from + i);
    };
    const onUp = (e: KeyboardEvent) => {
      const k = map(e); if (k === null) return;
      const i = KEYMAP.indexOf(k); if (i < 0) return;
      up(latest.current.from + i);
    };
    const release = () => heldRef.current.forEach(up);
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", release);
    return () => { window.removeEventListener("keydown", onDown, true); window.removeEventListener("keyup", onUp, true); window.removeEventListener("blur", release); release(); };
  }, [typing, down, up]);
  // Moving the octave mid-chord would strand the held notes on keys no longer under the fingers.
  useEffect(() => { heldRef.current.forEach(up); }, [octave, up]);

  /* A MIDI keyboard. Every input the browser sees plays the piano, with its velocity, sustain pedal and pitch wheel. A key
     let go under the pedal keeps sounding until the pedal comes up. */
  const pedal = useRef({ down: false, sustained: new Set<number>() });
  const latestKeys = useRef({ down, up });
  useEffect(() => { latestKeys.current = { down, up }; });
  const listen = useCallback((access: MIDIAccess) => {
    const onMessage = (e: MIDIMessageEvent) => {
      const m = e.data ? decodeMessage(e.data) : null;
      if (!m) return;
      const { down, up } = latestKeys.current, p = pedal.current;
      if (m.type === "on") { if (p.sustained.delete(m.note)) up(m.note); void down(m.note, 0.15 + m.velocity * 0.85); }
      else if (m.type === "off") { if (p.down) p.sustained.add(m.note); else up(m.note); }
      else if (m.type === "sustain") { p.down = m.down; if (!m.down) { p.sustained.forEach(up); p.sustained.clear(); } }
      else sampler.current?.bend(m.amount);
    };
    const refresh = () => {
      const names: string[] = [];
      access.inputs.forEach(input => { input.onmidimessage = onMessage; if (input.state === "connected") names.push(input.name ?? "MIDI keyboard"); });
      setKeyboards(names);
    };
    access.onstatechange = refresh;
    refresh();
  }, []);
  useEffect(() => () => {
    const access = midiAccess.current;
    if (!access) return;
    access.onstatechange = null;
    access.inputs.forEach(input => { input.onmidimessage = null; });
  }, []);
  async function connectKeyboard() {
    if (!navigator.requestMIDIAccess) { toast.fail("This browser has no MIDI support. Use Chrome, Edge or Firefox."); return; }
    try {
      const access = await navigator.requestMIDIAccess();
      midiAccess.current = access;
      listen(access);
      await ensure();
    } catch { toast.fail("MIDI access was refused. Allow it in the site settings and try again."); }
  }

  /* An imported .mid file plays through the chosen sound and effects, its keys lighting on the piano. */
  async function importMidi(file: File | undefined) {
    if (!file) return;
    try {
      const data = parseMidi(await file.arrayBuffer());
      if (!data.notes.length && !data.drums.length) { toast.fail(`${file.name} has no notes to play.`); return; }
      stopSong();
      setSong({ title: file.name.replace(/(\.(mid|midi|smf))+$/i, "") || data.name || "Untitled", data });
      // Show the octaves the song lives in.
      const sorted = data.notes.map(n => n.midi).sort((a, b) => a - b);
      if (sorted.length) setOctave(Math.max(1, Math.min(6, Math.floor(sorted[Math.floor(sorted.length / 2)] / 12) - 1)));
      toast(`${file.name}: ${data.notes.length} notes${data.drums.length ? ` and ${data.drums.length} drum hits on the kit` : ""}, ${formatTime(data.duration)}.`);
    } catch (e) { toast.fail(e instanceof Error && e.message.startsWith("This") ? e.message : `${file.name} could not be read as MIDI.`); }
  }
  const songHeldRef = useRef(new Set<number>());
  const onSongNote = useCallback((midi: number, on: boolean) => {
    if (on) songHeldRef.current.add(midi); else songHeldRef.current.delete(midi);
    setSongHeld(new Set(songHeldRef.current));
  }, []);
  function stopSong() { sampler.current?.stopSong(); setSongPlaying(false); setSongAt(0); }
  async function toggleSong() {
    if (songPlaying) { stopSong(); return; }
    const s = await ensure();
    if (!s || !song) return;
    s.playSong(song.data.notes, song.data.drums, song.data.duration, { loop: songLoop, onNote: onSongNote, onEnd: () => { setSongPlaying(false); setSongAt(0); } });
    setSongPlaying(true);
  }
  useEffect(() => { sampler.current?.setSongLoop(songLoop); }, [songLoop]);
  useEffect(() => {
    if (!songPlaying) return;
    const id = window.setInterval(() => {
      const at = sampler.current?.songPosition;
      if (at != null && song) setSongAt(at % song.data.duration);
    }, 250);
    return () => window.clearInterval(id);
  }, [songPlaying, song]);

  /* Pads: a press plays the recipe through the knobs and makes it the beat's fx row sound. */
  useEffect(() => { sampler.current?.setFx(FX_LIBRARY[fxCategory][fxIndex]); }, [fxCategory, fxIndex]);
  async function playPad(index: number) {
    setFxIndex(index);
    const s = await ensure();
    const patch = FX_LIBRARY[fxCategory][index];
    s?.setFx(patch); s?.playFx(patch);
  }
  async function fxToKeys(category = fxCategory, index = fxIndex) {
    const s = await ensure();
    if (!s) return;
    const patch = FX_LIBRARY[category][index];
    s.useBuffer(await patchBuffer(patch, s.context.sampleRate), patchRoot(patch));
    setFxOnKeys({ category, index }); setTone(FX);
  }
  const fxLabel = (c: FxCategory, i: number) => `${FX_CATEGORIES.find(x => x.id === c)?.label} ${i + 1}`;

  async function chooseTone(next: string) {
    if (next === SAMPLE) { if (sample) setTone(SAMPLE); else fileInput.current?.click(); return; }
    if (next === FX) { void fxToKeys(fxOnKeys?.category, fxOnKeys?.index); return; }
    setTone(next as ToneId);
    const s = await ensure();
    await s?.useTone(next as ToneId);
  }
  async function loadSample(file: File | undefined) {
    if (!file) return;
    if (MIDI_FILE.test(file.name) || file.type === "audio/midi") { void importMidi(file); return; }
    const s = await ensure();
    if (!s) { toast.fail("Audio is not ready yet. Try again in a moment."); return; }
    try {
      const seconds = await s.useFile(file, root);
      setSample({ name: file.name.replace(/\.[^.]+$/, ""), seconds });
      setTone(SAMPLE);
      toast(`${file.name} is on the keys. Its own pitch plays on ${noteName(root)}.`);
    } catch { toast.fail(`${file.name} could not be read as audio.`); }
  }
  function changeRoot(next: number) { setRoot(next); sampler.current?.setRoot(next); }
  const set = (patch: Partial<SoundSettings>) => setSound(prev => ({ ...prev, ...patch }));

  async function toggleBeat() {
    const s = await ensure();
    if (!s) return;
    if (s.playing) { s.stop(); setBeating(false); return; }
    s.start(setStep); setBeating(true);
  }
  function toggleStep(drum: DrumId, next: string[]) {
    setPattern(prev => ({ ...prev, [drum]: Array.from({ length: STEPS }, (_, i) => next.includes(String(i))) }));
    setPreset("");
  }
  function applyPreset(id: string) {
    const p = PATTERNS.find(x => x.id === id);
    if (!p) return;
    setPreset(id); setPattern(p.pattern); setBpm(p.bpm);
  }
  async function audition(drum: DrumId) { (await ensure())?.hit(drum); }
  const deckTempo = dj.liveTrack?.bpm ? Math.round(dj.liveTrack.bpm * dj.decks[dj.live].rate * 10) / 10 : null;

  const keyLabels = typing ? new Map(KEYMAP.map((k, i) => [from + i, k === ";" || k === "'" ? k : k.toUpperCase()])) : null;
  const soundItems = [...TONES.map(t => ({ value: t.id, label: t.label })), { value: SAMPLE, label: sample ? `Sample: ${sample.name}` : "Load a sample" },
    { value: FX, label: `Sound fx: ${fxOnKeys ? fxLabel(fxOnKeys.category, fxOnKeys.index) : fxLabel(fxCategory, fxIndex)}` }];
  const soundName = tone === SAMPLE ? sample?.name ?? "" : tone === FX && fxOnKeys ? fxLabel(fxOnKeys.category, fxOnKeys.index) : TONES.find(t => t.id === tone)?.label ?? "";

  return <Frame aria-label="Studio" id="studio">
    <FrameHeader>
      <FrameTitle>Studio</FrameTitle>
      <FrameStatus><Status size="sm" status={beating || songPlaying ? "running" : "idle"}><TextSwap>{beating && songPlaying ? "Beat and song" : beating ? "Beat playing" : songPlaying ? "Song playing" : "Idle"}</TextSwap></Status></FrameStatus>
      <FrameValue meta className="hidden truncate sm:inline">{soundName}</FrameValue>
      <FrameActions>
        <Hint label="Play any audio file from the piano">
          <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()}><Icon icon={Upload}/>Load sound</Button>
        </Hint>
        <div className="sr-only" aria-hidden>
          <Input ref={fileInput} type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac,.mid,.midi" tabIndex={-1} aria-label="Sound file"
            onChange={e => { void loadSample(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }}/>
          <Input ref={midiInput} type="file" accept=".mid,.midi,.smf,audio/midi,audio/x-midi" tabIndex={-1} aria-label="MIDI file"
            onChange={e => { void importMidi(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }}/>
        </div>
      </FrameActions>
    </FrameHeader>
    <FrameBody padding="none">
      <section aria-label="Sound" className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line p-3">
        <Field orientation="horizontal" className="w-auto gap-2">
          <FieldLabel>Sound</FieldLabel>
          <Pick items={soundItems} value={tone} className="w-48" onValueChange={v => void chooseTone(v)}/>
        </Field>
        {tone === SAMPLE && <>
          <Field orientation="horizontal" className="w-auto gap-2">
            <FieldLabel>Root note</FieldLabel>
            <Pick items={ROOTS} value={String(root)} className="w-24" onValueChange={v => changeRoot(Number(v))}/>
          </Field>
          <Field orientation="horizontal" className="w-auto gap-2">
            <Switch size="sm" checked={sound.loop} onCheckedChange={loop => set({ loop })}/>
            <FieldLabel>Loop while held</FieldLabel>
          </Field>
        </>}
        <ButtonGroup aria-label="Octave">
          <Button size="icon-sm" variant="secondary" aria-label="Octave down" disabled={octave <= 1} onClick={() => setOctave(o => o - 1)}><Icon icon={Subtract}/></Button>
          <ButtonGroupText className="type-code-sm">Octave {octave}</ButtonGroupText>
          <Button size="icon-sm" variant="secondary" aria-label="Octave up" disabled={octave >= 6} onClick={() => setOctave(o => o + 1)}><Icon icon={Add}/></Button>
        </ButtonGroup>
        <Field orientation="horizontal" className="w-auto gap-2">
          <Switch size="sm" checked={typing} onCheckedChange={setTyping}/>
          <FieldLabel>Play with computer keys</FieldLabel>
        </Field>
        {typing && <span className="flex items-center gap-1.5 type-body-sm text-text-2"><Kbd keys="a"/> to <Kbd keys="'"/> play, <Kbd keys="z"/> <Kbd keys="x"/> change octave</span>}
      </section>

      <section aria-label="MIDI" className="flex flex-col md:flex-row">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line p-3 md:flex-1 md:border-e">
          <h3 className="type-label-sm text-text-2">MIDI keyboard</h3>
          {keyboards === null
            ? <Button size="sm" variant="secondary" onClick={() => void connectKeyboard()}>Connect keyboard</Button>
            : <Status size="sm" status={keyboards.length ? "ok" : "idle"}>{keyboards.length ? keyboards.join(", ") : "None plugged in"}</Status>}
          <span className="type-body-sm text-text-2">{keyboards === null ? "Play the piano from a USB or Bluetooth keyboard." : keyboards.length ? "Velocity, sustain pedal and pitch wheel work." : "Plug one in; it shows up here."}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line p-3 md:flex-1">
          <h3 className="type-label-sm text-text-2">MIDI file</h3>
          {song ? <>
            <span className="min-w-0 truncate type-body-sm text-text-1" title={song.title}>{song.title}</span>
            <span className="type-code-sm text-text-2">{song.data.notes.length} notes{song.data.drums.length ? `, ${song.data.drums.length} drum hits` : ""}, {formatTime(songPlaying ? songAt : 0)} / {formatTime(song.data.duration)}</span>
            <Button size="sm" variant="secondary" aria-pressed={songPlaying} onClick={() => void toggleSong()}>
              <Icon icon={songPlaying ? Pause : Play}/>{songPlaying ? "Stop song" : "Play song"}
            </Button>
            <Field orientation="horizontal" className="w-auto gap-2">
              <Switch size="sm" checked={songLoop} onCheckedChange={setSongLoop}/>
              <FieldLabel>Loop</FieldLabel>
            </Field>
            <Button size="sm" variant="ghost" onClick={() => midiInput.current?.click()}>Replace</Button>
          </> : <>
            <Button size="sm" variant="secondary" onClick={() => midiInput.current?.click()}><Icon icon={Upload}/>Import .mid file</Button>
            <span className="type-body-sm text-text-2">Plays its melody with the sound above.</span>
          </>}
        </div>
      </section>

      <Piano from={from} held={songHeld.size ? new Set([...held, ...songHeld]) : held} keyLabels={keyLabels} onDown={m => void down(m)} onUp={up}/>

      <section aria-label="Sound shaping" className="grid grid-cols-3 gap-x-2 gap-y-3 border-b border-line p-3 sm:grid-cols-5 xl:grid-cols-10">
        {([
          ["Pitch", sound.transpose, -24, 24, 0, semis, "text-data-1", (v: number) => set({ transpose: Math.round(v) })],
          ["Fine tune", sound.fine, -100, 100, 0, cents, "text-data-1", (v: number) => set({ fine: v })],
          ["Attack", sound.attack, 0.002, 2, DEFAULT_SOUND.attack, ms, "text-data-2", (v: number) => set({ attack: v })],
          ["Release", sound.release, 0.01, 4, DEFAULT_SOUND.release, ms, "text-data-2", (v: number) => set({ release: v })],
          ["Filter", sound.cutoff, 0, 1, 1, pct, "text-data-3", (v: number) => set({ cutoff: v })],
          ["Resonance", sound.resonance, 0, 1, DEFAULT_SOUND.resonance, pct, "text-data-3", (v: number) => set({ resonance: v })],
          ["Drive", sound.drive, 0, 1, 0, pct, "text-data-4", (v: number) => set({ drive: v })],
          ["Delay", sound.delay, 0, 1, 0, pct, "text-data-5", (v: number) => set({ delay: v })],
          ["Reverb", sound.reverb, 0, 1, DEFAULT_SOUND.reverb, pct, "text-data-5", (v: number) => set({ reverb: v })],
          ["Volume", sound.volume, 0, 1, DEFAULT_SOUND.volume, pct, "text-data-6", (v: number) => set({ volume: v })],
        ] as const).map(([label, value, min, max, reset, format, tint, onChange]) => <div key={label} className="flex flex-col items-center gap-1">
          <Knob label={label} value={value} min={min} max={max} reset={reset} format={format} tone={tint} onChange={onChange}/>
          <span className="type-label-sm text-text-2" aria-hidden>{label}</span>
          <span className="type-code-sm text-text-1" aria-hidden>{format(value)}</span>
        </div>)}
      </section>

      <section aria-label="Sound fx" className="flex flex-col gap-3 border-b border-line p-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h3 className="type-label-sm text-text-2">Sound fx</h3>
          <SegmentedControl size="sm" aria-label="Sound fx kind" value={fxCategory} onValueChange={v => { setFxCategory(v as FxCategory); setFxIndex(0); }}>
            {FX_CATEGORIES.map(c => <SegmentedControlItem key={c.id} value={c.id}>{c.label}</SegmentedControlItem>)}
          </SegmentedControl>
          <Hint label={`Play ${fxLabel(fxCategory, fxIndex)} at any pitch from the piano`}>
            <Button size="sm" variant="secondary" onClick={() => void fxToKeys()}>Use on piano</Button>
          </Hint>
          <span className="type-body-sm text-text-2">Pads go through the knobs above. The beat&apos;s Sound fx row plays the last pad pressed.</span>
        </div>
        {/* Every press plays, the chosen pad included, so these are buttons; the chosen one is the raised secondary. */}
        <div role="group" aria-label={`${FX_CATEGORIES.find(c => c.id === fxCategory)?.label} pads`} className="grid grid-cols-6 gap-2 lg:grid-cols-12">
          {FX_LIBRARY[fxCategory].map((_, i) => <Button key={i} size="sm" variant={i === fxIndex ? "secondary" : "ghost"} aria-pressed={i === fxIndex}
            aria-label={`Play ${fxLabel(fxCategory, i)}`} onClick={() => void playPad(i)}>{String(i + 1)}</Button>)}
        </div>
      </section>

      <section aria-label="Beat maker" className="flex flex-col">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line p-3">
          <Button size="sm" onClick={() => void toggleBeat()} aria-pressed={beating}>
            <Icon icon={beating ? Pause : Play}/>{beating ? "Stop beat" : "Play beat"}
          </Button>
          <Field orientation="horizontal" className="w-auto gap-2">
            <FieldLabel>Pattern</FieldLabel>
            <Pick placeholder="Your pattern" items={PATTERNS.map(p => ({ value: p.id, label: p.label }))} value={preset || null} className="w-44"
              onValueChange={applyPreset}/>
          </Field>
          <div className={cn("flex items-center gap-2", locked && "pointer-events-none opacity-60")} aria-disabled={locked || undefined}>
            <Knob label="Tempo" value={locked && deckTempo ? deckTempo : bpm} min={60} max={180} reset={120} format={v => `${Math.round(v * 10) / 10} BPM`} tone="text-data-1" onChange={v => setBpm(Math.round(v))}/>
            <span className="type-code-sm text-text-1" aria-hidden>{locked && deckTempo ? deckTempo : bpm} BPM</span>
          </div>
          <Hint label={deckTempo ? "Play the beat on the live deck's bars, at its tempo, following tempo changes and mixes" : "Play a track with a tempo on a deck first"}>
            <Field orientation="horizontal" className="w-auto gap-2">
              <Switch size="sm" checked={locked} disabled={!deckTempo && !locked} onCheckedChange={setLocked}/>
              <FieldLabel>Lock to deck</FieldLabel>
            </Field>
          </Hint>
          {!locked && <Hint label={deckTempo ? `Set the beat to ${deckTempo} BPM` : "Load a track with a tempo on a deck first"}>
            <Button size="sm" variant="ghost" disabled={!deckTempo} onClick={() => deckTempo && setBpm(Math.round(deckTempo))}>Match tempo</Button>
          </Hint>}
          <div className="flex items-center gap-2">
            <Knob label="Drum volume" value={drumVolume} min={0} max={1} reset={0.8} format={pct} tone="text-data-6" onChange={setDrumVolume}/>
            <span className="type-label-sm text-text-2" aria-hidden>Drums {pct(drumVolume)}</span>
          </div>
          <Button size="sm" variant="ghost" className="ms-auto" onClick={() => { setPattern(emptyPattern()); setPreset(""); }}><Icon icon={TrashCan}/>Clear pattern</Button>
        </div>
        <div className="overflow-x-auto p-3">
          <div className="flex min-w-xl flex-col gap-1.5">
            {/* The playhead: one cell per step, the first of each beat a shade darker. */}
            <div className="ms-28 flex gap-px" aria-hidden>
              {Array.from({ length: STEPS }, (_, i) => <span key={i} className={cn("h-1 flex-1", i === step ? "bg-text-1" : i % 4 === 0 ? "bg-line-control" : "bg-line-faint")}/>)}
            </div>
            {DRUMS.map(d => <div key={d.id} className="flex items-center gap-2">
              <Button size="sm" variant="ghost" className="w-26 shrink-0 justify-start" onClick={() => void audition(d.id)} aria-label={`Play ${d.label.toLowerCase()}`}>{d.label}</Button>
              <SegmentedControl multiple fill size="sm" aria-label={`${d.label} steps`} className="flex-1"
                value={(pattern[d.id] ?? []).flatMap((on, i) => on ? [String(i)] : [])} onValueChange={next => toggleStep(d.id, next)}>
                {Array.from({ length: STEPS }, (_, i) => <SegmentedControlItem key={i} value={String(i)} aria-label={`${d.label} step ${i + 1}`}>{i % 4 === 0 ? String(i / 4 + 1) : ""}</SegmentedControlItem>)}
              </SegmentedControl>
            </div>)}
          </div>
        </div>
      </section>
    </FrameBody>
  </Frame>;
}
