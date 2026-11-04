import type { Metadata, Viewport } from "next";
import "@/components/sodium/styles.css";
import "./globals.css";
import "./transitions.css";
import { SodiumPortalProvider } from "@/lib/sodium/portal";
import { Toaster } from "@/components/sodium/ui/toast";

export const metadata: Metadata = { title: "Shift", description: "Mix your own music with two decks, right in your browser." };
export const viewport: Viewport = { themeColor: "#1e1e1d", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" data-theme="dark">
    <body className="sodium" suppressHydrationWarning><SodiumPortalProvider>{children}<Toaster/></SodiumPortalProvider></body>
  </html>;
}
