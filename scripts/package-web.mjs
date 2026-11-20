import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { zipSync } from "fflate";

const { version } = JSON.parse(await readFile("package.json", "utf8"));
const files = {};
async function addPublicTree(path, destination) {
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = `${path}/${entry.name}`;
    const builtFile = `${destination}/${entry.name}`;
    if (entry.isDirectory()) await addPublicTree(name, builtFile);
    else if (entry.isFile()) files[builtFile] = await readFile(builtFile);
  }
}
await addPublicTree("public/assets", "dist/assets");
const webManifest = JSON.parse(await readFile("dist/.vite/manifest.json", "utf8"));
const webAssets = new Set(["assets/icon-192.png", "assets/icon-512.png"]);
for (const chunk of Object.values(webManifest)) {
  for (const path of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) webAssets.add(path);
}
for (const path of [...webAssets].sort()) {
  if (!/^assets\/[a-zA-Z0-9._/-]+$/.test(path) || path.split("/").some((segment) => !segment || segment === "." || segment === ".."))
    throw new Error(`Invalid Vite output path: ${path}`);
  files[`dist/${path}`] = await readFile(`dist/${path}`);
}
for (const name of [
  "dist/index.html", "dist/.vite/manifest.json", "dist/sw.js", "dist/manifest.webmanifest",
  "deploy/web/Caddyfile", "deploy/web/us-web.service", "deploy/web/web.env.example",
  "deploy/web/us-web-backup.service", "deploy/web/us-web-backup.timer",
  "scripts/backup-web.mjs", "scripts/web-snapshot.mjs", "scripts/recover-web.mjs", "scripts/maintain-web.mjs", "scripts/check-web-origin.mjs",
])
  files[name] = await readFile(name);
files["README.md"] = await readFile("docs/WEB_DEPLOYMENT.md");
const result = await build({ entryPoints: ["src/server/web-entry.ts"], outfile: "server.mjs", write: false,
  bundle: true, platform: "node", target: "node22", format: "esm" });
files["server.mjs"] = result.outputFiles[0].contents;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const createdAt = new Date().toISOString();
files["manifest.json"] = Buffer.from(JSON.stringify({ version, createdAt,
  files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])),
}, null, 2) + "\n");
const archive = zipSync(files, { level: 0 });
const destination = "artifacts/web-release";
const file = `us-web-${version}-${createdAt.replace(/[:.]/g, "-")}.zip`;
await mkdir(destination, { recursive: true });
await writeFile(join(destination, file), archive, { flag: "wx" });
await writeFile(join(destination, `${file}.sha256`), `${sha256(archive)}  ${file}\n`, { flag: "wx" });
console.log(join(destination, file));
