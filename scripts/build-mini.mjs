import { build } from "esbuild";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
const pages = [
  "home",
  "memories",
  "interaction",
  "plans",
  "profile",
  "workspace",
];
for (const page of pages) {
  const path = `miniprogram/pages/${page}`;
  await mkdir(path, { recursive: true });
  await writeFile(
    `${path}/index.ts`,
    `import { pageFactory } from '../../controller';\nPage(pageFactory('${page}'));\n`,
  );
  await writeFile(
    `${path}/index.wxml`,
    '<import src="../../templates/screen.wxml"/>\n<template is="screen" data="{{...viewModel}}"/>\n',
  );
  await writeFile(
    `${path}/index.json`,
    JSON.stringify({
      navigationBarTitleText: {
        home: "Us · 我们的小世界",
        memories: "时光手账",
        interaction: "一起玩耍",
        plans: "未来清单",
        profile: "我的空间",
        workspace: "我们的小世界",
      }[page],
      enablePullDownRefresh: true,
    }),
  );
}
await mkdir("miniprogram/generated", { recursive: true });
await build({
  entryPoints: ["miniprogram/controller.ts"],
  outfile: "miniprogram/generated/controller.js",
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  define: { global: "globalThis" },
  minify: true,
  external: ["./platform"],
});
await build({
  entryPoints: ["miniprogram/platform.ts"],
  outfile: "miniprogram/generated/platform.js",
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  define: { global: "globalThis" },
  minify: true,
});
// App/controller builds preserve a single platform module instead of bundling it into each page.
await build({
  entryPoints: ["miniprogram/app.ts"],
  outfile: "miniprogram/app.js",
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  define: { global: "globalThis" },
  minify: true,
  plugins: [
    {
      name: "shared-platform",
      setup(b) {
        b.onResolve({ filter: /^\.\/platform$/ }, () => ({
          path: "./generated/platform.js",
          external: true,
        }));
      },
    },
  ],
});
for (const page of pages)
  await writeFile(
    `miniprogram/pages/${page}/index.js`,
    `Page(require('../../generated/controller.js').pageFactory('${page}'));\n`,
  );
// The controller's external module resolves relative to generated/.
await mkdir("miniprogram/assets", { recursive: true });
for (const name of ["pet-room", "flower", "coffee", "sea", "sunset"])
  await writeFile(
    `miniprogram/assets/${name}.png`,
    new Resvg(await readFile(`public/assets/${name}.svg`)).render().asPng(),
  );
const tabPaths = {
  home: '<path d="m3 11 9-8 9 8v9a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  journal: '<path d="M5 3h14v18H5zM8 3v18M11 8h5m-5 4h5m-5 4h3"/>',
  play: '<path d="M6 7h12c3 0 5 10 3 11-2 2-4-2-5-2H8c-1 0-3 4-5 2C1 17 3 7 6 7Z"/><path d="M7 10v5m-2.5-2.5h5M16 11h.1m2 3h.1"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18m-13 4h.1m4 0h.1m4 0h.1M8 17h.1m4 0h.1"/>',
  profile:
    '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2M8 21h8"/>',
};
for (const [name, path] of Object.entries(tabPaths)) {
  for (const [suffix, color] of [
    ["", "#807564"],
    ["-selected", "#9b5f55"],
  ]) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="81" height="81" viewBox="0 0 24 24"><g fill="none" stroke="${color}" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${path}</g></svg>`;
    await writeFile(
      `miniprogram/assets/tab-${name}${suffix}.png`,
      new Resvg(svg).render().asPng(),
    );
  }
}
console.log(`Built ${pages.length} native pages and one shared runtime`);
