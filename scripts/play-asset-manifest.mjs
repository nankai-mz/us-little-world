import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const icons = "node_modules/lucide-react/";
const iconNotice = `${icons}LICENSE`;
const iconMetadata = `${icons}package.json`;
const releaseNotice = "licenses/lucide-react.txt";
const hasText = (value) => typeof value === "string" && value.trim().length > 0;

export async function buildPlayAssetManifest(root = projectRoot) {
  const base = await realpath(root);
  const manifest = JSON.parse(await readFile(resolve(base, "docs/playground-asset-manifest.json"), "utf8"));
  if (manifest.format !== 2 || !Array.isArray(manifest.assets) || !manifest.assets.length || !hasText(manifest.privateMedia)) {
    throw new Error("游戏素材清单格式无效");
  }

  const ids = new Set();
  const licenseNotices = {};
  const assets = [];
  for (const { id, version, sources, license, selfMade, dimensions, transparent, adaptation, origin, content } of manifest.assets) {
    const validDimensions = dimensions === null ||
      (dimensions && [dimensions.width, dimensions.height].every((value) => Number.isSafeInteger(value) && value > 0));
    if (!hasText(id) || !/^[a-z0-9-]+$/.test(id) || ids.has(id) ||
      ![version, license, adaptation, origin, content].every(hasText) ||
      typeof selfMade !== "boolean" || !validDimensions ||
      (transparent !== null && typeof transparent !== "boolean") ||
      !Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length) {
      throw new Error(`游戏素材登记无效：${id ?? "缺少编号"}`);
    }
    ids.add(id);

    const sourceFiles = new Map();
    for (const path of sources) {
      if (!hasText(path) || !/^(?:src\/|web\/|node_modules\/lucide-react\/)[a-zA-Z0-9._/-]+$/.test(path) ||
        path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error(`游戏素材路径无效：${id} / ${path}`);
      }
      const target = await realpath(resolve(base, path));
      const fromRoot = relative(base, target);
      if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot) ||
        !(await stat(target)).isFile()) {
        throw new Error(`游戏素材必须是项目内的文件：${id} / ${path}`);
      }
      sourceFiles.set(path, await readFile(target));
    }

    const asset = { id, version, license, selfMade, dimensions, transparent, adaptation, origin, content,
      sources: Array.from(sourceFiles, ([path, bytes]) => ({
        path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      })),
    };
    if (id === "playground-lucide-icons") {
      if (selfMade || !sourceFiles.get(iconNotice)?.length || !sourceFiles.has(iconMetadata)) {
        throw new Error("Lucide 图标缺少第三方许可文件");
      }
      const installed = JSON.parse(sourceFiles.get(iconMetadata).toString("utf8"));
      if (installed.name !== "lucide-react" || installed.version !== version || installed.license !== license) {
        throw new Error("Lucide 安装版本或许可与游戏素材清单不一致");
      }
      asset.licenseNotice = releaseNotice;
      licenseNotices[releaseNotice] = sourceFiles.get(iconNotice);
    }
    assets.push(asset);
  }
  if (!licenseNotices[releaseNotice]) throw new Error("游戏素材清单缺少 Lucide 图标登记");
  return { manifest: { format: manifest.format, assets, privateMedia: manifest.privateMedia }, licenseNotices };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { manifest } = await buildPlayAssetManifest();
  console.log(JSON.stringify(manifest, null, 2));
}
