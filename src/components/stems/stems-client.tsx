"use client";

import dynamic from "next/dynamic";

// The page reads IndexedDB and the audio hardware on first render, so it is never rendered on the server.
const StemsView = dynamic(() => import("@/components/stems/stems-view").then(m => m.StemsView), { ssr: false });

export function StemsClient() { return <StemsView />; }
