import type { NextConfig } from "next";

/* SHIFT_DESKTOP=1 (npm run desktop:build) builds the self-contained server the Mac app runs (.next/standalone). The
   models, the Python environment and the backups stay out of it: the app keeps those in ~/Library/Application Support. */
const desktop = Boolean(process.env.SHIFT_DESKTOP);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // No Next.js badge in the corner, in the browser or the Mac app.
  devIndicators: false,
  ...(desktop && {
    output: "standalone",
    outputFileTracingExcludes: { "*": [".whisper/**", ".demucs/**", "data/**", "docs/**", "dist-desktop/**", "desktop/**"] },
  }),
};
export default nextConfig;
