import type { Metadata } from "next";
import { StudioClient } from "@/components/studio/studio-client";

export const metadata: Metadata = { title: "Studio · Shift", description: "Four tracks: record your voice over stems of your library and export the mix." };

export default function StudioPage() { return <StudioClient />; }
