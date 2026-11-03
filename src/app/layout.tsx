import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {title: "Open DJ — Studio", description: "Mix your music locally, with real DJ controls in your browser."};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="es" className="dark"><body className="sodium">{children}</body></html>}
