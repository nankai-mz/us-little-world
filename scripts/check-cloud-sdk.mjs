import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("./sdk-contract.cjs", import.meta.url))],
  { encoding: "utf8", timeout: 20000 },
);
if (result.status !== 0) {
  process.stderr.write(result.stderr || "SDK contract timed out or failed\n");
  process.exit(1);
}
process.stdout.write(result.stdout);
await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../artifacts/cloud-sdk-contract.json", import.meta.url),
  JSON.stringify(
    {
      ...JSON.parse(result.stdout),
      generatedAt: new Date().toISOString(),
      lockSha256: createHash("sha256")
        .update(
          await readFile(
            new URL(
              "../cloudfunctions/usApi/package-lock.json",
              import.meta.url,
            ),
          ),
        )
        .digest("hex"),
    },
    null,
    2,
  ),
);
