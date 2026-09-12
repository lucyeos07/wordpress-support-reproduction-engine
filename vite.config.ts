import { defineConfig } from "vite";

export default defineConfig({
  root: "spike/browser",
  server: {
    port: 9500,
    // No COOP/COEP here on purpose. Playground's wasm runtime executes inside
    // the playground.wordpress.net remote origin, which sets its own headers.
    // Setting COEP on this embedder page blocks that cross-origin iframe and
    // startPlaygroundWeb() then never resolves. See docs/phase-0-findings.md.
  },
});
