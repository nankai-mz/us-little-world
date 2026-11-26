import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

test.use({ hasTouch: true });

async function mountPlayFixture(page: Page, contents: string) {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(), loader: "tsx", contents: `
        import { createRoot } from "react-dom/client";
        import { CanvasBoard } from "./web/features/playground/CanvasBoard";
        import { WorldLayout } from "./web/features/playground/SceneRoom";
        import { MemoryTreeEditor } from "./web/features/playground/MemoryTree";
        import { StarMap } from "./web/features/playground/ConstellationMap";
        import { FlightJoystick } from "./web/features/playground/FlightJoystick";
        import { applyScene, startScene, type World } from "./src/features/scene-core/scene";
        import { UsService } from "./src/core/service";
        import { browserRandom } from "./src/core/crypto";
        import type { CanvasItem, Point } from "./src/features/canvas-core/canvas";
        import type { Entry } from "./src/core/types";
        const service = new UsService({ call: async () => { throw Error("Unexpected network request"); } },
          { get: () => null, set: () => {}, remove: () => {} }, browserRandom);
        const root = createRoot(document.getElementById("board")!);
        ${contents}
      `,
    },
    bundle: true, write: false, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
}

test("千物件画布只重绘变化内容，长笔画仍保留末端", async ({ page }, info) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.setContent('<style>canvas{width:900px;height:520px;touch-action:none;display:block}</style><div id="board"></div>');
  await page.evaluate(() => {
    const data = { backgroundSegments: 0, pendingSince: null as number | null, delays: [] as number[], pointer: -1 };
    Object.assign(window, { metrics: data });
    document.addEventListener("pointerdown", (event) => { data.pointer = event.pointerId; }, { capture: true });
    document.addEventListener("pointermove", (event) => {
      if (event.buttons & 1) data.pendingSince ??= performance.now();
    }, { capture: true });
    const { lineTo } = CanvasRenderingContext2D.prototype;
    CanvasRenderingContext2D.prototype.lineTo = function (x, y) {
      if (!this.canvas.isConnected) data.backgroundSegments++;
      else if (data.pendingSince !== null) {
        data.delays.push(performance.now() - data.pendingSince);
        data.pendingSince = null;
      }
      lineTo.call(this, x, y);
    };
  });
  await mountPlayFixture(page, `
        const objects: CanvasItem[] = Array.from({ length: 1000 }, (_, index) => ({
          id: index.toString(16).padStart(32, "0"), kind: "stroke", by: index % 2 as 0 | 1,
          x: index % 40 * 17 - 330, y: Math.floor(index / 40) * 12 - 144, angle: 0,
          version: 1, layer: index, panel: 0, color: "#8a877f", width: 3,
          points: Array.from({ length: 20 }, (_, step) => [step / 2, Math.sin(step / 3) * 3, 0.5]),
        }));
        const fixture = window as Window & { stroke?: Point[] };
        root.render(
          <CanvasBoard service={service} objects={objects} paper="plain"
            label="千物件画布" enabled onStroke={(points) => { fixture.stroke = points; }} />
        );
  `);
  const canvas = page.getByLabel("千物件画布");
  await expect(canvas).toBeVisible();
  const readMetrics = () => page.evaluate(() => (window as unknown as {
    metrics: { backgroundSegments: number; delays: number[]; pointer: number };
  }).metrics);
  await expect.poll(async () => (await readMetrics()).backgroundSegments).toBeGreaterThanOrEqual(19000);
  const box = (await canvas.boundingBox())!;
  const start = box.x + 30;
  const y = box.y + 100;
  await page.mouse.move(start, y);
  await page.mouse.down();
  await page.mouse.move(start + 140, y, { steps: 55 });
  const before = await readMetrics();
  await page.mouse.move(start + 480, y + 15, { steps: 55 });
  const after = await readMetrics();
  expect(after.backgroundSegments).toBe(before.backgroundSegments);
  expect(after.delays.length - before.delays.length).toBeGreaterThan(15);
  // Keep the real pointer down while exercising enough input events to trigger stroke compaction.
  expect(after.pointer).toBeGreaterThanOrEqual(0);
  await canvas.evaluate((node, position) => {
    for (let index = 0; index < 750; index++) node.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, pointerId: position.pointerId, clientX: position.x + index / 3, clientY: position.y, buttons: 1,
    }));
  }, { pointerId: after.pointer, x: start + 480, y: y + 15 });
  await page.mouse.up();
  const stroke = await page.evaluate(() => (window as unknown as { stroke: number[][] }).stroke);
  expect(stroke.length).toBeGreaterThan(350);
  expect(stroke.length).toBeLessThanOrEqual(700);
  expect(stroke.at(-1)?.[0]).toBeGreaterThan(700);
  const delays = after.delays.slice().sort((a, b) => a - b);
  const p95 = delays[Math.ceil(delays.length * 0.95) - 1];
  await writeFile(info.outputPath("canvas-render.json"), JSON.stringify({
    items: 1000, pointsPerItem: 20, samples: delays.length,
    pointerToStrokeCommandP95Ms: Math.round(p95 * 10) / 10,
    backgroundSegmentsWhileDrawing: after.backgroundSegments - before.backgroundSegments,
  }, null, 2));
});

test("带照片的画布反复打开 20 次后释放所有对象 URL", async ({ page }) => {
  await page.setContent('<button id="open">打开画布</button><button id="close">离开画布</button><div id="board"></div>');
  await page.evaluate(() => {
    const lifecycle = { opened: 0, live: new Set<string>() };
    Object.assign(window, { lifecycle });
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const address = create(blob);
      lifecycle.live.add(address);
      lifecycle.opened++;
      return address;
    };
    URL.revokeObjectURL = (address) => { lifecycle.live.delete(address); revoke(address); };
  });
  await mountPlayFixture(page, `
    const photo = { id: "photo", fileId: "fixture-photo", mime: "image/png", name: "合成照片", bytes: 82 };
    service.secrets = { spaceId: "fixture", userId: "test", deviceId: "test", personalKey: "",
      spaceKeys: {}, encryptionSecret: "", signingSecret: "" };
    service.entries = [{ id: "record", spaceId: "fixture", creatorId: "test", visibility: "shared",
      revision: 1, createdAt: 0, updatedAt: 0,
      data: { kind: "memory", title: "合成记录", date: "2026-01-01", photos: [photo] } }];
    const sample = document.createElement("canvas");
    sample.width = 5; sample.height = 5;
    sample.getContext("2d")!.fillRect(0, 0, 5, 5);
    const bytes = Uint8Array.from(atob(sample.toDataURL().split(",")[1]), (character) => character.charCodeAt(0));
    service.readPhotoBytes = async () => bytes;
    const objects: CanvasItem[] = [{ id: "object", kind: "photo", reference: { recordId: "record", fileId: photo.fileId },
      by: 0, x: 0, y: 0, angle: 0, version: 1, layer: 0, panel: 0 }];
    document.getElementById("open")!.onclick = () => root.render(<CanvasBoard service={service} objects={objects} paper="plain" label="照片画布" />);
    document.getElementById("close")!.onclick = () => root.render(null);
  `);
  const counts = () => page.evaluate(() => {
    const { opened, live } = (window as unknown as { lifecycle: { opened: number; live: Set<string> } }).lifecycle;
    return { opened, live: live.size };
  });
  for (let index = 1; index <= 20; index++) {
    await page.getByRole("button", { name: "打开画布" }).click();
    await expect.poll(counts).toEqual({ opened: index, live: 1 });
    await page.getByRole("button", { name: "离开画布" }).click();
    await expect.poll(counts).toEqual({ opened: index, live: 0 });
  }
});

test("移动宽度下两百件星球物件使用局部渲染和全图缩略", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent('<div class="playground"><section class="play-game" id="board"></section></div>');
  await page.addStyleTag({ path: "web/features/playground/playground.css" });
  await mountPlayFixture(page, `
    const kinds = ["lake", "mountain", "tree", "home", "monument", "light", "path", "flower"];
    let world = startScene("c17") as World;
    for (let index = 0; index < 200; index++) {
      world = applyScene(world, { type: "world.put", item: {
        key: index.toString(16).padStart(32, "0"), kind: kinds[(index + Math.floor(index / 20)) % kinds.length],
        x: index % 20, y: Math.floor(index / 20), angle: 0,
      } }, 0) as World;
    }
    root.render(<WorldLayout game={world} editable choose={(x, y) => {
      document.getElementById("board")!.dataset.chosen = x + "," + y;
    }} />);
  `);
  const stage = page.locator(".play-world-stage");
  const occupied = stage.locator("[data-kind]");
  const tile = (x: number, y: number) => stage.locator(`[data-cell="${x},${y}"]`);
  await expect(stage).toHaveAttribute("data-projection", "isometric");
  await expect(occupied).toHaveCount(100);
  await expect(tile(15, 5)).toHaveCount(0);
  const stageBox = (await stage.boundingBox())!;
  expect(stageBox.x + stageBox.width).toBeLessThanOrEqual(390);
  const geometry = await stage.locator(".play-world").evaluate((grid: HTMLElement) => {
    const stage = grid.parentElement!.getBoundingClientRect();
    const board = grid.getBoundingClientRect();
    return { square: Math.abs(grid.offsetWidth - grid.offsetHeight) <= 1,
      contained: board.left >= stage.left && board.right <= stage.right && board.top >= stage.top && board.bottom <= stage.bottom };
  });
  expect(geometry).toEqual({ square: true, contained: true });
  await tile(1, 0).tap();
  await expect(page.locator("#board")).toHaveAttribute("data-chosen", "1,0");
  await page.getByRole("button", { name: "地图右移" }).click();
  await page.getByRole("button", { name: "地图右移" }).click();
  await expect(tile(0, 0)).toHaveCount(0);
  await expect(tile(15, 5)).toBeVisible();
  await page.getByRole("button", { name: "看整个星球" }).click();
  await expect(stage).toHaveAttribute("data-projection", "overview");
  await expect(occupied).toHaveCount(200);
  await expect(stage.locator(".play-world-marker")).toHaveCount(0);
  await page.getByRole("button", { name: "查看局部" }).click();
  await expect(occupied).toHaveCount(100);
  await expect(tile(15, 5)).toBeVisible();
  await stage.screenshot({ path: info.outputPath("planet-200-items.png") });
  await page.getByRole("button", { name: "二维网格" }).click();
  await expect(stage).toHaveAttribute("data-projection", "flat");
  await tile(15, 5).press("Enter");
  await expect(page.locator("#board")).toHaveAttribute("data-chosen", "15,5");
});

test("一千条回忆可分页浏览，年度 PNG 绘制全年所有叶子", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`<div class="playground"><section class="play-game">
    <button id="one">一条</button><button id="hundred">一百条</button><button id="thousand">一千条</button><div id="board"></div>
  </section></div>`);
  await page.addStyleTag({ path: "web/features/playground/playground.css" });
  await mountPlayFixture(page, `
    const board = document.getElementById("board")!;
    service.secrets = { spaceId: "fixture", userId: "test", deviceId: "test", personalKey: "",
      spaceKeys: {}, encryptionSecret: "", signingSecret: "" };
    const entries: Entry[] = Array.from({ length: 1000 }, (_, index) => ({
      id: (index + 1).toString(16).padStart(32, "0"), spaceId: "fixture", creatorId: "test", visibility: "shared",
      revision: 1, createdAt: 1000 - index, updatedAt: 1000 - index,
      data: { kind: index % 31 === 0 ? "anniversary" : "memory", title: "合成回忆 " + (index + 1),
        date: "2024-" + String(12 - Math.floor(index / 90)).padStart(2, "0") + "-18" },
    }));
    const ellipse = CanvasRenderingContext2D.prototype.ellipse;
    let marks = 0;
    CanvasRenderingContext2D.prototype.ellipse = function (...args) {
      board.dataset.marks = String(++marks);
      ellipse.apply(this, args);
    };
    const show = (length: number) => {
      service.entries = entries.slice(0, length);
      root.render(<MemoryTreeEditor key={length} service={service} game={{ id: "w24", selected: service.entries.map((item) => item.id) }}
        submit={async () => true} disabled={false} openMemory={(entry) => { board.dataset.opened = entry.data.title; }} report={(failure) => { throw failure; }} />);
    };
    for (const [id, size] of [["one", 1], ["hundred", 100], ["thousand", 1000]] as const)
      document.getElementById(id)!.onclick = () => show(size);
    show(1);
  `);
  const leaves = page.getByRole("region", { name: "回忆树叶子" });
  const options = page.getByLabel("挑一条共同回忆").locator("option");
  await expect(leaves.locator("li")).toHaveCount(1);
  await expect(options).toHaveCount(2);
  await page.getByRole("button", { name: "一百条", exact: true }).click();
  await expect(page.getByText(/100 片叶子/)).toBeVisible();
  await expect(leaves.locator("li")).toHaveCount(30);
  await page.getByRole("button", { name: "一千条", exact: true }).click();
  await expect(page.getByText(/1000 片叶子/)).toBeVisible();
  await expect(leaves.locator("li")).toHaveCount(30);
  await expect(options).toHaveCount(31);
  await leaves.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(leaves.getByRole("button", { name: "合成回忆 31", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "只显示列表" }).click();
  await expect(leaves.getByRole("group")).toHaveCount(0);
  await leaves.getByRole("button", { name: /合成回忆 31$/ }).click();
  await expect(page.locator("#board")).toHaveAttribute("data-opened", "合成回忆 31");
  await page.getByLabel("搜索共同回忆").fill("合成回忆 1000");
  await expect(options).toHaveCount(2);
  await expect(options.last()).toContainText("合成回忆 1000");
  await page.getByLabel("年份", { exact: true }).selectOption("2024");
  const download = page.waitForEvent("download");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "导出树图 PNG" }).click();
  const exported = await download;
  await expect(page.locator("#board")).toHaveAttribute("data-marks", "1000");
  expect(exported.suggestedFilename()).toBe("Us-回忆树-2024.png");
  expect((await readFile(await exported.path())).subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
  await exported.saveAs(info.outputPath("tree-1000-leaves.png"));
});

test("窄屏星图支持触屏拖动，并且抬手才提交一次坐标", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.setContent('<div class="playground"><section class="play-game" id="board"></section></div>');
  await page.addStyleTag({ path: "web/features/playground/playground.css" });
  await mountPlayFixture(page, `
    service.entries = [{ id: "a".repeat(32), spaceId: "fixture", creatorId: "test", visibility: "shared", revision: 1, createdAt: 0, updatedAt: 0,
      data: { kind: "memory", date: "2024-05-12", title: "合成照片", photos: ["b", "c"].map((id) => ({ id, fileId: id.repeat(32), name: "照片", mime: "image/png" })) } }];
    let commits = 0;
    root.render(<StarMap service={service} game={{ id: "c18", stars: ["b", "c"].map((id) => ({ photo: { recordId: "a".repeat(32), fileId: id.repeat(32) }, x: 25, y: 40 })),
      lines: [], name: "触控星图", story: "" }} selected={"b".repeat(32)} choose={() => {}} move={(id, point, from) => {
      Object.assign(document.getElementById("board")!.dataset, { commits: ++commits, x: point.x, y: point.y, from: from.x, moved: id });
    }} />);
  `);
  const point = page.getByRole("button", { name: "选择星点 1" });
  await expect(point).toBeVisible();
  const box = (await point.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const touch = await context.newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 65, y: y + 25 }] });
  await expect(point).not.toHaveAttribute("style", /left: 25%/);
  await expect(page.locator("#board")).not.toHaveAttribute("data-commits", "1");
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator("#board")).toHaveAttribute("data-commits", "1");
  await expect(page.locator("#board")).toHaveAttribute("data-from", "25");
  await expect(page.locator("#board")).toHaveAttribute("data-moved", "b".repeat(32));
});

test("星际摇杆持续发送单格移动，抬手后停止", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  const style = await readFile("web/features/playground/playground.css", "utf8");
  await page.setContent(`<style>${style}</style><div id="board"></div>`);
  await mountPlayFixture(page, `
    let steps = 0;
    root.render(<FlightJoystick disabled={false} move={([x, y]) => {
      Object.assign(document.getElementById("board")!.dataset, { steps: ++steps, delta: [x, y].join(",") });
    }} />);
  `);
  const stick = page.getByRole("group", { name: "移动摇杆" });
  await expect(stick).toHaveCSS("touch-action", "none");
  const box = (await stick.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const touch = await context.newCDPSession(page);
  const board = page.locator("#board");
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await expect(board).not.toHaveAttribute("data-steps", /\d/);
  await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 30, y }] });
  await expect(board).toHaveAttribute("data-delta", "1,0");
  await expect.poll(() => board.getAttribute("data-steps").then(Number)).toBeGreaterThanOrEqual(2);
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(stick.locator("span")).toHaveAttribute("style", /translate\(0px, 0px\)/);
  const steps = await board.getAttribute("data-steps");
  await page.clock.runFor(400);
  expect(await board.getAttribute("data-steps")).toBe(steps);
});
