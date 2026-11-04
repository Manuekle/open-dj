"use client";

import dynamic from "next/dynamic";

// The game reads the browser's storage and audio on first render, so it is never rendered on the server.
const RhythmGame = dynamic(() => import("@/components/game/rhythm-game").then(m => m.RhythmGame), { ssr: false });

export function RhythmGameClient() { return <RhythmGame />; }
