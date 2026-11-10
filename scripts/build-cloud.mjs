import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const testDirectory = "cloudfunctions/usApiTest";
await mkdir(testDirectory, { recursive: true });
for (const manifest of ["package.json", "package-lock.json"])
  await writeFile(
    `${testDirectory}/${manifest}`,
    await readFile(`cloudfunctions/usApi/${manifest}`),
  );

for (const directory of ["cloudfunctions/usApi", testDirectory]) {
  await build({
    entryPoints: ["src/server/cloud-entry.ts"],
    outfile: `${directory}/index.js`,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    external: ["wx-server-sdk"],
    define: { US_SHARED_TEST: String(directory === testDirectory) },
    minify: false,
  });
  console.log(`Cloud function built: ${directory}/index.js`);
}
