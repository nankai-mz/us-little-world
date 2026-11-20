import { expect, type Page, type TestInfo } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { encryptRecord, unlockVault } from "../src/core/crypto";
import { preparePhotoWrite } from "../src/core/photo-write";
import type { Payload, Vault } from "../src/core/types";
import { openWebRepository } from "../src/server/web-repository";
import { markRecordChange } from "../src/server/web-sync";

async function writeSamples(a: Page, b: Page, origin: string, photo: string) {
  const results: { writer: string; syncMs: number; photoMs: number }[] = [];
  for (const { writer, reader, name } of [{ writer: a, reader: b, name: "甲" }, { writer: b, reader: a, name: "乙" }]) {
    await reader.goto(`${origin}/app/memories`);
    const search = reader.getByRole("textbox", { name: "搜索回忆" });
    await search.fill(`写入样本${name}`);
    for (let index = 1; index <= 10; index++) {
      const title = `写入样本${name} ${index}`;
      const image = `sample-${index}.png`;
      await writer.goto(`${origin}/app/memories/new`);
      await writer.getByLabel("这一页的小标题").fill(title);
      await writer.getByLabel("慢慢写，不用着急").fill(`合成正文 ${name} ${index}`);
      await writer.getByLabel("添加照片").setInputFiles({ name: image, mimeType: "image/png", buffer: Buffer.from(photo, "base64") });
      const modal = writer.getByRole("dialog");
      await expect(modal.getByRole("img", { name: image })).toBeVisible();
      const receipt = writer.waitForResponse((response) => response.url().endsWith("/api/space") &&
        response.request().postDataJSON()?.action === "putRecord");
      await modal.getByRole("button", { name: "收藏到我们的小世界" }).click();
      const reply = await receipt;
      expect((await reply.json()).success).toBe(true);
      const savedAt = performance.now();
      await expect(modal).toHaveCount(0);
      await reader.getByRole("button", { name: "刷新", exact: true }).click();
      const heading = reader.getByRole("heading", { name: title, exact: true });
      await expect(heading).toHaveCount(1, { timeout: 5000 });
      const syncMs = Math.round(performance.now() - savedAt);
      await heading.click();
      const detail = reader.getByRole("dialog");
      await expect(detail.getByText(`合成正文 ${name} ${index}`, { exact: true })).toBeVisible();
      await expect.poll(() => detail.getByRole("img", { name: image }).evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
      results.push({ writer: name, syncMs, photoMs: Math.round(performance.now() - savedAt) });
      await detail.getByRole("button", { name: "关闭", exact: true }).click();
    }
    await reader.reload();
    await search.fill(`写入样本${name}`);
    await expect(reader.getByRole("region", { name: "回忆时间轴" }).getByRole("heading", { level: 3 })).toHaveCount(10);
  }
  return results;
}

async function seedHistory(database: string, owner: Page, password: string, png: string) {
  const vault = await owner.evaluate(() => localStorage.getItem("us.web.first.vault"));
  if (!vault) throw new Error("Missing the synthetic test vault");
  const secrets = await unlockVault(JSON.parse(vault) as Vault, password);
  const keyVersion = Math.max(...Object.keys(secrets.spaceKeys).map(Number));
  const rng = async (bytes: number) => randomBytes(bytes);
  const db = openWebRepository(database);
  try {
    await db.repo.transaction(async (tx) => {
      for (let index = 1; index <= 1000; index++) {
        const rank = String(index).padStart(4, "0");
        const id = randomBytes(16).toString("hex");
        const { photo, envelope } = await preparePhotoWrite(png, "image/png", `历史照片-${rank}.png`, "shared", secrets, keyVersion, rng);
        const tags = ["历史规模千张", ...(index <= 300 ? ["历史规模三百张"] : []), ...(index <= 50 ? ["历史规模五十张"] : [])];
        const data: Payload = { kind: "memory", title: `合成历史 ${rank}`, date: "2020-01-01", tags, photos: [photo] };
        const meta = { id, spaceId: secrets.spaceId, creatorId: secrets.userId, visibility: "shared" as const,
          revision: 1, createdAt: index, updatedAt: index };
        const record = await encryptRecord(meta, data, secrets, rng, keyVersion);
        if (!tx.putPhoto) throw new Error("Missing the synthetic photo store");
        const storageId = await tx.putPhoto(photo.fileId, JSON.stringify(envelope));
        await tx.put("encrypted_files", photo.fileId, { id: photo.fileId, storageId, recordId: id,
          spaceId: secrets.spaceId, creatorId: secrets.userId, visibility: "shared", managed: true });
        await tx.put("encrypted_records", id, { ...record, photoRefs: [photo.fileId] });
        await markRecordChange(tx, secrets.spaceId, secrets.userId, record);
      }
    });
  } finally {
    db.close();
  }
}

export async function exerciseWebWorkload({ a, b, origin, database, password, png, info }: {
  a: Page; b: Page; origin: string; database: string; password: string; png: string; info: TestInfo;
}) {
  const writes = await writeSamples(a, b, origin, png);
  await seedHistory(database, a, password, png);
  await b.setViewportSize({ width: 360, height: 800 });
  const started = performance.now();
  await b.goto(`${origin}/app/home`);
  await expect(b.getByRole("button", { name: /写一篇日记/ })).toBeVisible();
  const homeMs = Math.round(performance.now() - started);
  await b.getByRole("button", { name: "时光", exact: true }).first().click();
  const timeline = b.getByRole("region", { name: "回忆时间轴" });
  await b.getByRole("textbox", { name: "搜索回忆" }).fill("合成历史");
  await expect(timeline.getByRole("status")).toHaveText("第 1–30 项，共 1000 项");
  const timelineMs = Math.round(performance.now() - started);
  await expect(timeline.locator(".memory-card")).toHaveCount(30);
  await timeline.getByRole("button", { name: "下一页" }).click();
  await expect(timeline.getByRole("status")).toHaveText("第 31–60 项，共 1000 项");
  await timeline.getByRole("heading", { level: 3 }).first().click();
  await b.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(timeline.getByRole("status")).toHaveText("第 31–60 项，共 1000 项");
  await b.getByRole("button", { name: "相册", exact: true }).click();
  const album = b.getByRole("region", { name: "回忆相册" });
  await expect(album.getByRole("status")).toHaveText("第 1–30 项，共 1000 项");
  await expect(album.locator(".polaroid")).toHaveCount(30);

  const galaxy = b.getByRole("region", { name: "回忆银河" });
  const cdp = await b.context().newCDPSession(b);
  const network = { offline: false, latency: 75, downloadThroughput: 1_125_000, uploadThroughput: 125_000 };
  const stars = [];
  try {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", network);
    await b.getByRole("button", { name: "回忆银河", exact: true }).click();
    for (const [count, tag] of [[50, "五十张"], [300, "三百张"], [1000, "千张"]] as const) {
      const start = performance.now();
      await b.getByRole("textbox", { name: "搜索回忆" }).fill(`历史规模${tag}`);
      if (count <= 300) {
        await galaxy.getByRole("button", { name: "星图", exact: true }).click();
        await expect(galaxy.locator(".galaxy-star")).toHaveCount(count);
      } else {
        await expect(galaxy.getByRole("button", { name: "星图", exact: true })).toBeDisabled();
        await expect(galaxy.getByText("1 / 34", { exact: true })).toBeVisible();
        await expect(galaxy.getByRole("listitem")).toHaveCount(30);
      }
      const readyMs = Math.round(performance.now() - start);
      const selectedAt = performance.now();
      await galaxy.getByRole("button", { name: "随机流星" }).click();
      const selected = galaxy.getByRole("region", { name: "选中的回忆照片" });
      await expect.poll(() => selected.getByRole("img").evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
      await selected.getByRole("button", { name: "关闭照片" }).click();
      stars.push({ count, readyMs, photoMs: Math.round(performance.now() - selectedAt) });
      const pageWidth = await b.evaluate(() => document.documentElement.scrollWidth);
      expect(pageWidth, `${count} 张照片在 360 px 视口中的页面宽度`).toBeLessThanOrEqual(360);
    }
    await b.getByRole("textbox", { name: "搜索回忆" }).fill("合成历史 1000");
    await galaxy.getByRole("button", { name: "随机流星" }).click();
    await expect(galaxy.getByRole("region", { name: "选中的回忆照片" }).getByRole("heading", { level: 3 })).toHaveText("合成历史 1000");
  } finally {
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await cdp.detach();
  }
  const evidence = info.outputPath("web-workload.json");
  const percent95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  await mkdir(dirname(evidence), { recursive: true });
  await writeFile(evidence, JSON.stringify({ historySize: 1000, browser: b.context().browser()?.version(), viewport: b.viewportSize(),
    homeMs, timelineMs, network, manualRefreshP95Ms: percent95(writes.map(({ syncMs }) => syncMs)),
    openPhotoP95Ms: percent95(writes.map(({ photoMs }) => photoMs)), writes, stars }, null, 2));
  await info.attach("web-workload", { path: evidence, contentType: "application/json" });
}
