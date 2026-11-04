"use client";

import { useState } from "react";
import { Button } from "@/components/sodium/ui/button";
import { automationTests, clockTests, driftTests, pitchTests, type SelfTest } from "@/lib/audio-selftest";

/* Runs lib/audio-selftest in this browser. Open it in Chrome and in Safari and compare. The automation checks need no
   gesture; the others play (silent) audio, so they start from the button. */
export default function Diagnostics() {
  const [rows, setRows] = useState<SelfTest[]>([]);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true); setRows([]);
    const steps = [automationTests, pitchTests, clockTests, driftTests];
    for (const step of steps) {
      try { const next = await step(); setRows(prev => [...prev, ...next]); }
      catch (e) { setRows(prev => [...prev, { name: step.name, pass: false, detail: e instanceof Error ? e.message : String(e) }]); }
    }
    setRunning(false);
  }

  return <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
    <h1 className="type-title">Audio self-test</h1>
    <p className="text-text-2">{typeof navigator === "undefined" ? "" : navigator.userAgent}</p>
    <div><Button variant="primary" disabled={running} onClick={() => void run()}>{running ? "Running" : "Run the audio self-test"}</Button></div>
    <ul className="flex flex-col gap-2" aria-live="polite">
      {rows.map((r, i) => <li key={i} className="flex flex-col border-b border-line pb-2">
        <span className={r.pass ? "text-text-1" : "text-text-2"}>{r.pass ? "Pass" : "Fail"}: {r.name}</span>
        <span className="type-label-sm text-text-3">{r.detail}</span>
      </li>)}
    </ul>
  </main>;
}
