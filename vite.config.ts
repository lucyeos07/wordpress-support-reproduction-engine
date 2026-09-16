import { defineConfig } from "vite";

/** The product application. Spike pages have their own config. */
export default defineConfig({
  root: "app",
  server: {
    port: 5173,
    // No COOP/COEP: Playground's runtime executes inside the
    // playground.wordpress.net remote origin, and setting COEP here blocks that
    // iframe (docs/phase-0-findings.md §3).
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
