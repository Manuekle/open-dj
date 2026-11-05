"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hzToMidi } from "@/lib/autotune";
import { noteName, pitchOfBlock, rangeOf, type VocalRange } from "@/lib/vocal-range";
import { Button } from "@/components/sodium/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/sodium/ui/dialog";
import { StatusStrip, StatusStripCell, StatusStripLabel, StatusStripUnit, StatusStripValue } from "@/components/sodium/ui/status-strip";

/* The voice scan for karaoke: the person sings low to high and back on the microphone, the page reads the pitch of each
   animation frame (lib/vocal-range, YIN from lib/autotune) and keeps the 5th to 95th percentile of the steady notes as
   their range. The take never leaves the page and is not stored, only the two notes. */

const LIMIT = 30;
const LIVE = { low: 0.05, high: 0.95, run: 4, least: 15 };

type Mic = { stream: MediaStream; ctx: AudioContext; analyser: AnalyserNode };

export function VoiceScan({ open, onOpenChange, saved, onSave }: {
  open: boolean; onOpenChange: (open: boolean) => void; saved: VocalRange | null; onSave: (range: VocalRange) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "listening" | "done">("idle");
  const [note, setNote] = useState<{ midi: number; hz: number } | null>(null);
  const [heard, setHeard] = useState<VocalRange | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mic = useRef<Mic | null>(null);
  const f0s = useRef<number[]>([]);

  const release = useCallback(() => {
    const m = mic.current;
    mic.current = null;
    if (!m) return;
    m.stream.getTracks().forEach(t => t.stop());
    void m.ctx.close();
  }, []);

  const stop = useCallback(() => {
    release();
    setNote(null);
    setHeard(rangeOf(f0s.current, LIVE));
    setPhase("done");
  }, [release]);

  const start = async () => {
    setError(null); setHeard(null); setNote(null); setElapsed(0);
    f0s.current = [];
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot reach a microphone.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      ctx.createMediaStreamSource(stream).connect(analyser);
      mic.current = { stream, ctx, analyser };
      setPhase("listening");
    } catch (e) {
      release();
      setError(e instanceof DOMException && e.name === "NotAllowedError" ? "Microphone access was blocked. Allow it in the browser to scan your voice." : e instanceof Error ? e.message : "Could not open the microphone.");
    }
  };

  // While listening: one pitch per frame, the range so far a few times a second, and a stop at the time limit.
  useEffect(() => {
    if (phase !== "listening") return;
    const m = mic.current;
    if (!m) return;
    const block = new Float32Array(m.analyser.fftSize);
    const began = performance.now();
    let live = true, busy = false, polls = 0, frame = 0;
    const tick = () => {
      if (!live) return;
      frame = requestAnimationFrame(tick);
      const seconds = (performance.now() - began) / 1000;
      if (seconds >= LIMIT) { stop(); return; }
      if (busy) return;
      busy = true;
      m.analyser.getFloatTimeDomainData(block);
      void pitchOfBlock(block, m.ctx.sampleRate).then(hz => {
        busy = false;
        if (!live) return;
        f0s.current.push(hz);
        setNote(hz > 0 ? { midi: hzToMidi(hz), hz } : null);
        if (++polls % 8 === 0) { setHeard(rangeOf(f0s.current, LIVE)); setElapsed(Math.floor(seconds)); }
      });
    };
    frame = requestAnimationFrame(tick);
    return () => { live = false; cancelAnimationFrame(frame); };
  }, [phase, stop]);

  // Closing the dialog, or leaving the page, lets go of the microphone and starts over next time.
  useEffect(() => {
    if (open) return;
    release();
    queueMicrotask(() => { setPhase("idle"); setNote(null); setHeard(null); setElapsed(0); setError(null); });
  }, [open, release]);
  useEffect(() => release, [release]);

  const shown = heard ?? (phase === "idle" ? saved : null);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="sm">
      <DialogHeader><DialogTitle>Scan your voice</DialogTitle></DialogHeader>
      <DialogBody>
        <div className="flex flex-col gap-4">
          <DialogDescription>
            Sing on an open vowel from your lowest comfortable note up to your highest, then back down, holding a few notes on the
            way. Keep the music off or use headphones. The recording stays on this page; only the two notes are kept.
          </DialogDescription>
          <div className="flex items-baseline gap-3" aria-live="polite">
            <span className="type-figure text-text-1">{phase === "listening" ? note ? noteName(note.midi) : "-" : shown ? `${noteName(shown.low)} to ${noteName(shown.high)}` : "-"}</span>
            {phase === "listening" && <span className="type-code-sm text-text-3">{note ? `${note.hz.toFixed(0)} Hz` : "Listening"}</span>}
          </div>
          <StatusStrip variant="plain" label="Voice range">
            <StatusStripCell><StatusStripLabel>Lowest</StatusStripLabel><StatusStripValue>{shown ? noteName(shown.low) : "-"}</StatusStripValue></StatusStripCell>
            <StatusStripCell><StatusStripLabel>Highest</StatusStripLabel><StatusStripValue>{shown ? noteName(shown.high) : "-"}</StatusStripValue></StatusStripCell>
            <StatusStripCell><StatusStripLabel>Span</StatusStripLabel><StatusStripValue>{shown ? Math.round(shown.high - shown.low) : "-"}<StatusStripUnit>semitones</StatusStripUnit></StatusStripValue></StatusStripCell>
            <StatusStripCell><StatusStripLabel>Time</StatusStripLabel><StatusStripValue>{phase === "idle" ? "-" : elapsed}<StatusStripUnit>/ {LIMIT} s</StatusStripUnit></StatusStripValue></StatusStripCell>
          </StatusStrip>
          {phase === "done" && !heard && <p role="alert" className="type-body-sm text-fail-text">Not enough steady singing was heard. Move closer to the microphone and hold each note a moment.</p>}
          {error && <p role="alert" className="type-body-sm text-fail-text">{error}</p>}
        </div>
      </DialogBody>
      <DialogFooter>
        <DialogClose>Cancel</DialogClose>
        {phase === "done" && <Button variant="secondary" onClick={() => void start()}>Sing again</Button>}
        <Button disabled={phase === "done" && !heard} onClick={() => {
          if (phase === "idle") void start();
          else if (phase === "listening") stop();
          else if (heard) { onSave(heard); onOpenChange(false); }
        }}>{phase === "idle" ? "Start listening" : phase === "listening" ? "Stop listening" : "Save range"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
