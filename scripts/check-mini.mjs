import {
  readFile,
  access,
  stat,
  readdir,
  writeFile,
  mkdir,
} from "node:fs/promises";
import assert from "node:assert/strict";
import vm from "node:vm";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { validateWxml } from "./wxml-check.mjs";
const app = JSON.parse(await readFile("miniprogram/app.json", "utf8"));
const config = JSON.parse(await readFile("project.config.json", "utf8"));
assert.equal(app.tabBar.list.length, 5);
for (const p of app.pages)
  for (const suffix of [".json", ".wxml", ".js"])
    await access(resolve(config.miniprogramRoot, p + suffix));
const template = await readFile("miniprogram/templates/screen.wxml", "utf8");
assert.deepEqual(
  validateWxml(template, "screen.wxml"),
  [],
  "WXML binding/tag checks failed",
);
for (const route of app.pages)
  assert.deepEqual(
    validateWxml(
      await readFile(resolve(config.miniprogramRoot, route + ".wxml"), "utf8"),
      route,
    ),
    [],
  );
for (const tab of app.tabBar.list)
  for (const icon of [tab.iconPath, tab.selectedIconPath]) {
    assert(icon, "Both normal and selected Tab icons are required");
    assert(
      (await stat(resolve(config.miniprogramRoot, icon))).size < 40 * 1024,
      `Tab icon exceeds 40 KB: ${icon}`,
    );
  }
for (const name of ["coffee", "sunset", "sea"])
  await access(`miniprogram/assets/${name}.png`);
for (const match of template.matchAll(/src="(\/assets\/[^{}"]+)"/g))
  await access(resolve(config.miniprogramRoot, "." + match[1]));
const handlers = [
  ...template.matchAll(/(?:bind|catch)(?:tap|input|change)="(\w+)"/g),
].map((m) => m[1]);
const context = vm.createContext({
  console,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Int32Array,
  BigInt,
  ArrayBuffer,
  DataView,
  setTimeout,
  clearTimeout,
  Date,
  wx: {
    getStorageSync() {
      return "";
    },
    setNavigationBarTitle({ title }) {
      context.lastTitle = title;
    },
    env: { USER_DATA_PATH: "/fake" },
  },
});
const cache = new Map();
async function load(file) {
  file = resolve(file);
  if (cache.has(file)) return cache.get(file);
  const source = await readFile(file, "utf8");
  const module = { exports: {} };
  cache.set(file, module.exports);
  const required = [...source.matchAll(/require\(["'](.+?)["']\)/g)].map(
    (x) => x[1],
  );
  const deps = new Map();
  for (const dep of required)
    deps.set(
      dep,
      await load(
        resolve(dirname(file), dep.endsWith(".js") ? dep : `${dep}.js`),
      ),
    );
  const fn = vm.runInContext(
    `(function(require,module,exports){${source}\n})`,
    context,
    { filename: file },
  );
  fn(
    (dep) => {
      assert(deps.has(dep));
      return deps.get(dep);
    },
    module,
    module.exports,
  );
  cache.set(file, module.exports);
  return module.exports;
}
const { pageFactory } = await load("miniprogram/generated/controller.js");
for (const route of app.pages) {
  const page = pageFactory(route.split("/")[1]);
  assert.equal(typeof page.onLoad, "function");
  for (const name of handlers)
    assert.equal(typeof page[name], "function", `Missing event: ${name}`);
}
const workspace = pageFactory("workspace");
workspace.setData = (patch) => Object.assign(workspace.data, patch);
workspace.onLoad({ view: "editor", kind: "relationship" });
assert.equal(context.lastTitle, "设置恋爱开始日期");
workspace.onLoad({ view: "questionBank" });
assert.equal(context.lastTitle, "话题小书架");
Object.assign(workspace.data.viewModel, {
  effectText: "♡",
  effectType: "pat",
  spinning: true,
});
let spinFinished = false;
workspace._finishSpin = () => {
  spinFinished = true;
};
workspace._spinTimer = setTimeout(
  () => assert.fail("Hidden spin timer was not cancelled"),
  5000,
);
workspace.onHide();
assert.equal(workspace.data.viewModel.effectText, "");
assert.equal(workspace.data.viewModel.spinning, false);
assert.equal(spinFinished, true, "Hiding the page must release a pending spin");
assert.equal(
  typeof context.TextEncoder,
  "function",
  "Mini runtime must provide UTF-8 encoder",
);
assert.equal(
  typeof context.TextDecoder,
  "function",
  "Mini runtime must provide UTF-8 decoder",
);
async function packageBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) bytes += await packageBytes(path);
    else if (!entry.name.endsWith(".ts")) bytes += (await stat(path)).size;
  }
  return bytes;
}
const bytes = await packageBytes("miniprogram");
assert(bytes < 2 * 1024 * 1024, "Mini package must fit 2 MB");
await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/mini-contract.json",
  JSON.stringify(
    {
      success: true,
      generatedAt: new Date().toISOString(),
      routes: app.pages.length,
      handlers: new Set(handlers).size,
      conditionalBindings: [...template.matchAll(/wx:if=/g)].length,
      packageBytes: bytes,
      templateSha256: createHash("sha256").update(template).digest("hex"),
      limitation:
        "Source checks and Node VM only; no WeChat compiler or device execution",
    },
    null,
    2,
  ),
);
console.log(
  `PASS: WXML bindings/tags, 10 Tab icons, 3 sample photos, dynamic titles, ${app.pages.length} native routes, ${new Set(handlers).size} handlers, UTF-8 polyfills, ${Math.round(bytes / 1024)} KB package. Node VM/source checks only, not WeChat compiler/device testing.`,
);
