import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit and offline-audio tests. Web Audio comes from node-web-audio-api inside the tests that need it.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
