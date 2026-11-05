import type { Metadata, Viewport } from "next";
import "@/components/sodium/styles.css";
import "./globals.css";
import "./transitions.css";
import { SodiumPortalProvider } from "@/lib/sodium/portal";
import { Toaster } from "@/components/sodium/ui/toast";
import { GlimmProvider } from "glimm/next";

const description = "Mix your own music with two decks, right in your browser.";

/* Shift runs on your own machine, so each instance stays out of search results; the public page is the landing at
   manuekle.github.io/shift. The social card (opengraph-image.jpg, twitter-image.jpg) comes from scripts/og/render.sh. */
export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`),
  title: "Shift",
  description,
  applicationName: "Shift",
  authors: [{ name: "Manuekle", url: "https://github.com/Manuekle" }],
  robots: { index: false, follow: false },
  openGraph: { type: "website", siteName: "Shift", title: "Shift · A DJ workstation that runs on your own machine", description },
  twitter: { card: "summary_large_image", title: "Shift · A DJ workstation that runs on your own machine", description },
};
export const viewport: Viewport = { themeColor: "#1e1e1d", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" data-theme="dark">
    <body className="sodium" suppressHydrationWarning>
      {/* Moving between rooms (Decks, Stems, Studio, Karaoke, Rhythm) sweeps a band of warm oranges, Shift's own hues.
          The room links are glimm's TransitionLink; see dj-app.tsx and the rooms' back links. */}
      <GlimmProvider palette="ember" brightness={0.85} sweepMs={900} outroMs={180}>
        <SodiumPortalProvider>{children}<Toaster/></SodiumPortalProvider>
      </GlimmProvider>
    </body>
  </html>;
}
