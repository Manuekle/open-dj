import type { Metadata } from "next";
import { StemsClient } from "@/components/stems/stems-client";

export const metadata: Metadata = { title: "Stems · Shift", description: "See and solo the stems of every track, laid out like a DAW playlist." };

export default function StemsPage() { return <StemsClient />; }
