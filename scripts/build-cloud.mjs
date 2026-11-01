import { build } from "esbuild";
await build({
  entryPoints: ["src/server/cloud-entry.ts"],
  outfile: "cloudfunctions/usApi/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["wx-server-sdk"],
  minify: false,
});
console.log("Cloud function built: cloudfunctions/usApi/index.js");
