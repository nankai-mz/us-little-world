import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("artifacts/private-web", { recursive: true });
await build({
  entryPoints: ["src/server/web-entry.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "artifacts/private-web/server.mjs",
});
await import("../artifacts/private-web/server.mjs");
