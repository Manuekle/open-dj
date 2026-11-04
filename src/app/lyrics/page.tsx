import type { Metadata } from "next";
import { LyricsClient } from "@/components/lyrics/lyrics-client";

export const metadata: Metadata = { title: "Karaoke · Shift", description: "Sing along: lyrics with the timing of every word, written locally by Whisper." };

export default function LyricsPage() { return <LyricsClient />; }
