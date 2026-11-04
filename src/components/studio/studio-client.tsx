"use client";

import dynamic from "next/dynamic";

// The studio reads IndexedDB, the audio hardware and the microphone, so it is never rendered on the server.
const StudioView = dynamic(() => import("@/components/studio/studio-view").then(m => m.StudioView), { ssr: false });

export function StudioClient() { return <StudioView />; }
