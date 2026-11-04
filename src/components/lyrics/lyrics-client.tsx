"use client";

import dynamic from "next/dynamic";

// The page reads IndexedDB and the audio hardware on first render, so it is never rendered on the server.
const LyricsView = dynamic(() => import("@/components/lyrics/lyrics-view").then(m => m.LyricsView), { ssr: false });

export function LyricsClient() { return <LyricsView />; }
