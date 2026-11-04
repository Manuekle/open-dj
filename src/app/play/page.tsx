import type { Metadata } from "next";
import { RhythmGameClient } from "@/components/game/rhythm-game-client";

export const metadata: Metadata = { title: "Rhythm · Shift", description: "Play any track as a tap-tiles rhythm game, charted from the audio." };

export default function PlayPage() { return <RhythmGameClient />; }
