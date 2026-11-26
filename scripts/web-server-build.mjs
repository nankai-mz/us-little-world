import { resolve } from "node:path";
import { build } from "esbuild";

export function buildWebServer(outfile, write = true) {
  return build({
    entryPoints: [resolve("src/server/web-entry.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile,
    write,
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
}
