import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import sodium from "./sodium.eslint.config.mjs";

// Sodium's components, hooks and lib are vendored from the design.how registry and checked by Sodium's own rules;
// React Compiler's stricter rules flag patterns upstream relies on (lazy ref callbacks, layout-time state).
const vendored = ["src/components/sodium/**", "src/lib/sodium/**", "src/hooks/sodium/**"];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: vendored,
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react-hooks/set-state-in-effect": "off",
      "react/no-children-prop": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  ...sodium,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", ".claude/**", ".agents/**", ".demucs/**", "sodium.eslint.config.mjs"]),
]);
