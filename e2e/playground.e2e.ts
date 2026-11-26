import { chromium, firefox, webkit, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { downloadVault, signIn, startReleaseFixture, type VaultBackup } from "./release-fixture";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { activityIds } from "../src/features/play-core/catalog";

function launchPlayBrowser(certificatePin: string) {
  switch (process.env.US_PLAY_TEST_BROWSER) {
    case "firefox": return firefox.launch();
    case "webkit": return webkit.launch();
    default: return chromium.launch({ channel: process.env.US_WEB_BROWSER_CHANNEL,
      args: ["--ignore-certificate-errors-spki-list=" + certificatePin] });
  }
}

async function openActivity(a: Page, b: Page, origin: string, path: string, title: string) {
  await a.goto(origin + path);
  if (path.endsWith("/c19")) await a.getByLabel("故事标题").fill(title);
  else await a.getByLabel("房间名称").fill(title);
  await a.getByRole("button", { name: "创建双人房间" }).click();
  await expect(a).toHaveURL(/\/app\/play\/rooms\/[a-f0-9]{32}$/);
  await b.goto(a.url());
  await expect(b.getByRole("heading", { name: title, exact: true }).first()).toBeVisible();
}

async function pair(a: Page, b: Page, origin: string, accounts: { first: string; second: string }) {
  await signIn(a, origin, "first", accounts.first);
  await a.getByRole("button", { name: "创建双人空间", exact: true }).click();
  await a.getByLabel("给我们的空间起个名字").fill("双人游乐园验收空间");
  await a.getByLabel("本机解锁口令").fill("first test unlock phrase");
  await a.getByRole("button", { name: "创建我们的空间" }).click();
  await a.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await a.goto(origin + "/app/settings/devices");
  await a.getByRole("button", { name: "生成一次性邀请码" }).click();
  await expect(a.locator(".invitation")).not.toBeEmpty();
  const token = (await a.locator(".invitation").innerText()).trim();
  const codeA = (await a.locator(".safety-code").innerText()).trim();
  await signIn(b, origin, "second", accounts.second);
  await b.getByRole("button", { name: "输入邀请码加入" }).click();
  await b.getByLabel("一次性邀请码").fill(token);
  await b.getByLabel("本机解锁口令").fill("second test unlock phrase");
  await b.getByRole("button", { name: "加入双人空间", exact: true }).click();
  const codeB = await b.getByLabel("我的设备安全码").inputValue();
  await a.getByRole("button", { name: "刷新设备列表" }).click();
  await a.getByLabel("对方的设备安全码").fill(codeB);
  await a.getByRole("button", { name: "发送空间密钥" }).click();
  await a.getByLabel("重新输入网站密码").fill(accounts.first);
  await a.getByRole("button", { name: "验证并继续" }).click();
  await expect(a.getByRole("status")).toHaveText("空间密钥已发送");
  await b.getByLabel("对方的设备安全码").fill(codeA);
  await b.getByRole("button", { name: "接收空间密钥" }).click();
  await b.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
}

function rejectedUpgrade(url: string, origin: string, certificate: string) {
  return new Promise<number | undefined>((resolve, reject) => {
    const socket = new WebSocket(url, { origin, ca: certificate, handshakeTimeout: 5000 });
    socket.on("error", reject);
    socket.once("unexpected-response", (_, response) => {
      response.resume();
      resolve(response.statusCode);
      socket.close();
    });
    socket.once("open", () => { socket.close(); reject(new Error("Unexpected unverified room connection")); });
  });
}

async function restoreVault(page: Page, origin: string, name: string, password: string, backup: VaultBackup) {
  await signIn(page, origin, name, password);
  await page.getByRole("button", { name: "使用备份恢复", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("加密备份 JSON").setInputFiles({ name: "fixture-vault.json", mimeType: "application/json", buffer: backup.file });
  await dialog.getByLabel("64 位恢复密钥").fill(backup.key);
  await dialog.getByLabel("新的本机解锁口令").fill(`${name} recovered vault unlock phrase`);
  await dialog.getByRole("button", { name: "验证并恢复备份" }).click();
  await expect(dialog).toHaveCount(0);
}

async function openWorkPrintView(page: Page) {
  await page.evaluate(() => { window.print = () => { document.documentElement.dataset.printRequested = "yes"; }; });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "打印或另存 PDF" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-print-requested", "yes");
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("heading", { name: "管理作品" })).toHaveCount(0);
}

async function takeExport(site: Page, label: string) {
  site.once("dialog", (dialog) => void dialog.accept());
  const download = site.waitForEvent("download");
  await site.getByRole("button", { name: label, exact: true }).click();
  return readFile(await (await download).path());
}

test("两位成员经 HTTPS 玩六种错峰玩法，断网补发并收藏同一份作品", async ({}, info) => {
  test.setTimeout(240000);
  const fixture = await startReleaseFixture("playground,async_games,shared_canvas");
  const { origin, accounts, certificatePin } = fixture;
  const contexts: BrowserContext[] = [];
  const browser = await launchPlayBrowser(certificatePin);
  try {
    const aContext = await browser.newContext({ viewport: { width: 1280, height: 840 }, ignoreHTTPSErrors: true });
    const bContext = await browser.newContext({ viewport: { width: 360, height: 820 }, ignoreHTTPSErrors: true });
    const guest = await browser.newContext({ ignoreHTTPSErrors: true });
    contexts.push(aContext, bContext, guest);
    const a = await aContext.newPage();
    const b = await bContext.newPage();
    const outsider = await guest.newPage();

    await pair(a, b, origin, accounts);

    await a.goto(origin + "/app/play");
    await expect(a.getByRole("heading", { name: "双人游乐园", exact: true })).toBeVisible();
    await a.screenshot({ path: info.outputPath("playground-desktop.png") });
    await openActivity(a, b, origin, "/app/play/games/g05", "湖边棋局");
    const chessUrl = a.url();
    await outsider.goto(chessUrl);
    await expect(outsider.getByLabel("网站账号")).toBeVisible();
    await expect(outsider.getByText("湖边棋局")).toHaveCount(0);
    for (const player of [a, b]) await player.getByText("房间保留设置", { exact: true }).click();
    await a.getByRole("button", { name: "同意闲置 30 天后清理" }).click();
    await expect(b.getByText(/已有一人确认/)).toBeVisible();
    await b.getByRole("button", { name: "同意闲置 30 天后清理" }).click();
    await expect(a.getByText(/预计于.*清理/)).toBeVisible();
    await expect(a.getByRole("button", { name: "再保留 30 天" })).toBeVisible();
    await b.getByRole("button", { name: "改为持续保留" }).click();
    await expect(a.getByRole("button", { name: "同意闲置 30 天后清理" })).toBeVisible();
    for (const player of [a, b]) await player.getByText("房间保留设置", { exact: true }).click();
    await a.getByRole("button", { name: "H8 空位" }).click();
    await expect(b.getByRole("button", { name: "H8 黑棋" })).toBeVisible();
    await aContext.setOffline(true);
    await b.getByRole("button", { name: "H9 空位" }).click();
    await expect(b.getByRole("button", { name: "H9 白棋" })).toBeVisible();
    await aContext.setOffline(false);
    await a.getByRole("button", { name: "刷新进度" }).click();
    await expect(a.getByRole("button", { name: "H9 白棋" })).toBeVisible();
    await aContext.setOffline(true);
    await a.getByRole("button", { name: "I8 空位" }).click();
    await expect(a.getByText("有一条加密操作待确认。")).toBeVisible();
    await aContext.setOffline(false);
    await expect(b.getByRole("button", { name: "I8 黑棋" })).toBeVisible();
    await a.getByRole("button", { name: "申请悔棋" }).click();
    await b.getByRole("button", { name: "同意悔棋" }).click();
    await expect(a.getByRole("button", { name: "I8 空位" })).toBeVisible();
    await b.screenshot({ path: info.outputPath("gomoku-mobile.png") });
    await a.getByRole("button", { name: "确认结束活动" }).click();
    await b.getByRole("button", { name: "确认结束活动" }).click();
    await expect(b.getByText(/房间保留至.*已收藏的作品会继续保留/)).toBeVisible();
    await a.getByRole("button", { name: "放入共同作品馆" }).click();
    await expect(a).toHaveURL(/\/app\/play\/works\/[a-f0-9]{32}$/);
    await b.goto(a.url());
    await expect(b.getByRole("heading", { name: "湖边棋局" })).toBeVisible();
    await expect(b.getByText("● H8 · ○ H9")).toBeVisible();
    a.once("dialog", (dialog) => void dialog.accept());
    await a.getByRole("button", { name: "加入共同日记" }).click();
    await a.getByRole("button", { name: "打开关联作品" }).click();
    await expect(a.getByRole("heading", { name: "湖边棋局", exact: true })).toBeVisible();

    await openActivity(a, b, origin, "/app/play/create/c19", "雨后车站");
    const paragraph = "晚班车过了河，灯光落在玻璃上。我们还没来得及打开车窗，雨点先一路追了过来。".repeat(5);
    await a.getByLabel("本章正文").fill(paragraph);
    await a.reload();
    await expect(a.getByLabel("本章正文")).toHaveValue(paragraph);
    await a.getByLabel("章节标题").fill("车窗");
    await a.getByRole("button", { name: "交给对方" }).click();
    await expect(b.getByRole("heading", { name: "车窗" })).toBeVisible();
    await b.getByRole("button", { name: "确认上一章" }).click();
    await b.getByLabel("章节标题").fill("雨停");
    await b.getByLabel("本章正文").fill(paragraph + "雨停了。");
    await b.getByRole("button", { name: "交给对方" }).click();
    await a.getByRole("button", { name: "确认上一章" }).click();
    await a.getByRole("button", { name: "只为自己收藏" }).click();
    await expect(a).toHaveURL(/\/app\/play\/works\//);
    await b.goto(a.url());
    await expect(b.getByRole("alert")).toContainText("不可访问");

    await openActivity(a, b, origin, "/app/play/games/g03", "同一场雨");
    await a.getByLabel("我的答案").fill("晴天和旧车票");
    await a.getByRole("button", { name: "提交答案" }).click();
    await expect(b.getByText("晴天和旧车票")).toHaveCount(0);
    await b.getByLabel("我的答案").fill("雨停以后吃包子");
    await b.getByRole("button", { name: "提交答案" }).click();
    await expect(a.getByText("雨停以后吃包子")).toBeVisible();

    await openActivity(a, b, origin, "/app/play/games/g06", "甜点猜题");
    await a.getByLabel("关于我的问题").fill("最近最喜欢哪种甜点？");
    await a.getByLabel("谜底").fill("红豆蛋糕");
    await a.getByRole("button", { name: "发布题目" }).click();
    await b.getByLabel("我的猜测").fill("红豆面包");
    await b.getByRole("button", { name: "提交猜测" }).click();
    await expect(b.getByText(/红豆蛋糕/)).toHaveCount(0);
    await a.getByRole("button", { name: "揭晓谜底" }).click();
    await expect(b.getByText(/红豆蛋糕/)).toBeVisible();
    await b.getByRole("button", { name: "交换角色" }).click();
    await expect(b.getByLabel("关于我的问题")).toBeVisible();

    await openActivity(a, b, origin, "/app/play/games/g07", "表情猜故事");
    for (const symbol of ["🌈", "☔", "🚲"]) await a.getByRole("button", { name: symbol, exact: true }).click();
    await a.getByLabel("谜底").fill("一起在雨后骑车");
    await a.getByRole("button", { name: "发布题目" }).click();
    await b.getByLabel("我的猜测").fill("雨后骑车");
    await b.getByRole("button", { name: "提交猜测" }).click();
    await a.getByRole("button", { name: "揭晓谜底" }).click();
    await expect(b.getByText(/一起在雨后骑车/)).toBeVisible();

    await openActivity(a, b, origin, "/app/play/games/g09", "一个小礼物");
    await a.getByLabel("盲盒类型").selectOption("task");
    await a.getByLabel("我准备的小惊喜").fill("去公园一起看云");
    await a.getByRole("button", { name: "放进盲盒" }).click();
    await expect(b.getByText(/去公园一起看云/)).toHaveCount(0);
    await b.getByRole("button", { name: "拆开盲盒" }).click();
    await expect(b.getByText(/去公园一起看云/)).toBeVisible();
    await b.getByRole("button", { name: "这次先跳过" }).click();
    await expect(a.getByText("对方选择跳过")).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await browser.close();
    await fixture.close();
  }
});

test("同源 WSS 实时笔迹、断线重连、PNG 导出与双端场景和照片素材", async ({}, info) => {
  test.setTimeout(240000);
  const fixture = await startReleaseFixture("playground,async_games,shared_canvas,realtime_games,creative_worlds");
  const { origin, accounts, certificatePin } = fixture;
  const browser = await launchPlayBrowser(certificatePin);
  const aContext = await browser.newContext({ viewport: { width: 1280, height: 850 }, ignoreHTTPSErrors: true });
  const bContext = await browser.newContext({ viewport: { width: 360, height: 820 }, ignoreHTTPSErrors: true });
  try {
    const a = await aContext.newPage(), b = await bContext.newPage();
    await pair(a, b, origin, accounts);
    await openActivity(a, b, origin, "/app/play/create/c15", "共同画布验收");
    const connection = origin.replace(/^https:/, "wss:") + "/ws/play?room=" + new URL(a.url()).pathname.split("/").at(-1);
    expect(await rejectedUpgrade(connection, origin, fixture.certificate)).toBe(401);
    expect(await rejectedUpgrade(connection, "https://another.example", fixture.certificate)).toBe(403);
    await b.getByRole("button", { name: "我准备好了" }).click();
    await expect(a.getByText("实时连接已就绪")).toBeVisible();
    await expect(b.getByText("实时连接已就绪")).toBeVisible();
    const cursorToggle = b.getByRole("button", { name: "显示搭档光标" });
    await expect(cursorToggle).toHaveAttribute("aria-pressed", "false");
    await cursorToggle.click();
    const draw = a.getByLabel("双人画布");
    await draw.scrollIntoViewIfNeeded();
    const bounds = (await draw.boundingBox())!;
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    await a.mouse.move(x - 30, y - 12);
    await a.mouse.down();
    await a.mouse.move(x + 30, y + 12, { steps: 9 });
    const colored = () => b.getByLabel("双人画布").evaluate((value: HTMLCanvasElement) => {
      const pixels = value.getContext("2d")!.getImageData(0, 0, value.width, value.height).data;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 90 && pixels[i + 1] < 85 && pixels[i + 2] < 80) return true;
      return false;
    });
    const partnerCursor = () => b.getByLabel("双人画布").evaluate((value: HTMLCanvasElement) => {
      const pixels = value.getContext("2d")!.getImageData(0, 0, value.width, value.height).data;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 23 && pixels[i + 1] === 106 && pixels[i + 2] === 119) return true;
      return false;
    });
    await expect.poll(partnerCursor, { intervals: [25, 50, 100] }).toBe(true);
    await expect.poll(colored).toBe(true);
    await a.mouse.up();
    await expect.poll(partnerCursor).toBe(false);
    await expect.poll(colored).toBe(true);
    await b.getByText("浏览与编辑物件").click();
    await expect(b.getByLabel("画面物件").locator("option")).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      await a.mouse.move(x - 25 + i * 15, y - 28);
      await a.mouse.down();
      await a.mouse.move(x - 25 + i * 15, y + 30, { steps: 2 });
      await a.mouse.up();
    }
    await expect(b.getByLabel("画面物件").locator("option")).toHaveCount(4);
    await a.getByRole("button", { name: "框选物件" }).click();
    await draw.scrollIntoViewIfNeeded();
    const selection = (await draw.boundingBox())!;
    const center = { x: selection.x + selection.width / 2, y: selection.y + selection.height / 2 };
    await a.mouse.move(center.x - 40, center.y - 40);
    await a.mouse.down();
    await a.mouse.move(center.x + 40, center.y + 40, { steps: 8 });
    await a.mouse.up();
    await expect(a.getByText("已选中 3 件物件")).toBeVisible();
    await a.getByRole("button", { name: "组合所选物件" }).click();
    await expect(b.getByLabel("画面物件").locator("option")).toHaveCount(5);
    await b.screenshot({ path: info.outputPath("canvas-mobile.png") });

    fixture.setNetworkAvailable(false);
    await b.getByText("加入物件").click();
    await b.getByLabel("要写的字").fill("断线时的小便签");
    await b.getByRole("button", { name: "放到画面中央" }).click();
    await expect(b.getByText("有一条加密操作待确认。")).toBeVisible();
    fixture.setNetworkAvailable(true);
    await a.getByText("浏览与编辑物件").click();
    await expect(a.getByLabel("画面物件").locator("option")).toContainText(["请选择", "笔迹", "笔迹", "笔迹", "组合", "断线时的小便签"], { timeout: 24000 });
    await a.getByRole("searchbox", { name: "搜索物件" }).fill("小便签");
    await expect(a.getByLabel("画面物件").locator("option")).toHaveCount(2);
    await expect(a.getByLabel("画面物件").locator("option").last()).toContainText("断线时的小便签");
    await a.getByRole("button", { name: "确认收藏当前版本" }).click();
    await b.getByRole("button", { name: "确认收藏当前版本" }).click();
    await expect(b.getByText(/实时房间 · 可以继续/)).toBeVisible();
    await a.getByRole("button", { name: "放入共同作品馆" }).click();
    await expect(a.getByRole("button", { name: "导出 PNG" })).toBeVisible();
    a.once("dialog", (dialog) => void dialog.accept());
    const image = a.waitForEvent("download");
    await a.getByRole("button", { name: "导出 PNG" }).click();
    expect((await readFile((await (await image).path())!)).subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));

    await openActivity(a, b, origin, "/app/play/games/g11", "异步验证密室");
    await b.getByRole("button", { name: "我准备好了" }).click();
    await expect(b.getByText(/柜号是 304/)).toBeVisible();
    await expect(a.getByText(/柜号是 304/)).toHaveCount(0);
    await b.getByRole("button", { name: /^投递箱/ }).press("Enter");
    await expect(b.getByRole("region", { name: "投递箱细节" })).toBeVisible();
    await expect(b.getByLabel("投递箱密码")).toHaveCount(0);
    await a.getByLabel("寄信匣密码").fill("304");
    await a.getByRole("button", { name: "试试这组密码" }).click();
    await expect(b.getByLabel("投递箱密码")).toBeVisible();
    await b.getByLabel("投递箱密码").fill("moon");
    await b.getByRole("button", { name: "试试这组密码" }).click();
    await expect(a.getByText(/已解开 2 \/ 6/)).toBeVisible();
    await a.reload();
    await expect(a.getByText(/已解开 2 \/ 6/)).toBeVisible();
    for (const [site, name, code] of [[a, "号码轮", "572"], [b, "归档门", "26"],
      [a, "油灯柜", "gold"], [b, "夜班出口", "831"]] as const) {
      await site.getByLabel(name + "密码").fill(code);
      await site.getByRole("button", { name: "试试这组密码" }).click();
    }
    await expect(a.locator(".play-escape-postcard").getByRole("heading", { name: "深夜邮局" })).toBeVisible();
    await expect(b.locator(".play-escape-postcard").getByRole("heading", { name: "深夜邮局" })).toBeVisible();
    expect((await takeExport(a, "导出通关明信片")).subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));

    await a.goto(origin + "/app/memories/new");
    await a.getByLabel("这一页的小标题").fill("星球纪念照片");
    await a.getByLabel("添加照片").setInputFiles(resolve("public/assets/journal-lake.jpg"));
    await expect(a.getByRole("img", { name: "journal-lake.jpg" })).toBeVisible();
    await a.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(a.getByRole("dialog")).toHaveCount(0);
    await openActivity(a, b, origin, "/app/play/world/planet", "给星球种一棵树");
    const planetRoom = a.url();
    const scenery = (site: Page) => site.locator(".play-world-stage");
    const cell = (site: Page, x: number, y: number, name: string) =>
      site.getByRole("button", { name: `第 ${x} 列，第 ${y} 行，${name}`, exact: true });
    await expect(scenery(a)).toHaveAttribute("data-projection", "isometric");
    await expect(scenery(b)).toHaveAttribute("data-projection", "isometric");
    await expect(b.getByRole("option", { name: "星灯", exact: true })).toHaveCount(0);
    await a.getByRole("button", { name: "领取观星装饰" }).click();
    await expect(b.getByRole("option", { name: "星灯", exact: true })).toHaveCount(1);
    await a.getByLabel("物件", { exact: true }).selectOption("tree");
    await a.getByLabel("关联共同回忆").selectOption({ label: "星球纪念照片" });
    await a.getByLabel("关联回忆中的照片").selectOption({ label: "journal-lake.jpg" });
    await a.getByRole("button", { name: "把物件放在这里" }).click();
    await expect(cell(b, 1, 1, "树木")).toBeVisible();
    await expect(scenery(b).locator("[data-cell]").first()).toHaveAttribute("data-cell", "0,0");
    await b.getByRole("button", { name: "转个方向" }).click();
    await expect(scenery(b).locator("[data-cell]").first()).toHaveAttribute("data-cell", "0,9");
    await cell(b, 1, 1, "树木").click();
    await expect(b.getByAltText("物件关联的照片")).toBeVisible();
    await b.getByRole("button", { name: "二维网格" }).click();
    await expect(scenery(b)).toHaveAttribute("data-projection", "flat");
    await b.getByRole("button", { name: "移动物件" }).click();
    fixture.setNetworkAvailable(false);
    await cell(b, 2, 1, "空地").click();
    await expect(b.getByText("有一条加密操作待确认。")).toBeVisible();
    fixture.setNetworkAvailable(true);
    await expect(cell(a, 2, 1, "树木")).toBeVisible({ timeout: 15000 });
    await expect(b.getByAltText("物件关联的照片")).toBeVisible();
    await a.getByLabel("关联共同回忆").selectOption("");
    await a.getByLabel("物件", { exact: true }).selectOption("lake");
    await cell(a, 2, 1, "树木").click();
    await a.getByRole("button", { name: "把物件放在这里" }).click();
    await expect(a.getByRole("alert")).toContainText("已有物件");
    const furnishings = [[5, 5, "lake", "湖泊"], [6, 5, "lake", "湖泊"], [7, 5, "home", "房屋"],
      [5, 6, "mountain", "山丘"], [6, 6, "star-light", "星灯"], [7, 6, "moon-garden", "月牙花坛"]] as const;
    for (const [x, y, kind, label] of furnishings) {
      await cell(a, x, y, "空地").press("Space");
      await a.getByLabel("物件", { exact: true }).selectOption(kind);
      await a.getByRole("button", { name: "把物件放在这里" }).click();
      await expect(cell(a, x, y, label)).toBeVisible();
    }
    await a.getByRole("button", { name: "看整个星球" }).click();
    await expect(scenery(a)).toHaveAttribute("data-projection", "overview");
    await expect(scenery(a).locator("[data-cell]")).toHaveCount(400);
    await a.getByRole("button", { name: "查看局部" }).click();
    await expect(scenery(a).locator("[data-cell]")).toHaveCount(100);
    await b.getByRole("button", { name: "二维网格" }).click();
    await expect(cell(b, 6, 6, "星灯")).toBeVisible();
    await scenery(a).screenshot({ path: info.outputPath("planet-isometric-desktop.png") });
    await scenery(b).screenshot({ path: info.outputPath("planet-isometric-mobile.png") });
    await b.getByText("房间设置", { exact: true }).click();
    await b.getByLabel(/使用二维地图/).check();
    await expect(scenery(b)).toHaveAttribute("data-projection", "flat");
    await b.getByLabel(/使用二维地图/).uncheck();
    await expect(scenery(b)).toHaveAttribute("data-projection", "isometric");
    await a.getByRole("button", { name: "确认收藏当前版本" }).click();
    await b.getByRole("button", { name: "确认收藏当前版本" }).click();
    await a.getByRole("button", { name: "放入共同作品馆" }).click();
    await expect(a).toHaveURL(/\/app\/play\/works\/[a-f0-9]{32}$/);
    const planetWork = a.url();
    await a.getByRole("button", { name: "打开回忆 · 星球纪念照片" }).click();
    await a.getByRole("button", { name: "编辑这一页" }).click();
    await a.getByRole("button", { name: "移除照片" }).click();
    await a.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(a.getByRole("dialog")).toHaveCount(0);
    await b.goto(planetRoom);
    await cell(b, 2, 1, "树木").click();
    await expect(b.getByText("这张关联照片已移除。")).toBeVisible();
    await expect(b.getByRole("button", { name: "星球纪念照片", exact: true })).toBeVisible();
    await b.goto(planetWork);
    await expect(b.getByText("这条回忆或照片已移除。")).toBeVisible();

    await openActivity(a, b, origin, "/app/play/create/c21", "两扇窗的天空");
    await a.getByLabel("我拍的天空").setInputFiles(resolve("public/assets/journal-lake.jpg"));
    await a.getByLabel("留一句话").fill("湖边很安静");
    await a.getByRole("button", { name: "交给对方看" }).click();
    await expect(b.getByAltText("一边的天空")).toHaveCount(1);
    await b.getByLabel("我拍的天空").setInputFiles(resolve("public/assets/journal-flower.jpg"));
    await b.getByRole("button", { name: "交给对方看" }).click();
    await expect(a.getByAltText("一边的天空")).toHaveCount(2);
    await b.getByLabel("拼贴样式").selectOption("round");
    await expect(a.locator('.play-sky[data-layout="round"]')).toBeVisible();
    await a.screenshot({ path: info.outputPath("sky-postcard.png") });
  } finally {
    await aContext.close();
    await bContext.close();
    await browser.close();
    await fixture.close();
  }
});

test("照片、画猜、养成、协作关卡和共建世界均可从双端正常入口操作", async ({}, info) => {
  test.setTimeout(240000);
  const fixture = await startReleaseFixture("playground,async_games,shared_canvas,realtime_games,creative_worlds");
  const { origin, accounts, certificatePin } = fixture;
  const browser = await launchPlayBrowser(certificatePin);
  try {
    const a = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true })).newPage();
    const b = await (await browser.newContext({ viewport: { width: 390, height: 820 }, ignoreHTTPSErrors: true })).newPage();
    await pair(a, b, origin, accounts);
    await a.goto(origin + "/app/memories/new");
    await a.getByLabel("这一页的小标题").fill("给银河做的三张试验照片");
    await a.getByLabel("记录日期").fill("2024-05-12");
    await a.getByLabel("添加照片").setInputFiles([
      resolve("public/assets/journal-lake.jpg"), resolve("public/assets/journal-flower.jpg"), resolve("dist/assets/icon-512.png"),
    ]);
    await expect(a.getByRole("img", { name: "icon-512.png" })).toBeVisible();
    await a.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(a.getByRole("dialog")).toHaveCount(0);

    await openActivity(a, b, origin, "/app/play/games/g02", "还原一张照片");
    await a.getByLabel("拼图照片").selectOption({ index: 1 });
    await a.getByRole("button", { name: "开始拼图" }).click();
    const puzzle = b.locator(".play-photo-grid button");
    await expect(puzzle).toHaveCount(9);
    for (let i = 0; i < 9; i++) {
      if (await b.getByRole("heading", { name: "一起把照片拼回来了" }).isVisible()) break;
      const target = b.getByRole("button", { name: new RegExp("^拼块 " + (i + 1) + "，") });
      const current = b.locator(".play-photo-grid button").nth(i);
      const destination = await target.getAttribute("aria-label");
      if (destination?.endsWith("位置 " + (i + 1))) continue;
      await target.click();
      await current.click();
      await expect(b.getByRole("button", { name: "拼块 " + (i + 1) + "，位置 " + (i + 1) })
        .or(b.getByRole("heading", { name: "一起把照片拼回来了" }))).toBeVisible();
    }
    await expect(a.getByAltText("还原后的共同照片")).toBeVisible();

    await openActivity(a, b, origin, "/app/play/games/g10", "给旧照片猜日期");
    await a.getByLabel("题目照片").selectOption({ index: 1 });
    await a.getByRole("button", { name: "把照片设为题目" }).click();
    await expect(b.getByAltText("待竞猜的照片")).toBeVisible();
    await expect(b.getByText("给银河做的三张试验照片")).toHaveCount(0);
    await b.getByLabel("猜是什么时候").fill("2024-05");
    await b.getByRole("button", { name: "提交日期猜测" }).click();
    await a.getByRole("button", { name: "揭晓日期" }).click();
    await expect(b.getByRole("heading", { name: "猜中了！" })).toBeVisible();

    await openActivity(a, b, origin, "/app/play/games/g01", "三轮画猜");
    await b.getByRole("button", { name: "我准备好了" }).click();
    for (const [draw, guess, word] of [[a, b, "向日葵"], [b, a, "灯塔"], [a, b, "银河"]] as const) {
      await draw.getByLabel("自定义或从词库选题").fill(word);
      await draw.getByRole("button", { name: "开始画这一轮" }).click();
      await expect(guess.getByText("你要画的题目　" + word)).toHaveCount(0);
      await guess.getByLabel("我猜是").fill(word);
      await guess.getByRole("button", { name: "提交猜测" }).click();
      await expect(guess.getByRole("heading", { name: word + " · 猜对了！" })).toBeVisible();
      if (word !== "银河") await draw.getByRole("button", { name: "换人画下一轮" }).click();
    }

    await openActivity(a, b, origin, "/app/play/games/g08", "清掉一对图案");
    await b.getByRole("button", { name: "我准备好了" }).click();
    await a.getByRole("button", { name: "提示一对" }).click();
    await a.locator(".play-tiles [data-hint]").first().click();
    const first = a.locator(".play-tiles [aria-pressed=true]");
    const firstLabel = (await first.getAttribute("aria-label"))!;
    const index = Number(firstLabel.split(" ")[1]);
    await a.locator(".play-tiles button").nth(index % 2 === 1 ? index : index - 2).click();
    await expect(b.getByText(/1 \/ 24 对/)).toBeVisible();

    await openActivity(a, b, origin, "/app/play/world/garden", "一起种花");
    await a.getByRole("button", { name: "把种子种下" }).click();
    for (let i = 0; i < 6; i++) {
      const site = i % 2 ? b : a;
      await site.getByRole("button", { name: i % 2 ? "浇水" : "晒晒太阳" }).click();
      await expect(site.getByText(new RegExp("累计照料 " + (i + 1) + " 次"))).toBeVisible();
    }
    await expect(b.getByRole("heading", { name: /开花/ })).toBeVisible();
    await a.getByRole("button", { name: "确认收藏当前版本" }).click();
    await b.getByRole("button", { name: "确认收藏当前版本" }).click();
    await a.getByRole("button", { name: "放入共同作品馆" }).click();
    await expect(a).toHaveURL(/\/app\/play\/works\/[a-f0-9]{32}$/);
    const bloom = (site: Page) => site.getByRole("article", { name: "花朵纪念卡" });
    await expect(bloom(a)).toHaveText(/矢车菊.*这株花照料了 6 次/);
    await b.goto(a.url());
    await expect(bloom(b)).toHaveText(/矢车菊.*这株花照料了 6 次/);

    await openActivity(a, b, origin, "/app/play/create/c16", "合画一页漫画");
    await a.getByRole("button", { name: "认领这一格" }).click();
    await b.getByRole("button", { name: "分镜 2", exact: true }).click();
    await b.getByRole("button", { name: "认领这一格" }).click();
    await expect(a.getByRole("button", { name: /分镜 2 ·/ })).toBeVisible();
    await a.getByText("分镜文字和封面").click();
    await a.getByLabel("分镜标题").fill("第一扇窗");
    await a.getByRole("button", { name: "保存分镜标题" }).click();
    await expect(b.getByRole("button", { name: /第一扇窗/ })).toBeVisible();
    const addComicItem = a.getByText("加入物件", { exact: true });
    await expect(addComicItem).toHaveCount(1);
    await addComicItem.click();
    await a.getByLabel("物件类型").selectOption("bubble");
    await a.getByLabel("要写的字").fill("雨要停了，一起去看花吧。");
    await a.getByRole("button", { name: "放到画面中央" }).click();
    await expect(a.getByLabel("要写的字")).toHaveValue("");
    await a.getByRole("button", { name: "只为自己收藏" }).click();
    await expect(a.locator(".play-comic canvas")).toHaveCount(4);
    expect(JSON.parse((await takeExport(a, "导出 JSON")).toString("utf8"))).toMatchObject({ cover: { kind: "canvas", panel: 0 } });
    await openWorkPrintView(a);
    await expect(a.getByText("雨要停了，一起去看花吧。", { exact: true })).toBeVisible();
    if (browser.browserType().name() === "chromium") {
      const pdf = await a.pdf({ path: info.outputPath("comic-print.pdf"), format: "A4", printBackground: true });
      expect(pdf.toString("ascii", 0, 5)).toBe("%PDF-");
    }
    await a.emulateMedia({ media: "screen" });
    await Promise.all([a, b].map((site) => site.goto(origin + "/app/play/gallery")));
    const comicCard = a.getByRole("link", { name: /合画一页漫画/ });
    await expect(comicCard.locator(".play-work-cover canvas")).toBeVisible();
    await expect(b.getByRole("link", { name: /一起种花/ })).toBeVisible();
    await expect(b.getByRole("link", { name: /合画一页漫画/ })).toHaveCount(0);

    await openActivity(a, b, origin, "/app/play/create/c18", "把银河连起来");
    for (let i = 0; i < 3; i++) {
      await a.getByLabel("从银河选星").selectOption({ index: 1 });
      await a.getByRole("button", { name: "摘下这颗星" }).click();
      await expect(a.getByText(new RegExp((i + 1) + " / 20 颗星"))).toBeVisible();
    }
    await a.getByLabel("星座名称").fill("三颗灯");
    await a.getByRole("button", { name: "保存星座名称与故事" }).click();
    await expect(b.getByRole("group", { name: "三颗灯" })).toBeVisible();

    await openActivity(a, b, origin, "/app/play/create/c20", "一首歌的卡片");
    await a.getByLabel("歌曲名").fill("星空来信");
    await a.getByLabel("演唱者").fill("合成乐手");
    await a.getByRole("button", { name: "保存我的音乐卡片" }).click();
    await expect(b.getByRole("heading", { name: "星空来信" })).toBeVisible();

    await openActivity(a, b, origin, "/app/play/create/c22", "把愿望放到地图上");
    await a.getByText("加入物件").click();
    await a.getByLabel("要写的字").fill("冬天去看海");
    await a.getByRole("button", { name: "放到画面中央" }).click();
    await a.getByLabel("物件类型").selectOption("sticker");
    await a.getByRole("combobox", { name: /^贴纸/ }).selectOption({ label: "矢车菊 💠" });
    await a.getByRole("button", { name: "放到画面中央" }).click();
    await b.getByText("浏览与编辑物件").click();
    await expect(b.getByLabel("画面物件").locator("option")).toContainText(["请选择", "冬天去看海", "贴纸 💠"]);

    await openActivity(a, b, origin, "/app/play/world/house", "给糯米布置小屋");
    await a.getByLabel("物件", { exact: true }).selectOption("fridge");
    await a.getByRole("button", { name: "把物件放在这里" }).click();
    await a.getByRole("button", { name: "第 2 列，第 1 行，空地" }).click();
    await a.getByLabel("物件", { exact: true }).selectOption({ label: "矢车菊盆栽" });
    await a.getByRole("button", { name: "把物件放在这里" }).click();
    await expect(b.getByRole("button", { name: "第 2 列，第 1 行，矢车菊盆栽" })).toBeVisible();
    await b.getByRole("button", { name: "第 1 列，第 1 行，冰箱" }).click();
    await expect(b.getByRole("link", { name: "今天吃什么", exact: true })).toHaveAttribute("href", "/app/play/food");

    await openActivity(a, b, origin, "/app/play/world/w24", "给树添一片叶子");
    await a.getByLabel("挑一条共同回忆").selectOption({ index: 1 });
    await a.getByRole("button", { name: "把回忆挂到树上" }).click();
    await expect(b.getByText("1 片叶子", { exact: false })).toBeVisible();
    await b.screenshot({ path: info.outputPath("memory-tree-mobile.png") });

    await openActivity(a, b, origin, "/app/play/games/g04", "开一张厨房订单");
    await b.getByRole("button", { name: "我准备好了" }).click();
    await a.getByRole("button", { name: "开始备菜" }).click();
    await expect(b.getByRole("heading", { name: "番茄炒蛋" })).toBeVisible();
    await expect(b.getByText(/你负责烹饪/)).toBeVisible();

    for (const [path, title] of [["/app/play/games/g12", "踏上第一颗星"], ["/app/play/games/g13", "光和影一起出发"]] as const) {
      await openActivity(a, b, origin, path, title);
      await b.getByRole("button", { name: "我准备好了" }).click();
      await a.getByRole("button", { name: "右移", exact: true }).click();
      await expect(a.getByText(/位置 3, 2/)).toBeVisible();
      await b.getByRole("button", { name: "右移", exact: true }).click();
      await expect(b.getByText(/位置 3, /)).toBeVisible();
    }
    let visible = 0;
    for (const section of ["games", "create", "world"]) {
      await a.goto(origin + "/app/play/" + section);
      await expect(a.getByRole("navigation", { name: "游乐园分区" })).toBeVisible();
      visible += await a.locator(".play-area-grid .play-area").count();
    }
    expect(visible).toBe(activityIds.length);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("画猜同步橡皮操作，画者回房后自动揭晓猜中与超时结果", async () => {
  test.setTimeout(120000);
  const fixture = await startReleaseFixture("playground,shared_canvas,realtime_games");
  const { origin, accounts, certificatePin } = fixture;
  const browser = await launchPlayBrowser(certificatePin);
  try {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, ignoreHTTPSErrors: true });
    const a = await phone.newPage();
    const b = await (await browser.newContext({ viewport: { width: 1260, height: 860 }, ignoreHTTPSErrors: true })).newPage();
    await Promise.all([a.clock.install(), b.clock.install()]);
    await pair(a, b, origin, accounts);
    await a.goto(origin + "/app/memories/new");
    await a.getByLabel("这一页的小标题").fill("共同词库试验");
    await a.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(a.getByRole("dialog")).toHaveCount(0);
    await openActivity(a, b, origin, "/app/play/games/g01", "笔迹擦除与重连画猜");
    const room = a.url();
    await b.getByRole("button", { name: "我准备好了" }).click();
    const bank = a.getByRole("combobox", { name: /^题库/ });
    await expect(bank).toHaveValue("public");
    await expect(a.locator("#play-words option[value='共同词库试验']")).toHaveCount(0);
    await bank.selectOption("shared");
    await expect(a.locator("#play-words option[value='共同词库试验']")).toHaveCount(1);
    await bank.selectOption("public");
    await a.getByLabel("自定义或从词库选题").fill("Moon");
    await a.getByRole("button", { name: "开始画这一轮" }).click();
    await expect(b.getByLabel("我猜是")).toBeVisible();
    await expect(b.getByText("你要画的题目　Moon")).toHaveCount(0);
    await expect(b.getByRole("button", { name: "橡皮" })).toHaveCount(0);

    const items = (site: Page) => site.getByLabel("画面物件").locator("option");
    const pending = a.getByText("有一条加密操作待确认。");
    const ready = a.getByText("实时连接已就绪");
    for (const site of [a, b]) await site.getByText("浏览与编辑物件").click();
    await expect(ready).toBeVisible();
    const board = a.getByLabel("双人画布");
    const center = async () => {
      await board.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
      const bounds = await board.boundingBox();
      if (!bounds) throw new Error("Cannot locate canvas");
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    };
    await a.evaluate(() => {
      const send = window.WebSocket.prototype.send;
      window.WebSocket.prototype.send = function (message) {
        if (typeof message === "string" && JSON.parse(message).type === "op.submit" && new URL(this.url).pathname === "/ws/play") {
          window.setTimeout(() => send.call(this, message), 200);
        } else send.call(this, message);
      };
      window.addEventListener("fixture-stop-drawing-delay", () => { window.WebSocket.prototype.send = send; }, { once: true });
    });
    await b.getByLabel("我猜是").fill("太阳");
    for (const [index, offset] of [-32, 0, 32].entries()) {
      const ink = await center();
      await a.mouse.move(ink.x - 40, ink.y + offset);
      await a.mouse.down();
      await a.mouse.move(ink.x + 40, ink.y + offset, { steps: 5 });
      await a.mouse.up();
      if (index === 0) await b.getByRole("button", { name: "提交猜测" }).click();
      await expect(items(b)).toHaveCount(index + 2);
      await expect(pending).toHaveCount(0);
    }
    await expect(b.getByText(/猜测.*太阳/)).toBeVisible();
    await a.evaluate(() => window.dispatchEvent(new Event("fixture-stop-drawing-delay")));

    await a.getByRole("button", { name: "橡皮" }).click();
    fixture.setNetworkAvailable(false);
    await expect(ready).toHaveCount(0);
    const eraser = await center();
    if (browser.browserType().name() === "chromium") {
      const touch = await phone.newCDPSession(a);
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: eraser.x, y: eraser.y - 35 }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: eraser.x, y: eraser.y + 2 }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await a.mouse.move(eraser.x, eraser.y - 35);
      await a.mouse.down();
      await a.mouse.move(eraser.x, eraser.y + 2, { steps: 5 });
      await a.mouse.up();
    }
    await expect(pending).toBeVisible();
    await expect(items(b)).toHaveCount(4);
    fixture.setNetworkAvailable(true);
    await expect(items(b)).toHaveCount(2, { timeout: 20000 });
    await a.getByRole("button", { name: "撤销我的操作" }).click();
    await expect(items(b)).toHaveCount(4);
    await a.getByRole("button", { name: "重做我的操作" }).click();
    await expect(items(b)).toHaveCount(2);

    await a.goto(origin + "/app/play/games");
    await b.getByLabel("我猜是").fill("ＭＯＯＮ");
    await b.getByRole("button", { name: "提交猜测" }).click();
    await expect(b.getByText(/猜测.*ＭＯＯＮ/)).toBeVisible();
    await expect(b.getByRole("heading", { name: "Moon · 猜对了！" })).toHaveCount(0);
    await a.goto(room);
    await expect(a.getByRole("heading", { name: "Moon · 猜对了！" })).toBeVisible();
    await expect(b.getByRole("heading", { name: "Moon · 猜对了！" })).toBeVisible();

    await a.getByRole("button", { name: "换人画下一轮" }).click();
    await b.getByLabel("自定义或从词库选题").fill("雨幕");
    await b.getByLabel("画图时间").selectOption("60");
    await b.getByRole("button", { name: "开始画这一轮" }).click();
    await expect(b.getByText("你要画的题目　雨幕")).toBeVisible();
    await expect(a.getByLabel("我猜是")).toBeVisible();
    await b.goto(origin + "/app/play/games");
    await Promise.all([a.clock.fastForward(61_000), b.clock.fastForward(61_000)]);
    await expect(a.getByText("时间已到，等画者回来揭晓。")).toBeVisible();
    await expect(a.getByRole("heading", { name: "雨幕 · 时间到了" })).toHaveCount(0);
    await b.goto(room);
    await expect(b.getByRole("heading", { name: "雨幕 · 时间到了" })).toBeVisible();
    await expect(a.getByRole("heading", { name: "雨幕 · 时间到了" })).toBeVisible();
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("双人厨房在断线与暂停后恢复交接，并为一份订单只装盘一次", async () => {
  test.setTimeout(90000);
  const fixture = await startReleaseFixture("playground,shared_canvas,realtime_games");
  const { origin, accounts, certificatePin } = fixture;
  const browser = await launchPlayBrowser(certificatePin);
  try {
    const a = await (await browser.newContext({ viewport: { width: 1280, height: 850 }, ignoreHTTPSErrors: true })).newPage();
    const b = await (await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true })).newPage();
    const start = (page: Page) => page.getByRole("button", { name: "开始备菜", exact: true });
    const useStation = (page: Page) => page.getByRole("button", { name: "使用当前站点" });
    const ready = a.getByText("实时连接已就绪");
    const move = async (page: Page, ...steps: string[]) => {
      for (const name of steps) await page.getByRole("button", { name, exact: true }).click();
    };

    await pair(a, b, origin, accounts);
    await openActivity(a, b, origin, "/app/play/games/g04", "断线续上的厨房订单");
    await a.getByRole("button", { name: "本机双角色练习" }).click();
    await start(a).click();
    await a.getByRole("group", { name: /长桌厨房/ }).press("ArrowRight");
    await expect(a.getByText(/当前位置 4, 3/)).toBeVisible();
    await move(a, "右移");
    await expect(a.getByText(/当前位置 5, 3/)).toBeVisible();
    await a.getByRole("button", { name: "退出练习" }).click();
    await b.getByRole("button", { name: "我准备好了" }).click();
    await a.getByLabel("订单", { exact: false }).selectOption({ label: "清炒蘑菇" });
    await start(a).click();
    await expect(b.getByRole("heading", { name: "清炒蘑菇" })).toBeVisible();
    await expect(a.getByText(/当前位置 3, 3/)).toBeVisible();

    await move(a, "左移", "上移");
    await useStation(a).click();
    await expect(a.getByText("我手里：蘑菇 · 食材")).toBeVisible();
    await move(a, "右移", "右移");
    await useStation(a).click();
    await expect(a.getByText("我手里：蘑菇 · 已洗净")).toBeVisible();
    await move(a, "下移", "左移", "下移");
    await useStation(a).click();
    await expect(a.getByText("我手里：蘑菇 · 已切好")).toBeVisible();
    await move(a, "上移", "右移", "右移");
    await expect(a.getByText(/当前位置 5, 3 · 交接台/)).toBeVisible();

    await expect(ready).toBeVisible();
    fixture.setNetworkAvailable(false);
    await expect(ready).toHaveCount(0);
    await useStation(a).click();
    await expect(a.getByText("有一条加密操作待确认。")).toBeVisible();
    fixture.setNetworkAvailable(true);
    for (const site of [a, b]) await expect(site.getByText(/已装盘 0 \/ 1 · 交接台 蘑菇/)).toBeVisible({ timeout: 20000 });

    await a.getByRole("button", { name: "暂停活动" }).click();
    await expect(b.getByRole("button", { name: "继续活动" })).toBeVisible();
    await expect(useStation(b)).toBeDisabled();
    await b.getByRole("button", { name: "继续活动" }).click();
    await useStation(b).click();
    await expect(b.getByText("我手里：蘑菇 · 已切好")).toBeVisible();
    await expect(a.getByText(/已装盘 0 \/ 1 · 交接台 空/)).toBeVisible();
    await move(b, "上移");
    await useStation(b).click();
    await expect(b.getByText("我手里：蘑菇 · 已煮好")).toBeVisible();
    await move(b, "下移", "下移");
    await useStation(b).click();

    await Promise.all([a, b].map(async (site) => {
      await expect(site.getByText("这份清炒蘑菇可以上桌了")).toBeVisible();
      await site.reload();
      await expect(site.getByText(/已装盘 1 \/ 1 · 交接台 空/)).toBeVisible();
      await expect(site.getByText("我手里：空")).toBeVisible();
      await expect(useStation(site)).toBeDisabled();
    }));
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("双人光影迷宫同步光桥和影门，通过断线检查点续完首关", async () => {
  test.setTimeout(90000);
  const fixture = await startReleaseFixture("playground,shared_canvas,realtime_games");
  const { origin, accounts, certificatePin } = fixture;
  const browser = await launchPlayBrowser(certificatePin);
  try {
    const a = await (await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true })).newPage();
    const b = await (await browser.newContext({ viewport: { width: 1260, height: 860 }, ignoreHTTPSErrors: true })).newPage();
    const root = (page: Page) => page.locator(".play-shadow");
    const mirror = a.getByRole("button", { name: "点亮反光镜" });
    const switchShadow = b.getByRole("button", { name: "按下影之按钮" });
    const move = async (page: Page, ...steps: string[]) => {
      for (const name of steps) await page.getByRole("button", { name, exact: true }).click();
    };
    await pair(a, b, origin, accounts);
    await openActivity(a, b, origin, "/app/play/games/g13", "穿过晨光渡口");
    await b.getByRole("button", { name: "我准备好了" }).click();
    await a.getByText("房间设置", { exact: true }).click();
    await a.getByLabel("减少动效并降低画布清晰度").check();
    await expect(mirror).toBeDisabled();
    await expect(switchShadow).toBeDisabled();

    await move(a, "右移", "右移", "右移", "下移", "下移", "下移");
    await expect(a.getByText(/位置 5, 5/)).toBeVisible();
    await move(a, "右移");
    await expect(a.getByText("前面暂时走不通")).toBeVisible();
    await expect(a.getByText(/位置 5, 5/)).toBeVisible();
    await move(b, "上移", "右移", "右移", "右移", "右移", "右移");
    await expect(b.getByText(/位置 7, 5/)).toBeVisible();
    await expect(switchShadow).toBeEnabled();

    await move(a, "上移", "上移");
    await mirror.click();
    for (const page of [a, b]) {
      await expect(root(page)).toHaveAttribute("data-reflector-lit", "true");
      await expect(root(page)).toHaveAttribute("data-bridge-open", "false");
      await expect(root(page).getByRole("status")).toHaveText(/反光镜已点亮.*光桥未开启/);
    }
    await expect(b.getByText("实时连接已就绪")).toBeVisible();
    fixture.setNetworkAvailable(false);
    await expect(b.getByText("实时连接已就绪")).toHaveCount(0);
    await switchShadow.click();
    await expect(b.getByText("有一条加密操作待确认。")).toBeVisible();
    await expect(root(a)).toHaveAttribute("data-bridge-open", "false");
    fixture.setNetworkAvailable(true);
    await expect(root(a)).toHaveAttribute("data-bridge-open", "true", { timeout: 20000 });
    await expect(root(b)).toHaveAttribute("data-bridge-open", "true");
    await b.reload();
    await expect(root(b).getByRole("status")).toHaveText(/反光镜已点亮.*影之按钮已按下.*光桥已开启/);

    await move(a, "右移", "右移", "右移", "右移", "下移", "下移", "下移");
    await expect(a.getByText(/位置 9, 6/)).toBeVisible();
    await expect(a.getByText("两个人都到达了出口")).toHaveCount(0);
    await move(b, "右移", "右移", "下移");
    for (const page of [a, b]) await expect(page.getByText("两个人都到达了出口")).toBeVisible();
    await a.getByRole("button", { name: "前往下一关" }).click();
    await expect(b.getByRole("heading", { name: "雾中花房" })).toBeVisible();
    await expect(root(b)).toHaveAttribute("data-bridge-open", "false");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("小屋家具可触屏拖动，原位被修改时保留搭档的版本", async () => {
  test.skip(["firefox", "webkit"].includes(process.env.US_PLAY_TEST_BROWSER ?? ""), "触屏输入由 Chromium CDP 发送");
  test.setTimeout(90000);
  const fixture = await startReleaseFixture("playground,shared_canvas,creative_worlds");
  const { origin, accounts, certificatePin } = fixture;
  const browser = await launchPlayBrowser(certificatePin);
  try {
    const a = await (await browser.newContext({ viewport: { width: 1280, height: 850 }, ignoreHTTPSErrors: true })).newPage();
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, ignoreHTTPSErrors: true });
    const b = await phone.newPage();
    const grid = (page: Page) => page.getByRole("group", { name: "小屋地图" });
    const cell = (page: Page, column: number, item: string) => grid(page).getByRole("button", { name: `第 ${column} 列，第 1 行，${item}` });
    const fridge = cell(b, 1, "冰箱");
    const target = cell(b, 2, "空地");
    const touch = await phone.newCDPSession(b);
    async function dragToSecondCell() {
      await grid(b).evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
      const [source, destination] = await Promise.all([fridge.boundingBox(), target.boundingBox()]);
      if (!source || !destination) throw new Error("The fridge and destination must be visible");
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{
        x: source.x + source.width / 2, y: source.y + source.height / 2,
      }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
        x: destination.x + destination.width / 2, y: destination.y + destination.height / 2,
      }] });
      await expect(target).toHaveAttribute("data-drop-cell", "true");
    }

    await pair(a, b, origin, accounts);
    await openActivity(a, b, origin, "/app/play/world/house", "能挪家具的小屋");
    await a.getByLabel("物件", { exact: true }).selectOption("fridge");
    await a.getByRole("button", { name: "把物件放在这里" }).click();
    await expect(fridge).toHaveCSS("touch-action", "auto");
    await fridge.tap();
    await b.getByRole("button", { name: "移动物件" }).tap();
    await expect(fridge).toHaveCSS("touch-action", "none");
    await expect(target).toHaveCSS("touch-action", "auto");
    await dragToSecondCell();
    await expect(cell(a, 2, "空地")).toBeVisible();

    await cell(a, 1, "冰箱").click();
    await a.getByRole("button", { name: "旋转物件" }).click();
    await expect(fridge.locator(".play-world-marker > span")).toHaveAttribute("style", /rotate\(90deg\)/);
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(b.getByText("物件已更新，请核对布局再操作")).toBeVisible();
    await expect(target).toHaveCount(1);

    await dragToSecondCell();
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(cell(b, 2, "冰箱").locator(".play-world-marker > span")).toHaveAttribute("style", /rotate\(90deg\)/);
    await expect(cell(b, 2, "冰箱")).toHaveCSS("touch-action", "auto");
    await cell(a, 2, "冰箱").dragTo(cell(a, 3, "空地"));
    await expect(cell(b, 3, "冰箱")).toBeVisible();
    await b.getByText("房间设置", { exact: true }).click();
    await b.getByLabel("减少动效并降低画布清晰度").check();
    await cell(b, 3, "冰箱").tap();
    await expect(b.getByRole("link", { name: "今天吃什么", exact: true })).toHaveAttribute("href", "/app/play/food");
    await b.getByText("家具和布置清单", { exact: true }).click();
    await expect(b.getByLabel("查看物件").locator("option")).toContainText(["选择物件", "冰箱 · 3, 1"]);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("星际探险的过场可跳过，重连续局与纪念碑沿用共享进度", async ({}, info) => {
  test.setTimeout(90000);
  const fixture = await startReleaseFixture("playground,shared_canvas,realtime_games");
  const { origin, accounts, certificatePin } = fixture;
  const browser = await launchPlayBrowser(certificatePin);
  try {
    const a = await (await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true })).newPage();
    const b = await (await browser.newContext({ reducedMotion: "reduce", ignoreHTTPSErrors: true })).newPage();
    const flight = a.locator(".play-flight");
    const skip = a.getByRole("button", { name: "跳过过场" });
    const ready = a.getByText("实时连接已就绪");
    const land = a.getByRole("group", { name: /浅雾星 · 着陆区/ });
    const position = (page: Page, x: number, y: number) => page.getByText(new RegExp(`位置 ${x}, ${y}$`));
    const pending = a.getByText("有一条加密操作待确认。");
    const move = async (page: Page, ...steps: string[]) => {
      for (const name of steps) await page.getByRole("button", { name, exact: true }).click();
    };

    await pair(a, b, origin, accounts);
    await a.goto(origin + "/app/memories/new");
    await a.getByLabel("这一页的小标题").fill("留给浅雾星的照片");
    await a.getByLabel("添加照片").setInputFiles(resolve("public/assets/journal-lake.jpg"));
    await expect(a.getByRole("img", { name: "journal-lake.jpg" })).toBeVisible();
    await a.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(a.getByRole("dialog")).toHaveCount(0);
    await openActivity(a, b, origin, "/app/play/games/g12", "两人登录浅雾星");
    await b.getByRole("button", { name: "我准备好了" }).click();
    await expect(a.getByText("正在着陆")).toBeVisible();
    await expect(land).toHaveCSS("animation-name", "play-flight-landing");
    await flight.evaluate((stage) => stage.scrollIntoView({ block: "center", behavior: "instant" }));
    await flight.screenshot({ path: info.outputPath("star-landing.png") });
    await skip.click();
    await expect(skip).toHaveCount(0);
    await expect(a.getByRole("heading", { name: "浅雾星 · 着陆区" })).toBeVisible();
    await expect(b.getByRole("button", { name: "右移", exact: true })).toBeEnabled();
    await expect(b.getByRole("button", { name: "跳过过场" })).toHaveCount(0);

    await a.reload();
    await expect(position(a, 2, 2)).toBeVisible();
    await expect(skip).toHaveCount(0);
    await expect(ready).toBeVisible();
    await a.getByText("宇航服装饰", { exact: true }).click();
    const outfit = (page: Page) => page.getByRole("combobox", { name: /^我的装饰/ });
    const avatar = (page: Page, seat: number) => page.locator(`.play-flight b[data-avatar='${seat}']`);
    await expect(outfit(a).locator("option[value='orbit']")).toHaveJSProperty("disabled", true);

    await a.evaluate(() => {
      const send = window.WebSocket.prototype.send;
      window.WebSocket.prototype.send = function (message) {
        if (typeof message === "string" && JSON.parse(message).type === "op.submit" && new URL(this.url).pathname === "/ws/play") {
          window.WebSocket.prototype.send = send;
          window.addEventListener("fixture-release-flight-step", () => send.call(this, message), { once: true });
        } else send.call(this, message);
      };
    });
    await land.press("ArrowRight");
    await expect(avatar(a, 0)).toHaveAttribute("data-predicting", "true");
    await expect(position(a, 2, 2)).toBeVisible();
    await expect(avatar(b, 0)).toHaveAttribute("style", /left: 15%/);
    await expect(b.getByText(/星尘 0\/3/)).toBeVisible();
    await a.evaluate(() => window.dispatchEvent(new Event("fixture-release-flight-step")));
    await expect(position(a, 3, 2)).toBeVisible();
    await expect(b.getByText(/星尘 1\/3/)).toBeVisible();

    fixture.setNetworkAvailable(false);
    await expect(ready).toHaveCount(0);
    await move(a, "右移");
    await expect(pending).toBeVisible();
    fixture.setNetworkAvailable(true);
    await expect(position(a, 4, 2)).toBeVisible({ timeout: 20000 });
    await expect(pending).toHaveCount(0);
    await expect(b.locator(".play-flight b[data-avatar='0']")).toHaveAttribute("style", /left: 35%/);
    await expect(skip).toHaveCount(0);

    await move(a, "右移", "下移");
    await move(b, "右移", "右移");
    await expect(a.locator(".play-flight [data-tile='G']")).toHaveText("·");
    await move(a, "右移", "右移", "右移", "右移", "下移", "下移", "下移");
    await move(b, "上移", "上移", "上移", "右移", "右移", "右移", "下移", "下移", "下移", "右移", "右移");
    await expect(a.getByText("星球探索完成")).toBeVisible();
    await expect(land).toHaveCSS("animation-name", "play-flight-departure");
    await flight.screenshot({ path: info.outputPath("star-departure.png") });
    await skip.click();
    await expect(a.getByText("两个人都到达了出口")).toBeVisible();
    await expect(b.getByRole("button", { name: "前往下一关" })).toBeEnabled();
    await expect(b.getByRole("button", { name: "跳过过场" })).toHaveCount(0);

    await b.getByText("宇航服装饰", { exact: true }).click();
    await expect(outfit(a).locator("option[value='orbit']")).toHaveJSProperty("disabled", false);
    await expect(outfit(b).locator("option[value='halo']")).toHaveJSProperty("disabled", true);
    await Promise.all([outfit(a).selectOption("orbit"), outfit(b).selectOption("orbit")]);
    for (const site of [a, b]) {
      await expect(avatar(site, 0)).toHaveAttribute("data-flight-badge", "orbit");
      await expect(avatar(site, 1)).toHaveAttribute("data-flight-badge", "orbit");
      await expect(site.getByText("共同星尘 3 颗。解锁后可随时更换。")).toBeVisible();
    }
    fixture.setNetworkAvailable(false);
    await expect(ready).toHaveCount(0);
    await outfit(a).selectOption("");
    await expect(pending).toBeVisible();
    await expect(avatar(a, 0)).toHaveAttribute("data-flight-badge", "orbit");
    fixture.setNetworkAvailable(true);
    await expect(avatar(b, 0)).not.toHaveAttribute("data-flight-badge", "orbit", { timeout: 20000 });
    await expect(avatar(b, 1)).toHaveAttribute("data-flight-badge", "orbit");
    await expect(pending).toHaveCount(0);

    await a.reload();
    await expect(a.getByRole("button", { name: "前往下一关" })).toBeEnabled();
    await expect(skip).toHaveCount(0);
    await b.getByRole("button", { name: "前往下一关" }).click();
    await expect(a.getByRole("heading", { name: "浅雾星 · 陨石坡" })).toBeVisible();
    await expect(a.getByText("正在着陆")).toBeVisible();
    await expect(skip).toHaveCount(0);
    await expect(position(a, 2, 2)).toBeVisible();
    await expect(position(b, 2, 7)).toBeVisible();
    await expect(avatar(a, 1)).toHaveAttribute("data-flight-badge", "orbit");

    await a.getByText("星球纪念碑", { exact: true }).click();
    await a.getByRole("combobox", { name: /^留下共同回忆/ }).selectOption({ label: "留给浅雾星的照片" });
    await a.getByRole("combobox", { name: /^纪念碑照片/ }).selectOption({ index: 1 });
    await a.getByRole("button", { name: "把回忆放在这里" }).click();
    await b.getByText("星球纪念碑", { exact: true }).click();
    await expect(b.getByAltText("纪念碑上的共同照片")).toBeVisible();
    await b.getByRole("button", { name: /纪念碑上的共同照片/ }).click();
    await expect(b.getByRole("dialog").getByRole("heading", { name: "留给浅雾星的照片" })).toBeVisible();
    await b.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();

    await a.getByRole("button", { name: /纪念碑上的共同照片/ }).click();
    await a.getByRole("button", { name: "编辑这一页" }).click();
    await a.getByRole("button", { name: "移除照片" }).click();
    await a.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(a.getByRole("dialog")).toHaveCount(0);
    await b.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(b.getByText("纪念碑上的照片已移除。")).toBeVisible();
    await expect(b.getByAltText("纪念碑上的共同照片")).toHaveCount(0);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("梦想地图沿用愿望目标日期与状态，两人并发生成一条共同回忆", async () => {
  test.setTimeout(90000);
  const fixture = await startReleaseFixture("playground,shared_canvas,creative_worlds");
  const { origin, accounts, certificatePin } = fixture;
  const browser = await launchPlayBrowser(certificatePin);
  try {
    const a = await (await browser.newContext({ viewport: { width: 1280, height: 850 }, ignoreHTTPSErrors: true })).newPage();
    const b = await (await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true })).newPage();
    const wish = "和你去看海边的日出";
    const plans = origin + "/app/plans";
    const selectWish = async (page: Page) => {
      await page.getByText("浏览与编辑物件").click();
      await page.getByLabel("画面物件").selectOption({ index: 1 });
      await expect(page.getByText("目标 2027.03.16", { exact: true })).toBeVisible();
    };
    const refresh = (page: Page) => page.getByRole("button", { name: "刷新", exact: true }).click();
    const generate = (page: Page) => page.getByRole("button", { name: "生成共同回忆" });
    const reopen = (page: Page) => page.getByRole("button", { name: "打开完成回忆" });
    const restore = (page: Page) => page.getByRole("button", { name: "重新列为待完成" });

    await pair(a, b, origin, accounts);
    await a.goto(plans);
    await a.getByRole("button", { name: "添加一份期待" }).click();
    await a.getByLabel("想一起做的事").fill(wish);
    await a.getByLabel("目标日期（选填）").fill("2027-03-16");
    await a.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(a.getByText("目标 2027.03.16", { exact: true })).toBeVisible();

    await openActivity(a, b, origin, "/app/play/create/c22", "我们想一起去的地方");
    const room = a.url();
    await a.getByText("加入物件").click();
    await a.getByLabel("物件类型").selectOption("wish");
    await a.getByRole("combobox", { name: /^共同愿望/ }).selectOption({ label: wish });
    await a.getByRole("button", { name: "放到画面中央" }).click();
    await a.getByLabel("物件类型").selectOption("sticker");
    await a.getByRole("combobox", { name: /^贴纸/ }).selectOption("📍");
    await a.getByRole("button", { name: "放到画面中央" }).click();
    await Promise.all([selectWish(a), selectWish(b)]);
    await expect(b.getByLabel("画面物件").locator("option")).toContainText(["请选择", "愿望", "贴纸 📍"]);
    await expect(generate(a)).toHaveCount(0);

    await b.goto(plans);
    const card = b.locator(".plan-card").filter({ hasText: wish });
    await card.getByRole("button", { name: "标记实现" }).click();
    await expect(card.getByRole("button", { name: "已经实现" })).toBeVisible();
    await refresh(a);
    await expect(restore(a)).toBeVisible();
    await restore(a).click();
    await expect(a.getByRole("button", { name: "标记愿望完成" })).toBeVisible();
    await refresh(b);
    await expect(card.getByRole("button", { name: "标记实现" })).toBeVisible();
    await card.getByRole("button", { name: "标记实现" }).click();
    await expect(card.getByRole("button", { name: "已经实现" })).toBeVisible();
    await b.goto(room);
    await selectWish(b);
    await refresh(a);
    await expect(generate(a)).toBeEnabled();
    await expect(generate(b)).toBeEnabled();

    a.once("dialog", (dialog) => void dialog.dismiss());
    await generate(a).click();
    await expect(a).toHaveURL(room);
    for (const page of [a, b]) page.once("dialog", (dialog) => void dialog.accept());
    await Promise.all([generate(a).click(), generate(b).click()]);
    for (const page of [a, b]) {
      await expect(page.getByRole("dialog").getByRole("heading", { name: wish })).toBeVisible();
      await expect(page.getByRole("dialog").getByText(/共同回忆/)).toBeVisible();
    }
    expect(a.url()).toBe(b.url());
    await Promise.all([a, b].map(async (page) => {
      await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
      await expect(page).toHaveURL(room);
      await expect(reopen(page)).toBeVisible();
      await expect(generate(page)).toHaveCount(0);
    }));
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("两位成员绘制 100 笔并经历 10 次断线，两端重开后顺序一致", async () => {
  test.setTimeout(180000);
  const fixture = await startReleaseFixture("playground,async_games,shared_canvas,realtime_games");
  const { origin, accounts, certificatePin } = fixture;
  const browser = await launchPlayBrowser(certificatePin);
  try {
    const contexts = await Promise.all([1280, 390].map((width) =>
      browser.newContext({ viewport: { width, height: 850 }, ignoreHTTPSErrors: true })));
    const [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
    await pair(a, b, origin, accounts);
    await openActivity(a, b, origin, "/app/play/create/c15", "断线后的百笔画布");
    await b.getByRole("button", { name: "我准备好了" }).click();

    const sites = [a, b].map((page) => ({
      page,
      canvas: page.getByLabel("双人画布"),
      ready: page.getByText("实时连接已就绪"),
      items: page.getByLabel("画面物件").locator("option"),
    }));
    for (const site of sites) await site.page.getByText("浏览与编辑物件").click();
    const drawFive = async (site: typeof sites[number], cycle: number) => {
      const bounds = await site.canvas.boundingBox();
      if (!bounds) throw new Error("Cannot locate canvas for drawing");
      const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
      for (let stroke = 0; stroke < 5; stroke++) {
        const offset = (stroke - 2) * 8;
        await site.page.mouse.move(x + offset, y - 16);
        await site.page.mouse.down();
        await site.page.mouse.move(x + offset + 4, y + cycle + 8, { steps: 2 });
        await site.page.mouse.up();
      }
    };
    for (let cycle = 0; cycle < 10; cycle++) {
      await test.step(`第 ${cycle + 1} 次断线和补发`, async () => {
        for (const site of sites) {
          await expect(site.ready).toBeVisible({ timeout: 15000 });
          await site.canvas.scrollIntoViewIfNeeded();
        }
        fixture.setNetworkAvailable(false);
        await Promise.all(sites.map((site) => expect(site.ready).toHaveCount(0)));
        for (const site of sites) {
          await drawFive(site, cycle);
          await expect(site.page.getByText("5 笔留在本机。")).toBeVisible();
        }
        fixture.setNetworkAvailable(true);
        await Promise.all(sites.map((site) => expect(site.items).toHaveCount(1 + (cycle + 1) * 10, { timeout: 20000 })));
        for (const site of sites) await expect(site.page.getByText(/笔留在本机|加密操作待确认/)).toHaveCount(0);
      });
    }

    const itemIds = () => Promise.all(sites.map((site) =>
      site.items.evaluateAll((options: HTMLOptionElement[]) => options.slice(1).map((option) => option.value))));
    const [beforeA, beforeB] = await itemIds();
    expect(new Set(beforeA).size).toBe(100);
    expect(beforeB).toEqual(beforeA);
    await Promise.all(sites.map(async (site) => {
      await site.page.reload();
      await site.page.getByText("浏览与编辑物件").click();
      await expect(site.items).toHaveCount(101);
    }));
    expect(await itemIds()).toEqual([beforeA, beforeA]);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("星图与回忆树保留筛选、双端授权、原记录返回和失效引用", async ({}, info) => {
  test.setTimeout(180000);
  const fixture = await startReleaseFixture("playground,shared_canvas,creative_worlds");
  const { origin, accounts, certificatePin } = fixture;
  const browser = await launchPlayBrowser(certificatePin);
  try {
    const a = await (await browser.newContext({ viewport: { width: 1250, height: 900 }, ignoreHTTPSErrors: true })).newPage();
    const b = await (await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true })).newPage();
    await pair(a, b, origin, accounts);
    for (const [title, visibility, photos] of [
      ["散步的旧胶卷", "shared", ["public/assets/journal-lake.jpg", "public/assets/journal-flower.jpg", "dist/assets/icon-512.png"]],
      ["只有甲能看到的回忆", "private", ["public/assets/journal-lake.jpg"]],
    ] as const) {
      await a.goto(origin + "/app/memories/new");
      await a.getByLabel("这一页的小标题").fill(title);
      await a.getByLabel("记录日期").fill("2024-05-12");
      await a.getByLabel("小标签（用逗号分开）").fill("散步");
      await a.getByLabel("谁可以看见").selectOption(visibility);
      await a.getByLabel("添加照片").setInputFiles(photos.map((path) => resolve(path)));
      await expect(a.getByRole("img", { name: photos.at(-1)!.split("/").at(-1), exact: true })).toBeVisible();
      await a.getByRole("button", { name: "收藏到我们的小世界" }).click();
      await expect(a.getByRole("dialog")).toHaveCount(0);
    }

    await openActivity(a, b, origin, "/app/play/create/c18", "星图验收房间");
    const starsRoom = a.url();
    await a.getByLabel("年份").selectOption("2024");
    await a.getByLabel("标签", { exact: true }).selectOption("散步");
    await a.getByLabel("搜索照片或标签").fill("ＪＯＵＲＮＡＬ－ＬＡＫＥ");
    await expect(a.getByLabel("从银河选星").locator("option")).toHaveCount(2);
    await a.getByLabel("从银河选星").selectOption({ index: 1 });
    await a.getByRole("button", { name: "摘下这颗星" }).click();
    await expect(a.getByText(/1 \/ 20 颗星/)).toBeVisible();
    await a.getByLabel("搜索照片或标签").fill("散步的旧胶卷");
    for (const count of [2, 3]) {
      await a.getByLabel("从银河选星").selectOption({ index: 1 });
      await a.getByRole("button", { name: "摘下这颗星" }).click();
      await expect(a.getByText(new RegExp(`${count} / 20 颗星`))).toBeVisible();
    }
    const point = (site: Page) => site.getByRole("button", { name: "选择星点 1", exact: true });
    const before = await point(b).getAttribute("style");
    await a.getByLabel("选中星点", { exact: true }).selectOption({ index: 1 });
    await expect(point(a)).toHaveAttribute("aria-pressed", "true");
    await point(a).scrollIntoViewIfNeeded();
    expect(await point(a).evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2) === element;
    })).toBe(true);
    const bounds = (await point(a).boundingBox())!;
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    await a.mouse.move(x, y);
    await a.mouse.down();
    await a.mouse.move(x + 31, y + 17, { steps: 6 });
    await a.mouse.up();
    await expect(point(a)).not.toHaveAttribute("style", before!);
    await expect(point(b)).not.toHaveAttribute("style", before!);
    const after = await point(b).getAttribute("style");
    await a.getByLabel("连向另一颗星").selectOption({ index: 1 });
    await a.getByRole("button", { name: "切换两星连线" }).click();
    await expect(b.locator(".play-star-field i")).toHaveCount(1);
    await b.reload();
    await expect(point(b)).toHaveAttribute("style", after!);
    await expect(b.locator(".play-star-field i")).toHaveCount(1);
    await a.getByRole("button", { name: "放大星图" }).click();
    await a.getByRole("button", { name: "打开回忆 · 散步的旧胶卷" }).click();
    const detail = a.getByRole("dialog");
    await expect(detail.getByRole("heading", { name: "散步的旧胶卷" })).toBeVisible();
    await detail.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(a).toHaveURL(starsRoom);
    await expect(a.getByLabel("年份")).toHaveValue("2024");
    await expect(a.getByLabel("标签", { exact: true })).toHaveValue("散步");
    await expect(a.getByLabel("搜索照片或标签")).toHaveValue("散步的旧胶卷");
    await expect(a.locator(".play-star-plane")).toHaveAttribute("style", /width: 125%/);
    await a.getByLabel("星座名称").fill("湖边的三颗灯");
    await a.getByLabel("星座故事").fill("三张照片连在一起，记住那天的湖边。");
    await a.getByRole("button", { name: "保存星座名称与故事" }).click();
    await expect(b.getByRole("group", { name: "湖边的三颗灯" })).toBeVisible();
    const saveShared = async () => {
      await a.getByRole("button", { name: "确认收藏当前版本" }).click();
      await b.getByRole("button", { name: "确认收藏当前版本" }).click();
      await a.getByRole("button", { name: "放入共同作品馆" }).click();
      await expect(a).toHaveURL(/\/app\/play\/works\/[a-f0-9]{32}$/);
      return a.url();
    };
    const starsWork = await saveShared();
    await b.goto(origin + "/app/memories/galaxy");
    const galaxy = b.getByRole("region", { name: "回忆银河", exact: true });
    await galaxy.getByLabel("年份").selectOption("2024");
    await galaxy.getByRole("button", { name: "照片列表", exact: true }).click();
    const galleryLink = b.getByRole("link", { name: "湖边的三颗灯" });
    await expect(galleryLink).toHaveAttribute("href", new URL(starsWork).pathname);
    await galleryLink.click();
    await expect(b.locator(".play-star-field i")).toHaveCount(1);
    await b.goBack();
    await expect(galaxy.getByLabel("年份")).toHaveValue("2024");
    await expect(galaxy.getByRole("button", { name: "照片列表", exact: true })).toHaveAttribute("aria-pressed", "true");
    await galleryLink.click();
    await a.getByRole("button", { name: "打开回忆 · 散步的旧胶卷", exact: true }).first().click();
    await a.getByRole("button", { name: "编辑这一页" }).click();
    await a.getByRole("button", { name: "移除照片" }).first().click();
    await a.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(a.getByRole("dialog")).toHaveCount(0);
    await b.reload();
    await expect(b.getByText("1 颗星的照片已移除或暂不可用。")).toBeVisible();
    await expect(b.locator(".play-star-field i")).toHaveCount(0);
    await b.goto(starsRoom);
    await expect(b.getByText(/2 \/ 20 颗星/)).toBeVisible();
    await expect(b.getByRole("button", { name: "确认收藏当前版本" })).toHaveCount(0);

    await openActivity(a, b, origin, "/app/play/world/w24", "用叶子保存一段散步");
    const treeRoom = b.url();
    await a.getByLabel("搜索共同回忆").fill("散步的旧胶卷");
    await a.getByLabel("挑一条共同回忆").selectOption({ index: 1 });
    await a.getByRole("button", { name: "把回忆挂到树上" }).click();
    await expect(b.getByText(/1 片叶子 · 1 颗照片果实/)).toBeVisible();
    await a.getByLabel(/显示自己的私人叶子/).check();
    await expect(a.getByText(/2 片叶子/)).toBeVisible();
    await expect(a.getByRole("button", { name: /只有甲能看到的回忆.*私人/ })).toBeVisible();
    await b.getByLabel(/显示自己的私人叶子/).check();
    await expect(b.getByText(/1 片叶子/)).toBeVisible();
    await expect(b.getByText(/只有甲能看到的回忆/)).toHaveCount(0);
    await b.getByText("房间设置", { exact: true }).click();
    await b.getByLabel(/减少动效/).check();
    await expect(b.getByRole("group", { name: "回忆树枝叶" })).toHaveCount(0);
    await expect(b.getByRole("region", { name: "回忆树叶子" }).getByRole("button", { name: /散步的旧胶卷/ })).toBeVisible();
    const treeWork = await saveShared();
    await expect(a.getByText(/1 片叶子/)).toBeVisible();
    await expect(a.getByText(/只有甲能看到的回忆/)).toHaveCount(0);
    await a.getByLabel("年份").selectOption("2024");
    await a.getByRole("region", { name: "回忆树叶子" }).getByRole("button", { name: /散步的旧胶卷/ }).last().click();
    await expect(a.getByRole("dialog").getByRole("img").first()).toBeVisible();
    await a.getByRole("button", { name: "移入回收站" }).click();
    await expect(a.getByRole("dialog")).toHaveCount(0);
    await b.goto(treeRoom);
    await expect(b.getByText(/0 片叶子/)).toBeVisible();
    await b.goto(treeWork);
    await expect(b.getByText("1 段关联回忆已移除或暂不可访问。")).toBeVisible();
    await expect(b.getByRole("button", { name: /散步的旧胶卷/ })).toHaveCount(0);
    await b.screenshot({ path: info.outputPath("archived-tree-after-deletion.png") });
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("发布工具恢复两份成员密钥、天空作品新版及旧版，并保留删除和撤销", async ({}, info) => {
  test.setTimeout(240000);
  const fixture = await startReleaseFixture("playground,async_games,shared_canvas");
  const { origin, accounts, certificatePin, dir } = fixture;
  const browser = await launchPlayBrowser(certificatePin);
  const page = async () => (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  const run = promisify(execFile);
  const scripts = process.env.US_WEB_TEST_PACKAGE ? join(dir, "scripts") : resolve("scripts");
  const source = join(dir, "e2e.sqlite");
  const snapshot = join(dir, "snapshot.sqlite");
  const candidate = join(dir, "candidate.sqlite");
  try {
    const a = await page(), b = await page();
    await pair(a, b, origin, accounts);
    await openActivity(a, b, origin, "/app/play/games/g05", "甲的私人棋谱");
    await a.getByRole("button", { name: "H8 空位" }).click();
    await a.getByRole("button", { name: "只为自己收藏" }).click();
    await expect(a).toHaveURL(/\/app\/play\/works\/[a-f0-9]{32}$/);
    await expect(a.getByRole("heading", { name: "甲的私人棋谱", exact: true })).toBeVisible();
    const onlyA = new URL(a.url()).pathname;

    await openActivity(a, b, origin, "/app/play/create/c19", "已删故事的样本");
    const chapter = "两个人从窗沿看过去，雨后的屋顶上积着浅浅的水。那两盆还没长叶的花，今早已经有一盆冒出了绿色的小尖。".repeat(4);
    await a.getByLabel("本章正文").fill(chapter);
    await a.getByLabel("章节标题").fill("下过雨的一天");
    await a.getByRole("button", { name: "交给对方" }).click();
    await b.getByRole("button", { name: "确认上一章" }).click();
    await a.getByRole("button", { name: "只为自己收藏" }).click();
    await expect(a).toHaveURL(/\/app\/play\/works\/[a-f0-9]{32}$/);
    await expect(a.getByRole("heading", { name: "下过雨的一天", exact: true })).toBeVisible();
    const deleted = new URL(a.url()).pathname;
    const markdown = (await takeExport(a, "导出 Markdown")).toString("utf8");
    expect(markdown).toContain("# 已删故事的样本\n\n## 下过雨的一天\n\n" + chapter);
    expect(markdown).not.toContain("甲的私人棋谱");
    expect(JSON.parse((await takeExport(a, "导出 JSON")).toString("utf8"))).toMatchObject({
      title: "已删故事的样本", activityId: "c19", markdown: "## 下过雨的一天\n\n" + chapter,
    });
    await openWorkPrintView(a);
    await expect(a.getByRole("heading", { name: "下过雨的一天" })).toBeVisible();
    if (browser.browserType().name() === "chromium") {
      const pdf = await a.pdf({ path: info.outputPath("story-print.pdf"), format: "A4", printBackground: true });
      expect(pdf.toString("ascii", 0, 5)).toBe("%PDF-");
    }
    await a.emulateMedia({ media: "screen" });

    await openActivity(a, b, origin, "/app/play/create/c21", "两扇恢复的窗");
    const skyRoom = a.url();
    const addSky = async (site: Page, note: string, path: string) => {
      await site.getByLabel("我拍的天空").setInputFiles(resolve(path));
      await site.getByLabel("留一句话").fill(note);
      await site.getByRole("button", { name: "交给对方看" }).click();
      await expect(site.locator(".play-sky").getByText(note, { exact: true })).toBeVisible();
    };
    const saveShared = async () => {
      await a.getByRole("button", { name: "确认收藏当前版本" }).click();
      await b.getByRole("button", { name: "确认收藏当前版本" }).click();
      await a.getByRole("button", { name: "放入共同作品馆" }).click();
      await expect(a).toHaveURL(/\/app\/play\/works\/[a-f0-9]{32}$/);
      await expect(a.getByRole("heading", { name: "两扇恢复的窗" })).toBeVisible();
    };
    await Promise.all([addSky(a, "旧照片的湖", "public/assets/journal-lake.jpg"),
      addSky(b, "另一扇窗的花", "public/assets/journal-flower.jpg")]);
    await expect(a.locator(".play-sky").getByText("另一扇窗的花")).toBeVisible();
    await saveShared();
    const shared = new URL(a.url()).pathname;
    await b.getByRole("button", { name: "只为自己收藏" }).click();
    await b.getByLabel("作品标题").fill("乙的私人天空");
    await b.getByRole("button", { name: "保存为新版本" }).click();
    await expect(b.getByRole("heading", { name: "乙的私人天空" })).toBeVisible();
    const onlyB = new URL(b.url()).pathname;

    const [backupA, backupB] = await Promise.all([
      downloadVault(a, origin, "first test unlock phrase"), downloadVault(b, origin, "second test unlock phrase"),
    ]);
    const revoked = await page();
    await restoreVault(revoked, origin, "second", accounts.second, backupB);
    await revoked.goto(origin + shared);
    await expect(revoked.getByRole("heading", { name: "两扇恢复的窗" })).toBeVisible();
    await run(process.execPath, [join(scripts, "backup-web.mjs"), source, snapshot]);

    await Promise.all([a.goto(skyRoom), b.goto(skyRoom)]);
    await addSky(a, "后来补进来的照片", "dist/assets/icon-512.png");
    await expect(b.locator(".play-sky").getByText("后来补进来的照片")).toBeVisible();
    await saveShared();
    await expect(a.getByLabel("查看历史版本")).toHaveValue("2");
    await a.goto(origin + deleted);
    a.once("dialog", (dialog) => void dialog.accept());
    await a.getByRole("button", { name: "删除作品" }).click();
    await expect(a.getByRole("heading", { name: "双人作品馆" })).toBeVisible();
    await b.goto(origin + "/app/settings/devices");
    await b.getByRole("button", { name: "刷新设备列表" }).click();
    await b.getByRole("button", { name: "撤销", exact: true }).click();
    const password = b.getByLabel("重新输入网站密码");
    await password.fill(accounts.second);
    await password.press("Enter");
    await expect(b.getByRole("status")).toHaveText("该设备的后续云访问已撤销");

    await fixture.stop();
    const restored = await run(process.execPath, [join(scripts, "recover-web.mjs"), snapshot, source, candidate]);
    expect(JSON.parse(restored.stdout)).toMatchObject({ revokedDevices: 1, reconciledWorkMedia: 3 });
    await fixture.start("candidate.sqlite");

    await signIn(revoked, origin, "second", accounts.second);
    await expect(revoked.getByText("这台设备的空间访问已被撤销。可使用自己的加密备份重新登记。")).toBeVisible();
    const recoveredA = await page(), recoveredB = await page();
    await Promise.all([restoreVault(recoveredA, origin, "first", accounts.first, backupA),
      restoreVault(recoveredB, origin, "second", accounts.second, backupB)]);

    for (const [site, own, title, hidden] of [
      [recoveredA, onlyA, "甲的私人棋谱", onlyB], [recoveredB, onlyB, "乙的私人天空", onlyA],
    ] as const) {
      await site.goto(origin + own);
      await expect(site.getByRole("heading", { name: title })).toBeVisible();
      await site.goto(origin + hidden);
      await expect(site.getByRole("alert")).toContainText("不可访问");
      await site.goto(origin + deleted);
      await expect(site.getByRole("alert")).toContainText("不可访问");
      await site.goto(origin + shared);
      const photos = site.getByAltText("一边的天空", { exact: true });
      await expect(photos).toHaveCount(2);
      await expect.poll(() => photos.first().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(512);
      await expect(site.locator(".play-sky").getByText("后来补进来的照片")).toBeVisible();
      await site.getByLabel("查看历史版本").selectOption("1");
      await expect(site.locator(".play-sky").getByText("旧照片的湖")).toBeVisible();
      await expect.poll(() => photos.first().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    }

    const png = await takeExport(recoveredA, "导出天空拼贴 PNG");
    expect(png.subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
    await recoveredA.goto(origin + "/app/play/gallery");
    const filter = recoveredA.getByLabel("作品主题");
    await filter.selectOption("games");
    await expect(recoveredA.getByRole("link", { name: /甲的私人棋谱/ })).toBeVisible();
    await expect(recoveredA.getByRole("link", { name: /两扇恢复的窗|乙的私人天空/ })).toHaveCount(0);
    await filter.selectOption("world");
    await expect(recoveredA.getByText("这个主题还没有作品。")).toBeVisible();
    await filter.selectOption("create");
    const restoredCard = recoveredA.getByRole("link", { name: /两扇恢复的窗/ });
    await expect(restoredCard).toBeVisible();
    const restoredCover = restoredCard.locator(".play-work-cover img");
    await expect(restoredCover).toBeVisible();
    await expect.poll(() => restoredCover.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  } finally {
    await browser.close();
    await fixture.close();
  }
});
