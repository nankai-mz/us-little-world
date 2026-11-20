import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "node:fs";
export default defineConfig({
  plugins: [react(), {
    name: "us-install-icons",
    apply: "build",
    generateBundle() {
      const svg = readFileSync("public/assets/favicon.svg");
      for (const width of [192, 512]) {
        const icon = new Resvg(svg, { fitTo: { mode: "width", value: width } });
        this.emitFile({ type: "asset", fileName: `assets/icon-${width}.png`, source: icon.render().asPng() });
      }
    },
  }],
  publicDir: "public",
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    manifest: true,
    chunkSizeWarningLimit: 700,
  },
});
