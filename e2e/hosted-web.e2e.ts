import { chromium, test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { signIn, startReleaseFixture } from "./release-fixture";
import { exerciseWebWorkload } from "./web-workload";
import { spaceDay } from "../src/core/date";

test("独立浏览器配对、同步图文、隔离私人记录并恢复解锁", async ({}, info) => {
  test.setTimeout(240000);
  const firstPhrase = "first browser unlock phrase";
  const secondPhrase = "second browser unlock phrase";
  const fixture = await startReleaseFixture();
  const { accounts, certificatePin, dir, origin } = fixture;
  let browser: Browser | undefined;
  const contexts: BrowserContext[] = [];
  try {
    const launchedBrowser = browser = await chromium.launch({
      channel: process.env.US_WEB_BROWSER_CHANNEL,
      args: [`--ignore-certificate-errors-spki-list=${certificatePin}`],
    });
    const errors: string[] = [];
    const page = async (viewport: { width: number; height: number }) => {
      const context = await launchedBrowser.newContext({ viewport, ignoreHTTPSErrors: true });
      contexts.push(context);
      const tab = await context.newPage();
      tab.on("pageerror", (error) => errors.push(error.message));
      return tab;
    };
    const a = await page({ width: 1280, height: 720 });
    const b = await page({ width: 390, height: 844 });
    await signIn(a, origin, "first", accounts.first);
    await expect(a.getByRole("button", { name: "创建双人空间", exact: true })).toBeVisible();
    expect(await a.evaluate(() => window.isSecureContext)).toBe(true);
    const websiteCookie = (await a.context().cookies()).find(({ name }) => name === "__Host-us_session");
    expect(websiteCookie).toMatchObject({ path: "/", secure: true, httpOnly: true, sameSite: "Strict" });
    const health = await a.request.get(`${origin}/healthz`);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(health.headers()["strict-transport-security"]).toContain("max-age=");
    await a.getByRole("button", { name: "创建双人空间", exact: true }).click();
    await expect(a).toHaveURL(`${origin}/app/pair/create`);
    await a.getByLabel("本机解锁口令", { exact: false }).fill("temporary fixture password");
    await a.goBack();
    await expect(a.getByRole("button", { name: "创建双人空间", exact: true })).toBeVisible();
    await a.goForward();
    await expect(a.getByLabel("本机解锁口令", { exact: false })).toHaveValue("");
    await a.reload();
    await a.getByLabel("给我们的空间起个名字").fill("合成双人验收空间");
    await a.getByLabel("本机解锁口令", { exact: false }).fill(firstPhrase);
    await a.getByRole("button", { name: "创建我们的空间" }).click();
    await a.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await a.goto(`${origin}/app/settings`);
    await a.getByRole("button", { name: /设备与安全/ }).click();
    await expect(a).toHaveURL(`${origin}/app/settings/devices`);
    await a.reload();
    await expect(a.getByRole("heading", { name: "我们之间的安全感" })).toBeVisible();
    await a.getByRole("button", { name: "生成一次性邀请码" }).click();
    await expect(a.locator(".invitation")).not.toBeEmpty();
    const invitation = (await a.locator(".invitation").innerText()).trim();
    const creatorCode = (await a.locator(".safety-code").innerText()).trim();

    await signIn(b, origin, "second", accounts.second);
    await expect(b.getByRole("button", { name: "输入邀请码加入" })).toBeVisible();
    await b.goto(`${origin}/app/pair/create`);
    await expect(b).toHaveURL(`${origin}/app/home`);
    await expect(b.getByLabel("给我们的空间起个名字")).toHaveCount(0);
    await b.getByRole("button", { name: "输入邀请码加入" }).click();
    await expect(b).toHaveURL(`${origin}/app/pair/join`);
    await b.getByLabel("一次性邀请码").fill(invitation);
    await b.getByLabel("本机解锁口令", { exact: false }).fill(secondPhrase);
    await b.getByRole("button", { name: "加入双人空间", exact: true }).click();
    await expect(b.getByRole("heading", { name: "已加入双人空间" })).toBeVisible();
    await expect(b).toHaveURL(`${origin}/app/pair/keys`);
    await b.reload();
    const visitorCode = await b.getByLabel("我的设备安全码").inputValue();
    await a.getByRole("button", { name: "刷新设备列表" }).click();
    const sender = a.getByRole("button", { name: "发送空间密钥" });
    await a.getByLabel("对方的设备安全码").fill("INVALID-FINGERPRINT");
    await expect(sender).toBeDisabled();
    await a.getByLabel("对方的设备安全码").fill(visitorCode);
    await sender.click();
    await a.getByLabel("重新输入网站密码").fill(accounts.first);
    await a.getByRole("button", { name: "验证并继续" }).click();
    await expect(a.getByRole("status")).toHaveText("空间密钥已发送");
    await b.getByLabel("对方的设备安全码").fill("INVALID-FINGERPRINT");
    await b.getByRole("button", { name: "接收空间密钥" }).click();
    await expect(b.getByRole("status")).toContainText("尚未收到匹配");
    await b.getByLabel("对方的设备安全码").fill(creatorCode);
    await b.getByRole("button", { name: "接收空间密钥" }).click();
    await b.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await expect(b).toHaveURL(`${origin}/app/home`);

    await b.goto(`${origin}/app/settings`);
    await b.getByRole("button", { name: "修改昵称" }).click();
    await b.getByLabel("共同空间显示的昵称").fill("合成昵称");
    await b.getByRole("button", { name: "保存昵称" }).click();
    await expect(b.getByRole("heading", { name: "合成昵称" })).toBeVisible();

    await a.goto(`${origin}/app/home`);
    await expect(a.locator(".side-space strong")).toContainText("合成昵称");
    await expect(a.locator(".hero-avatars")).toContainText("合成昵称");
    const photoPicker = a.waitForEvent("filechooser");
    await a.getByRole("button", { name: /收藏新照片/ }).click();
    await (await photoPicker).setFiles([]);
    await expect(a).toHaveURL(/\/app\/memories\/new$/);
    await a.getByLabel("这一页的小标题").fill("合成共同图文");
    const [year, month, date] = spaceDay().split("-");
    const pastDate = `${Number(year) - (month === "02" && date === "29" ? 4 : 1)}-${month}-${date}`;
    await a.getByLabel("记录日期").fill(pastDate);
    const png = await a.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 12;
      canvas.height = 8;
      const drawing = canvas.getContext("2d")!;
      drawing.fillStyle = "#db9eaa";
      drawing.fillRect(0, 0, 12, 8);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await a.getByLabel("添加照片").setInputFiles([
      { name: "broken.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not an image") },
      { name: "fixture.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") },
    ]);
    await expect(a.getByRole("img", { name: "fixture.png" })).toBeVisible();
    await expect(a.getByText("broken.jpg", { exact: true })).toBeVisible();
    await expect(a.getByRole("button", { name: "重试此照片" })).toBeEnabled();
    await a.getByRole("button", { name: "移除失败照片" }).click();
    let puts = 0;
    await a.route("**/api/space", async (route) => {
      const action = route.request().postDataJSON()?.action;
      if (action === "putRecord") {
        puts++;
        const response = await route.fetch({ maxRetries: 0 });
        expect((await response.json()).success).toBe(true);
        await route.abort();
      } else if (action === "mutationStatus") await route.abort();
      else await route.continue();
    });
    await a.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(a.getByRole("button", { name: "核对并继续原保存" })).toBeVisible();
    expect(puts).toBe(1);
    await a.unroute("**/api/space");
    await a.reload();
    await a.getByRole("button", { name: "核对并继续原保存" }).click();
    await expect(a.getByRole("dialog")).toHaveCount(0);
    await a.getByRole("button", { name: /写一篇日记/ }).click();
    await a.getByLabel("这一页的小标题").fill("仅第一位成员可见");
    await a.getByLabel("谁可以看见").selectOption("private");
    await a.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(a.getByRole("dialog")).toHaveCount(0);

    await b.goto(`${origin}/app/memories`);
    await expect(b.getByText("合成共同图文", { exact: true })).toBeVisible();
    await expect(b.getByText("仅第一位成员可见", { exact: true })).toHaveCount(0);
    await b.goto(`${origin}/app/album`);
    await expect(b.getByRole("img", { name: "fixture.png" })).toBeVisible();
    await b.goBack();
    await expect(b.getByText("合成共同图文", { exact: true })).toBeVisible();
    await b.reload();
    await expect(b.getByText("合成共同图文", { exact: true })).toBeVisible();
    expect(await b.getByText("合成共同图文", { exact: true }).count()).toBe(1);
    await b.getByRole("heading", { name: "合成共同图文", exact: true }).click();
    await expect(b).toHaveURL(/\/app\/memories\/[a-f0-9]{32}$/);
    await b.reload();
    await expect(b.getByRole("dialog").getByRole("heading", { name: "合成共同图文" })).toBeVisible();
    await b.goBack();
    await expect(b.getByRole("dialog")).toHaveCount(0);
    const unavailable = `${origin}/app/memories/${"0".repeat(32)}`;
    await b.goto(unavailable);
    await expect(b).toHaveURL(`${origin}/app/memories`);
    await expect(b.getByRole("status")).toContainText("当前账号无法访问");
    await b.goto(`${origin}/app/home`);
    await b.getByRole("button", { name: /写一篇日记/ }).click();
    await b.evaluate(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "us.web.second.draft") throw new DOMException("Fixture storage failure", "QuotaExceededError");
        setItem.call(this, key, value);
      };
    });
    await b.getByLabel("这一页的小标题").fill("尚未保存的合成草稿");
    await expect(b.getByText("草稿保存失败，请保留当前编辑内容")).toBeVisible();
    b.once("dialog", (dialog) => dialog.dismiss());
    await b.goBack();
    await expect(b).toHaveURL(/\/app\/memories\/new$/);
    await expect(b.getByLabel("这一页的小标题")).toHaveValue("尚未保存的合成草稿");
    b.once("dialog", (dialog) => dialog.accept());
    await b.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();

    async function readCachedCiphertext(tab: Page, name = "snapshots") {
      return tab.evaluate(async (storeName) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("us-web-cipher");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          const snapshots = await new Promise<{ payload: string | Blob }[]>((resolve, reject) => {
            const request = db.transaction(storeName).objectStore(storeName).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          return Promise.all(snapshots.map(({ payload }) =>
            typeof payload === "string" ? payload : payload.text()));
        } finally { db.close(); }
      }, name);
    }
    await b.goto(`${origin}/app/settings`);
    const cache = b.getByRole("checkbox", { name: /本机密文缓存/ });
    await expect(cache).not.toBeChecked();
    await cache.check();
    await expect(cache).toBeChecked();
    await expect(cache).toBeEnabled();
    const cached = await readCachedCiphertext(b);
    expect(cached).toHaveLength(1);
    expect(cached[0]).not.toContain("合成共同图文");
    expect(cached[0]).not.toContain("仅第一位成员可见");
    const beforeReload = b.waitForRequest((req) =>
      req.url().endsWith("/api/space") && req.postDataJSON()?.action === "syncRecords",
    );
    await b.goto(`${origin}/app/memories`);
    expect((await beforeReload).postDataJSON().data.cursor).toBe(JSON.parse(cached[0]).cursor);
    await expect(b.getByText("合成共同图文", { exact: true })).toBeVisible();
    await b.getByRole("heading", { name: "合成共同图文", exact: true }).click();
    const photoOnline = b.getByRole("dialog").getByRole("img", { name: "fixture.png" });
    await expect(photoOnline).toBeVisible();
    await expect(photoOnline).toHaveAttribute("src", /^blob:/);
    const plaintextPhoto = await photoOnline.evaluate(async (image: HTMLImageElement) => {
      const bytes = new Uint8Array(await (await fetch(image.src)).arrayBuffer());
      return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
    });
    const encryptedPhotos = await readCachedCiphertext(b, "photos");
    expect(encryptedPhotos.length).toBeGreaterThan(0);
    expect(encryptedPhotos.every((item) => !item.includes(plaintextPhoto) && !item.includes("fixture.png"))).toBe(true);
    await b.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    const authorizeCachedPhoto = b.waitForResponse((response) => {
      const request = response.request();
      const payload = request.url().endsWith("/api/space") && request.postDataJSON();
      return payload?.action === "fileGet" && payload.data?.cached === true;
    });
    await b.goto(`${origin}/app/memories`);
    expect(await (await authorizeCachedPhoto).json()).toMatchObject({ success: true, data: { unchanged: true } });
    const cover = b.getByRole("button", { name: /合成共同图文/ }).getByRole("img", { name: "fixture.png" });
    await expect(cover).toBeVisible();
    const sharedUrl = await cover.getAttribute("src");
    await b.getByRole("heading", { name: "合成共同图文", exact: true }).click();
    await expect(photoOnline).toBeVisible();
    await expect(photoOnline).toHaveAttribute("src", sharedUrl!);
    await b.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    async function inspectPhotoStorage(tab: Page, seed = false) {
      return tab.evaluate(async (addFixtures) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = indexedDB.open("us-web-cipher");
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        try {
          return await new Promise<{ ids: string[]; bytes: number }>((resolve, reject) => {
            const transaction = db.transaction("photos", addFixtures ? "readwrite" : "readonly");
            const store = transaction.objectStore("photos");
            const request = store.getAll();
            const bytesOf = (payload: string | Blob) =>
              typeof payload === "string" ? new TextEncoder().encode(payload).length : payload.size;
            request.onsuccess = () => {
              if (!addFixtures) return;
              const existing = request.result[0];
              const large = "synthetic-photo-ciphertext".repeat(350000);
              for (const row of request.result) store.delete([row.account, row.scope, row.fileId]);
              store.put({ ...existing, fileId: "quota-older", updatedAt: Date.now() - 3000, payload: large, byteSize: large.length });
              store.put({ ...existing, fileId: "quota-newer", updatedAt: Date.now() - 2000, payload: large, byteSize: large.length });
            };
            transaction.oncomplete = () => resolve({
              ids: request.result.map(({ fileId }) => fileId),
              bytes: request.result.reduce((total, { payload }) => total + bytesOf(payload), 0),
            });
            transaction.onabort = () => reject(transaction.error);
          });
        } finally { db.close(); }
      }, seed);
    }
    await inspectPhotoStorage(b, true);
    await b.goto(`${origin}/app/memories`);
    await b.getByRole("heading", { name: "合成共同图文", exact: true }).click();
    await expect(photoOnline).toBeVisible();
    const retained = await inspectPhotoStorage(b);
    expect(retained.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(retained.ids).toContain("quota-newer");
    expect(retained.ids).not.toContain("quota-older");
    await b.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    const installManifest = await b.request.get(`${origin}/manifest.webmanifest`);
    expect(installManifest.headers()["content-type"]).toContain("application/manifest+json");
    expect(await installManifest.json()).toMatchObject({ display: "standalone", start_url: "/app/home" });
    await expect.poll(() => b.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const filesCachedByWorker = await b.evaluate(async () => {
      const pageCaches = await caches.keys();
      return (await Promise.all(pageCaches.map(async (key) => (await (await caches.open(key)).keys())
        .map((request) => new URL(request.url).pathname)))).flat();
    });
    expect(filesCachedByWorker).toContain("/offline-shell.html");
    expect(filesCachedByWorker.every((path) => path === "/offline-shell.html" || path === "/__us-shell-installed" ||
      path === "/manifest.webmanifest" || path.startsWith("/assets/"))).toBe(true);
    fixture.setUpstreamUnavailable(true);
    expect((await b.request.get(`${origin}/healthz`)).status()).toBe(503);
    await b.goto(`${origin}/app/memories`);
    await expect(b.getByRole("heading", { name: "离线日记" })).toBeVisible();
    fixture.setUpstreamUnavailable(false);
    // Engine network emulation is not applied to service worker sessions, so the fixture
    // must also stop forwarding: otherwise the worker answers navigations from the live
    // server instead of falling back to the cached offline shell.
    await b.context().setOffline(true);
    fixture.setNetworkAvailable(false);
    await b.goto(`${origin}/app/memories`);
    await expect(b.getByRole("heading", { name: "离线日记" })).toBeVisible();
    await expect(b.getByText("合成共同图文", { exact: true })).toHaveCount(0);
    await b.getByLabel("本机解锁口令").fill("wrong unlock phrase");
    await b.getByRole("button", { name: "解锁离线日记" }).click();
    await expect(b.getByRole("alert")).toHaveText("本机解锁口令不正确。");
    await b.getByLabel("本机解锁口令").fill(secondPhrase);
    await b.getByRole("button", { name: "解锁离线日记" }).click();
    await expect(b.getByRole("heading", { name: "合成共同图文" })).toBeVisible();
    await expect(b.getByText("仅第一位成员可见", { exact: true })).toHaveCount(0);
    const cachedMemory = b.locator("article").filter({ has: b.getByRole("heading", { name: "合成共同图文" }) });
    await cachedMemory.getByText("查看离线照片", { exact: true }).click();
    const photoOffline = cachedMemory.getByRole("img", { name: "fixture.png" });
    await expect.poll(() => photoOffline.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(12);
    await expect(photoOffline).toHaveAttribute("src", /^blob:/);
    await cachedMemory.getByRole("button", { name: "编辑这条日记" }).click();
    await b.getByLabel("日记正文").fill("离线重开后编辑的正文");
    await b.getByRole("button", { name: "保存到待同步队列" }).click();
    await expect(cachedMemory.getByRole("button", { name: "编辑这条日记" })).toBeDisabled();
    await b.getByRole("button", { name: "写离线日记" }).click();
    await b.getByLabel("日记标题").fill("离线重开后的私人日记");
    await b.getByLabel("谁可以看见").selectOption("private");
    await b.getByLabel("添加离线照片").setInputFiles({
      name: "offline-private.png", mimeType: "image/png", buffer: Buffer.from(png, "base64"),
    });
    await expect(b.getByText("offline-private.png", { exact: false })).toBeVisible();
    await b.getByRole("button", { name: "保存到待同步队列" }).click();
    await expect(b.getByRole("heading", { name: "待同步日记（2）" })).toBeVisible();
    await b.reload();
    await b.getByLabel("本机解锁口令").fill(secondPhrase);
    await b.getByRole("button", { name: "解锁离线日记" }).click();
    await expect(b.getByRole("heading", { name: "待同步日记（2）" })).toBeVisible();
    await expect(b.getByText("离线重开后的私人日记", { exact: true })).toBeVisible();
    const pendingOnDisk = b.getByRole("region", { name: "本机待同步日记" });
    const pendingTitle = pendingOnDisk.getByText("离线重开后的私人日记", { exact: true });
    const pendingPrivate = pendingOnDisk.locator("details").filter({ has: b.getByText("离线重开后的私人日记", { exact: true }) });
    await pendingTitle.click();
    await pendingPrivate.getByText("查看离线照片", { exact: true }).click();
    await expect(pendingPrivate.getByRole("img", { name: "offline-private.png" })).toBeVisible();
    await b.getByRole("button", { name: "锁定离线日记" }).click();
    await expect(b.getByRole("heading", { name: "合成共同图文" })).toHaveCount(0);
    await b.clock.setFixedTime(new Date(Date.now() + 25 * 3600000));
    await b.getByLabel("本机解锁口令").fill(secondPhrase);
    await b.getByRole("button", { name: "解锁离线日记" }).click();
    await expect(b.getByRole("alert")).toHaveText("没有仍在有效期内的本机缓存，请联网同步。");
    await b.clock.setFixedTime(new Date());
    fixture.setNetworkAvailable(true);
    await b.context().setOffline(false);
    await expect(b.getByRole("heading", { name: "离线日记" })).toHaveCount(0);
    await expect(b.getByText("合成共同图文", { exact: true })).toBeVisible();
    await b.goto(`${origin}/app/settings`);
    await b.getByRole("button", { name: /连接与同步/ }).click();
    const coldQueue = b.getByRole("region", { name: "待同步队列" });
    await expect(coldQueue.getByRole("heading")).toHaveText("待同步队列（2）");
    let interruptPhoto = true;
    let uploadedPhoto = false;
    let privateWrites = 0;
    await b.route("**/api/space", async (route) => {
      const { action, data } = route.request().postDataJSON();
      if (action === "fileUploadPart" && interruptPhoto) {
        await route.abort();
      } else if (action === "fileUploadCommit") {
        const result = await route.fetch();
        uploadedPhoto = (await result.json()).success === true;
        await route.fulfill({ response: result });
      } else {
        if (action === "putRecord" && data.record?.visibility === "private") {
          expect(uploadedPhoto).toBe(true);
          privateWrites++;
        }
        await route.continue();
      }
    });
    await coldQueue.getByRole("button", { name: "同步待发送日记" }).click();
    await expect(coldQueue.getByRole("heading")).toHaveText("待同步队列（1）");
    expect(privateWrites).toBe(0);
    await coldQueue.getByText("离线重开后的私人日记", { exact: true }).click();
    await expect(coldQueue.getByText("等待重试", { exact: true })).toBeVisible();
    interruptPhoto = false;
    await coldQueue.getByRole("button", { name: "同步待发送日记" }).click();
    await expect(coldQueue.getByRole("heading")).toHaveText("待同步队列（0）");
    expect(privateWrites).toBe(1);
    await b.unroute("**/api/space");
    await b.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await b.goto(`${origin}/app/memories`);
    await b.getByRole("heading", { name: "离线重开后的私人日记", exact: true }).click();
    await expect(b.getByRole("dialog").getByRole("img", { name: "offline-private.png" })).toBeVisible();
    await b.goto(`${origin}/app/settings`);
    await a.goto(`${origin}/app/memories`);
    await a.getByRole("heading", { name: "合成共同图文", exact: true }).click();
    await expect(a.getByRole("dialog").locator(".detail-body")).toHaveText("离线重开后编辑的正文");
    await expect(a.getByText("离线重开后的私人日记", { exact: true })).toHaveCount(0);
    fixture.publishWorkerUpdate();
    await b.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
    const update = b.getByRole("button", { name: "有新版本，更新并重新打开" });
    await expect(update).toBeVisible();
    await Promise.all([b.waitForEvent("load"), update.click()]);
    await expect(cache).toBeChecked();
    expect(await b.evaluate(async () => (await caches.keys()).some((name) => name.endsWith("-fixture-update")))).toBe(true);
    await cache.uncheck();
    await expect(cache).not.toBeChecked();
    await expect(cache).toBeEnabled();
    expect(await readCachedCiphertext(b)).toEqual([]);
    expect(await readCachedCiphertext(b, "photos")).toEqual([]);

    await b.goto(`${origin}/app/settings`);
    await b.getByRole("button", { name: /导出我的回忆/ }).click();
    await b.getByRole("button", { name: "导出可读图文归档" }).click();
    await b.getByLabel("确认本机解锁口令").fill("wrong unlock phrase");
    await b.getByRole("button", { name: "确认并下载 ZIP" }).click();
    await expect(b.getByRole("status")).toHaveText("本机解锁口令不正确");
    await b.getByLabel("确认本机解锁口令").fill(secondPhrase);
    const [archive] = await Promise.all([
      b.waitForEvent("download"),
      b.getByRole("button", { name: "确认并下载 ZIP" }).click(),
    ]);
    const files = unzipSync(await readFile(await archive.path()));
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    expect(manifest).toMatchObject({ photos: 1, failedPhotos: [] });
    expect(strFromU8(files["records.json"])).not.toContain("仅第一位成员可见");
    const picture = Object.keys(files).find((filename) => /^photos\/\d+-\d+\.png$/.test(filename));
    expect(picture).toBeDefined();
    const unpacked = join(dir, "archive");
    await mkdir(join(unpacked, "photos"), { recursive: true });
    await writeFile(join(unpacked, picture!), files[picture!]);
    await writeFile(join(unpacked, "index.html"), files["index.html"]);
    const offlineContext = await launchedBrowser.newContext({ offline: true });
    contexts.push(offlineContext);
    const offline = await offlineContext.newPage();
    await offline.goto(pathToFileURL(join(unpacked, "index.html")).href);
    await expect(offline.getByRole("heading", { name: "合成共同图文" })).toBeVisible();
    await expect.poll(() => offline.getByRole("img", { name: "fixture.png" }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

    await b.getByRole("button", { name: /导出我的回忆/ }).click();
    await b.getByRole("button", { name: "导出可读图文归档" }).click();
    await b.route("**/api/space", async (route) => {
      if (route.request().postDataJSON()?.action === "fileGet") await route.fulfill({
        json: { success: false, error: { code: "FORBIDDEN", message: "测试照片缺失" } },
      });
      else await route.continue();
    });
    await b.getByLabel("确认本机解锁口令").fill(secondPhrase);
    const [partial] = await Promise.all([b.waitForEvent("download"), b.getByRole("button", { name: "确认并下载 ZIP" }).click()]);
    const partialFiles = unzipSync(await readFile(await partial.path()));
    expect(JSON.parse(strFromU8(partialFiles["manifest.json"]))).toMatchObject({ photos: 0, failedPhotos: [{ name: "fixture.png" }] });
    await b.unroute("**/api/space");

    async function openEditor(tab: Page, title: string) {
      await tab.getByRole("heading", { name: title, exact: true }).click();
      await tab.getByRole("button", { name: "编辑这一页" }).click();
    }
    await Promise.all([a.goto(`${origin}/app/memories`), b.goto(`${origin}/app/memories`)]);
    await Promise.all([openEditor(a, "合成共同图文"), openEditor(b, "合成共同图文")]);
    await a.getByLabel("这一页的小标题").fill("第一位更新的标题");
    await b.getByLabel("慢慢写，不用着急").fill("第二位保留的正文");
    await a.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(a.getByRole("dialog")).toHaveCount(0);
    await b.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(b.getByRole("button", { name: "查看最新版本" })).toBeVisible();
    await b.reload();
    await expect(b).toHaveURL(/\/app\/memories\/[a-f0-9]{32}\/edit$/);
    await expect(b.getByLabel("慢慢写，不用着急")).toHaveValue("第二位保留的正文");
    await expect(b.getByRole("button", { name: "收藏到我们的小世界" })).toBeDisabled();
    await b.getByRole("button", { name: "保留我的编辑，以此版本为基础" }).click();
    await expect(b.getByLabel("这一页的小标题")).toHaveValue("第一位更新的标题");
    await b.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(b.getByRole("dialog")).toHaveCount(0);
    await expect(b.getByText("第二位保留的正文", { exact: true })).toBeVisible();

    await a.getByRole("button", { name: "隐私与安全" }).click();
    await expect(a.getByRole("heading", { name: "我们之间的安全感" })).toBeVisible();

    await Promise.all([a.goto(`${origin}/app/home`), b.goto(`${origin}/app/home`)]);
    await expect(a.getByRole("region", { name: "站内想你" })).toBeVisible();
    for (const tab of [a, b]) {
      await expect(tab.getByRole("region", { name: "那年今日" }).getByRole("button", { name: /第一位更新的标题/ })).toBeVisible();
    }
    await a.getByRole("button", { name: "发送想你" }).click();
    await expect(a.getByText("今天的想你已发送", { exact: true })).toBeVisible();
    await b.reload();
    await b.getByRole("button", { name: "回送", exact: true }).click();
    await expect(b.getByRole("button", { name: "撤回回送" })).toBeVisible();
    await a.reload();
    await expect(a.getByText("对方已回送", { exact: true })).toBeVisible();
    await a.getByRole("button", { name: "撤回想你" }).click();
    await expect(a.getByRole("button", { name: "发送想你" })).toBeVisible();
    await b.reload();
    await expect(b.getByRole("button", { name: "发送想你" })).toBeVisible();
    await expect(b.getByText(/对方想你/)).toHaveCount(0);

    for (const tab of [a, b]) {
      await tab.goto(`${origin}/app/play/food`);
    }
    async function addMeal(tab: Page, name: string, price: string, tags: string) {
      await tab.getByLabel("菜品或餐厅").fill(name);
      await tab.getByLabel("预计价格（元，可留空）").fill(price);
      await tab.getByLabel("食材标签（用逗号分隔）").fill(tags);
      await tab.getByRole("button", { name: "添加候选" }).click();
      await expect(tab.getByRole("region", { name: "选餐候选" }).getByText(name, { exact: true })).toBeVisible();
    }
    await addMeal(a, "清汤面", "24", "");
    await a.getByLabel("清汤面偏好").selectOption("want");
    await addMeal(b, "花生拌面", "32", "花生");
    await a.bringToFront();
    await a.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(a.getByLabel("花生拌面偏好")).toBeVisible();
    await expect(a.getByLabel("清汤面偏好")).toHaveValue("want");
    await expect(a.getByText(/已保留仍在列表中的选择/)).toBeVisible();
    await b.getByText("预算与忌口", { exact: true }).click();
    await b.getByLabel(/我的忌口标签/).fill("花生");
    await b.getByRole("button", { name: "保存忌口" }).click();
    await expect(b.getByText("花生拌面 · 与忌口标签冲突")).toBeVisible();
    for (const tab of [a, b]) {
      await tab.reload();
      await tab.getByLabel("清汤面偏好").selectOption("want");
      await tab.getByLabel("花生拌面偏好").selectOption("okay");
      await tab.getByRole("button", { name: "提交偏好" }).click();
      await expect(tab.getByRole("button", { name: "撤回我的偏好" })).toBeVisible();
    }
    const ranked = b.getByRole("region", { name: "共同接受的候选" });
    await expect(ranked.getByRole("button", { name: "采纳 花生拌面" })).toHaveCount(0);
    await ranked.getByRole("button", { name: "采纳 清汤面" }).click();
    await b.getByRole("button", { name: "保存为共同回忆" }).click();
    await expect(b.getByRole("button", { name: "查看共同回忆" })).toBeVisible();
    await a.reload();
    await a.getByRole("button", { name: "查看共同回忆" }).click();
    await expect(a.getByRole("dialog").getByRole("heading", { name: "晚餐吃清汤面" })).toBeVisible();
    await expect(a.getByRole("dialog").locator(".detail-body")).toHaveText("预计预算 24 元");
    await a.getByRole("dialog").getByRole("button", { name: "还想再来" }).click();
    await expect(a.getByRole("dialog").locator(".ink-stamp")).toHaveCount(1);
    await b.getByRole("button", { name: "查看共同回忆" }).click();
    await b.getByRole("dialog").getByRole("button", { name: "下次换一家" }).click();
    await expect(b.getByRole("dialog").locator(".ink-stamp")).toHaveCount(2);
    await expect(b.getByRole("dialog").locator(".meal-slip")).toContainText("合成昵称 · 下次换一家");

    for (const tab of [a, b]) {
      await tab.goto(`${origin}/app/play/wardrobe`);
    }
    await a.getByLabel("衣物名称").fill("合成白衬衫");
    await a.getByLabel("私人衣物照片（可选）").setInputFiles({
      name: "wardrobe-private.png", mimeType: "image/png", buffer: Buffer.from(png, "base64"),
    });
    await a.getByRole("button", { name: "添加私人衣物" }).click();
    await expect(a.getByRole("img", { name: "wardrobe-private.png" })).toBeVisible();
    await a.getByLabel("衣物名称").fill("未共享的裤子");
    await a.getByLabel("衣物类别").selectOption("下装");
    await a.getByRole("button", { name: "添加私人衣物" }).click();
    await expect(a.getByLabel("共享 未共享的裤子")).toBeVisible();
    await a.getByLabel("共享 合成白衬衫").check();
    const publishPhoto = a.getByLabel("同时共享 合成白衬衫 的照片");
    await expect(publishPhoto).not.toBeChecked();
    await a.getByLabel("天气备注（可留空）").fill("阴天");
    await a.getByRole("button", { name: "更新共享衣物" }).click();
    await expect(a.getByRole("button", { name: "撤回全部共享" })).toBeVisible();
    await b.reload();
    const otherCloset = b.getByRole("region", { name: "对方共享的衣物" });
    await expect(otherCloset.getByText("天气备注：阴天")).toBeVisible();
    await otherCloset.getByLabel("上装").selectOption({ label: "合成白衬衫" });
    await expect(otherCloset.getByLabel("下装")).toHaveCount(0);
    await expect(b.getByRole("img", { name: "wardrobe-private.png" })).toHaveCount(0);
    await expect(otherCloset.getByRole("img")).toHaveCount(0);
    await publishPhoto.check();
    await a.getByRole("button", { name: "更新共享衣物" }).click();
    await expect(a.getByText(/已共享名称和照片/)).toBeVisible();
    const photoRequest = b.waitForRequest((request) => request.url().endsWith("/api/space") && request.postDataJSON()?.action === "fileGet");
    await b.reload();
    const previewRequest = (await photoRequest).postDataJSON();
    const sharedPreview = otherCloset.getByRole("img", { name: "合成白衬衫的共享预览" });
    await expect.poll(() => sharedPreview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(12);
    await otherCloset.getByLabel("上装").selectOption({ label: "合成白衬衫" });
    await otherCloset.getByRole("button", { name: "发送搭配建议" }).click();
    await expect(b.getByRole("status")).toHaveText("已发送搭配建议");
    await a.reload();
    await a.getByRole("button", { name: "采纳搭配" }).click();
    await expect(a.getByRole("region", { name: "收到的搭配" }).getByText("已采纳", { exact: true })).toBeVisible();
    await b.reload();
    await expect(otherCloset.getByText("对方已采纳这次搭配。")).toBeVisible();
    await b.goto(`${origin}/app/settings`);
    await b.getByRole("button", { name: /导出我的回忆/ }).click();
    await b.getByRole("button", { name: "导出可读图文归档" }).click();
    await b.getByLabel("确认本机解锁口令").fill(secondPhrase);
    const [wardrobeArchive] = await Promise.all([b.waitForEvent("download"), b.getByRole("button", { name: "确认并下载 ZIP" }).click()]);
    const wardrobeFiles = unzipSync(await readFile(await wardrobeArchive.path()));
    const wardrobeRecords = strFromU8(wardrobeFiles["records.json"]);
    expect(wardrobeRecords).toContain("合成白衬衫");
    expect(wardrobeRecords).toContain("合成白衬衫的共享预览");
    expect(wardrobeRecords).not.toContain("未共享的裤子");
    expect(wardrobeRecords).not.toContain("wardrobe-private.png");
    await publishPhoto.uncheck();
    await a.getByRole("button", { name: "更新共享衣物" }).click();
    await expect(a.getByText(/已共享名称和照片/)).toHaveCount(0);
    await b.goto(`${origin}/app/play/wardrobe`);
    await expect(otherCloset.getByLabel("上装")).toBeVisible();
    await expect(sharedPreview).toHaveCount(0);
    const revokedPreview = await b.request.post(`${origin}/api/space`, {
      data: { ...previewRequest, data: { ...previewRequest.data, cached: true } },
      headers: { Origin: origin, "X-Us-Account": "second" },
    });
    expect(await revokedPreview.json()).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    await expect(a.getByRole("img", { name: "wardrobe-private.png" })).toBeVisible();
    await a.getByRole("button", { name: "撤回全部共享" }).click();
    await expect(a.getByRole("button", { name: "撤回全部共享" })).toHaveCount(0);
    await b.goto(`${origin}/app/play/wardrobe`);
    await expect(otherCloset.getByText("对方还没有共享衣物。")).toBeVisible();
    await expect(otherCloset.getByText("合成白衬衫")).toHaveCount(0);

    await Promise.all([a.goto(`${origin}/app/home`), b.goto(`${origin}/app/home`)]);
    await expect(a.getByRole("button", { name: /写一篇日记/ })).toBeVisible();

    await a.context().setOffline(true);
    for (const [title, visibility] of [["待同步的共同日记", "shared"], ["待同步的私人日记", "private"]]) {
      await a.getByRole("button", { name: /写一篇日记/ }).click();
      await a.getByLabel("这一页的小标题").fill(title);
      await a.getByLabel("谁可以看见").selectOption(visibility);
      if (visibility === "shared") {
        await a.getByLabel("添加照片").setInputFiles({
          name: "warm-offline.png", mimeType: "image/png", buffer: Buffer.from(png, "base64"),
        });
        await expect(a.getByText("warm-offline.png", { exact: false })).toBeVisible();
      }
      await a.getByRole("button", { name: "先存本机，稍后同步" }).click();
      await expect(a.getByRole("dialog")).toHaveCount(0);
    }
    const queued = await a.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("us-web-outbox", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<{ scope: string }[]>((resolve, reject) => {
          const request = db.transaction("writes").objectStore("writes").getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally { db.close(); }
    });
    expect(queued).toHaveLength(2);
    expect(JSON.stringify(queued)).not.toContain("待同步的");
    expect(JSON.stringify(queued)).not.toContain("warm-offline.png");
    expect(queued.some((item) => (item as { attachments?: object[] }).attachments?.length === 1)).toBe(true);
    await a.evaluate(() => window.addEventListener("online", (event) => event.stopImmediatePropagation(), { capture: true, once: true }));
    await a.context().setOffline(false);
    await a.goto(`${origin}/app/settings`);
    await a.getByRole("button", { name: /连接与同步/ }).click();
    const outbox = a.getByRole("region", { name: "待同步队列" });
    await expect(outbox.getByRole("heading")).toHaveText("待同步队列（2）");
    await expect(outbox.getByText("待同步的共同日记")).toBeVisible();
    await expect(outbox.getByText("待同步的私人日记")).toBeVisible();
    const concurrentTab = await a.context().newPage();
    await concurrentTab.goto(`${origin}/app/settings`);
    await concurrentTab.evaluate((scope) => new Promise<void>((locked) => {
      void navigator.locks.request(`us-outbox:${scope}`, () => new Promise<void>((release) => {
        window.addEventListener("test-release-writer", () => release(), { once: true });
        locked();
      }));
    }), queued[0].scope);
    await outbox.getByRole("button", { name: "同步待发送日记" }).click();
    await expect(a.getByRole("status")).toHaveText("另一个标签页正在同步，请稍后重试");
    await expect(outbox.getByRole("heading")).toHaveText("待同步队列（2）");
    await concurrentTab.evaluate(() => window.dispatchEvent(new Event("test-release-writer")));
    await concurrentTab.close();
    await outbox.getByRole("button", { name: "同步待发送日记" }).click();
    await expect(outbox.getByRole("heading")).toHaveText("待同步队列（0）");
    await b.goto(`${origin}/app/memories`);
    await expect(b.getByRole("heading", { name: "待同步的共同日记" })).toBeVisible();
    await expect(b.getByRole("heading", { name: "待同步的私人日记" })).toHaveCount(0);
    await b.getByRole("heading", { name: "待同步的共同日记", exact: true }).click();
    await expect(b.getByRole("dialog").getByRole("img", { name: "warm-offline.png" })).toBeVisible();
    await b.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();

    for (let group = 0; group < 3; group += 1) {
      await a.goto(`${origin}/app/memories/new`);
      await a.getByLabel("这一页的小标题").fill(`银河夹具 ${group + 1}`);
      await a.getByLabel("添加照片").setInputFiles(Array.from({ length: 6 }, (_, index) => ({
        name: `galaxy-${group}-${index}.png`, mimeType: "image/png", buffer: Buffer.from(png, "base64"),
      })));
      await expect(a.getByRole("dialog").getByRole("img", { name: /^galaxy-/ })).toHaveCount(6);
      await a.getByRole("button", { name: "收藏到我们的小世界" }).click();
      await expect(a.getByRole("dialog")).toHaveCount(0);
    }
    await b.goto(`${origin}/app/settings`);
    const galaxyPreference = b.getByRole("checkbox", { name: /回忆银河/ });
    await expect(galaxyPreference).toBeChecked();
    await galaxyPreference.uncheck();
    await b.goto(`${origin}/app/memories/galaxy`);
    await expect(b.getByRole("button", { name: "前往设置" })).toBeVisible();
    await b.getByRole("button", { name: "前往设置" }).click();
    await b.getByRole("checkbox", { name: /回忆银河/ }).check();
    await b.getByRole("checkbox", { name: /减少动态效果/ }).check();
    let galaxyDownloads = 0;
    await b.route("**/api/space", async (route) => {
      if (route.request().postDataJSON()?.action === "fileGet") galaxyDownloads++;
      await route.continue();
    });
    await b.goto(`${origin}/app/memories/galaxy`);
    const galaxy = b.getByRole("region", { name: "回忆银河" });
    await expect(galaxy.getByRole("listitem")).toHaveCount(20);
    expect(galaxyDownloads).toBe(0);
    await galaxy.getByRole("button", { name: "星图", exact: true }).click();
    await expect(galaxy.getByRole("button", { name: /^打开 / })).toHaveCount(20);
    await galaxy.getByRole("button", { name: "放大", exact: true }).click();
    const star = galaxy.getByRole("button", { name: /^打开 待同步的共同日记 .*warm-offline\.png$/ });
    await star.focus();
    await star.press("Enter");
    const selected = galaxy.getByRole("region", { name: "选中的回忆照片" });
    const starPhoto = selected.getByRole("img", { name: "warm-offline.png" });
    await expect(starPhoto).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => starPhoto.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await selected.getByRole("button", { name: "打开原日记" }).click();
    await expect(b.getByRole("dialog").getByRole("heading", { name: "待同步的共同日记" })).toBeVisible();
    await b.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await expect(selected).toBeVisible();
    await expect(galaxy.getByRole("button", { name: "缩小", exact: true })).toBeEnabled();
    await b.getByRole("textbox", { name: "搜索回忆" }).fill("待同步的私人日记");
    await expect(selected).toHaveCount(0);
    await expect(galaxy.getByRole("button", { name: "随机流星" })).toBeDisabled();
    await b.getByRole("textbox", { name: "搜索回忆" }).fill("待同步的共同日记");
    await b.evaluate(() => {
      const active = new Set<string>();
      const counts = { opened: 0, closed: 0 };
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = create(blob);
        if (blob instanceof Blob && blob.type.startsWith("image/")) {
          active.add(url);
          counts.opened++;
        }
        return url;
      };
      URL.revokeObjectURL = (url) => {
        if (active.delete(url)) counts.closed++;
        revoke(url);
      };
      Object.defineProperty(window, "testGalaxyUrls", { value: counts });
    });
    for (let visit = 0; visit < 20; visit += 1) {
      await star.focus();
      await star.press("Enter");
      await expect(starPhoto).toHaveAttribute("src", /^blob:/);
      await b.getByRole("button", { name: "时间轴", exact: true }).click();
      await b.getByRole("button", { name: "回忆银河", exact: true }).click();
      await galaxy.getByRole("button", { name: "关闭照片" }).click();
    }
    const galaxyUrls = await b.evaluate(() => Object.getOwnPropertyDescriptor(window, "testGalaxyUrls")?.value);
    expect(galaxyUrls.opened).toBeGreaterThanOrEqual(20);
    expect(galaxyUrls.closed).toBe(galaxyUrls.opened);
    await b.unroute("**/api/space");

    await b.goto(`${origin}/app/memories/book`);
    const book = b.getByRole("region", { name: "回忆纪念册" });
    await expect(book.getByText("待同步的私人日记", { exact: false })).toHaveCount(0);
    await book.getByLabel("封面标题").fill("合成纪念册封面");
    await book.getByRole("checkbox", { name: /银河夹具 1/ }).check();
    await book.getByRole("checkbox", { name: /待同步的共同日记/ }).check();
    await book.getByRole("button", { name: "上移 待同步的共同日记" }).click();
    await book.getByRole("button", { name: "预览纪念册" }).click();
    await expect(book.getByRole("heading", { name: "合成纪念册封面" })).toBeVisible();
    await expect(book.getByRole("heading", { level: 3 })).toHaveText(["待同步的共同日记", "银河夹具 1"]);
    await expect(book.getByRole("img", { name: "warm-offline.png" })).toBeVisible();
    await expect(book.getByRole("button", { name: /打印纪念册/ })).toBeEnabled();
    await b.emulateMedia({ media: "print" });
    await expect(book.getByRole("button", { name: /返回编辑纪念册/ })).toBeHidden();
    const bookPdf = await b.pdf({ format: "A4", printBackground: true });
    expect(bookPdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bookPdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length).toBe(3);
    await b.emulateMedia({ media: "screen" });
    await book.getByRole("button", { name: /返回编辑纪念册/ }).click();
    await expect(book.getByRole("textbox", { name: "封面标题" })).toHaveValue("合成纪念册封面");

    await a.goto(`${origin}/app/memories/map`);
    await a.getByRole("button", { name: "留下新足迹" }).click();
    await a.getByLabel("这一页的小标题").fill("合成旅行地点");
    await a.getByText("可选：主动填写地图坐标", { exact: false }).click();
    await a.getByLabel("经度", { exact: true }).fill("117.2");
    await a.getByLabel("纬度", { exact: true }).fill("39.1");
    await a.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(a.getByRole("dialog")).toHaveCount(0);
    await b.goto(`${origin}/app/memories/map`);
    await expect(b.getByText("合成旅行地点", { exact: true }).first()).toBeVisible();
    await expect(b.getByRole("region", { name: "外部地图" })).toHaveCount(0);
    await b.goto(`${origin}/app/memories/ai`);
    await expect(b.getByRole("button", { name: "前往设置" })).toBeVisible();
    await b.getByRole("button", { name: "前往设置" }).click();
    await b.getByRole("checkbox", { name: /外部地图试用/ }).check();
    await b.getByRole("checkbox", { name: /AI 回忆助手试用/ }).check();
    const mapRequests: { url: string; referer?: string }[] = [];
    await b.context().route("https://uri.amap.com/**", async (route) => {
      mapRequests.push({ url: route.request().url(), referer: route.request().headers().referer });
      await route.abort("failed");
    });
    await b.goto(`${origin}/app/memories/map`);
    const externalMap = b.getByRole("region", { name: "外部地图" });
    await externalMap.getByRole("button", { name: "查看外部地图选项" }).click();
    await externalMap.getByRole("combobox").selectOption({ label: "合成旅行地点" });
    await expect(externalMap.getByLabel("将发送的经纬度")).toHaveText("117.2,39.1");
    await externalMap.getByRole("button", { name: "取消打开地图" }).click();
    await expect(externalMap.getByRole("link")).toHaveCount(0);
    expect(mapRequests).toEqual([]);
    await externalMap.getByRole("combobox").selectOption({ label: "合成旅行地点" });
    const popupOpening = b.context().waitForEvent("page");
    await externalMap.getByRole("link", { name: /确认坐标并打开/ }).click();
    const external = await popupOpening;
    await expect.poll(() => mapRequests.length).toBe(1);
    expect(Object.fromEntries(new URL(mapRequests[0].url).searchParams)).toEqual({ position: "117.2,39.1" });
    expect(mapRequests[0].referer).toBeUndefined();
    await external.close();
    await expect(externalMap.getByRole("combobox")).toBeVisible();
    await b.context().unroute("https://uri.amap.com/**");

    let aiRequests = 0;
    await b.route("**/api/space", async (route) => {
      if (String(route.request().postDataJSON()?.action).toLowerCase().includes("ai")) aiRequests++;
      await route.continue();
    });
    await b.goto(`${origin}/app/memories/ai`);
    await expect(b.getByText("待同步的私人日记", { exact: true })).toHaveCount(0);
    await b.getByRole("checkbox", { name: /待同步的共同日记/ }).check();
    await b.getByRole("button", { name: "在本机预览" }).click();
    await expect(b.getByRole("heading", { name: "所选共同回忆" })).toBeVisible();
    await expect(b.getByRole("button", { name: "确认并生成" })).toHaveCount(0);
    await b.getByRole("button", { name: "关闭预览" }).click();
    expect(aiRequests).toBe(0);
    await b.unroute("**/api/space");

    await a.goto(`${origin}/app/play/question`);
    await a.getByRole("textbox", { name: "我的答案" }).fill("甲的合成答案");
    await a.getByRole("button", { name: "留下我的答案" }).click();
    await expect(a.getByText("答案已留下，等彼此都准备好")).toBeVisible();
    await b.goto(`${origin}/app/play/question`);
    await expect(b.getByText("对方已经准备好，写下你的答案后一起揭晓。")).toBeVisible();
    await expect(b.getByText("甲的合成答案", { exact: false })).toHaveCount(0);
    await b.getByRole("textbox", { name: "我的答案" }).fill("乙的合成答案");
    await b.getByRole("button", { name: "留下我的答案" }).click();
    await expect(b.getByText("甲的合成答案", { exact: false })).toBeVisible();
    await a.reload();
    await expect(a.getByText("乙的合成答案", { exact: false })).toBeVisible();
    await b.goto(`${origin}/app/memories`);
    await openEditor(b, "待同步的共同日记");
    await b.getByLabel("慢慢写，不用着急").fill("本机保留的冲突正文");
    await b.context().setOffline(true);
    await b.getByLabel("添加照片").setInputFiles({
      name: "conflict-copy.png", mimeType: "image/png", buffer: Buffer.from(png, "base64"),
    });
    await expect(b.getByRole("dialog").getByRole("listitem").filter({ hasText: "conflict-copy.png" })).toBeVisible();
    await b.getByRole("button", { name: "先存本机，稍后同步" }).click();
    await expect(b.getByRole("dialog")).toHaveCount(0);
    await a.goto(`${origin}/app/memories`);
    await openEditor(a, "待同步的共同日记");
    await a.getByLabel("慢慢写，不用着急").fill("先到达服务端的正文");
    await a.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(a.getByRole("dialog")).toHaveCount(0);
    await a.getByRole("heading", { name: "待同步的共同日记", exact: true }).click();
    await expect(a.getByRole("dialog").locator(".detail-body")).toHaveText("先到达服务端的正文");
    await b.context().setOffline(false);
    await b.goto(`${origin}/app/settings`);
    await b.getByRole("button", { name: /连接与同步/ }).click();
    const conflicting = b.getByRole("region", { name: "待同步队列" });
    await conflicting.getByRole("button", { name: "同步待发送日记" }).click();
    await conflicting.getByText("待同步的共同日记", { exact: true }).click();
    await expect(conflicting.getByText("服务端已有更新，可查看并复制本机版本")).toBeVisible();
    await expect(conflicting.getByText("本机保留的冲突正文")).toBeVisible();
    const originalDraft = conflicting.locator("details").filter({ has: b.getByText("本机保留的冲突正文", { exact: true }) }).first();
    await originalDraft.getByText("查看离线照片", { exact: true }).click();
    await expect(originalDraft.getByRole("img", { name: "conflict-copy.png" })).toBeVisible();
    await originalDraft.getByRole("button", { name: "另存为新日记" }).click();
    await b.getByLabel("新日记标题").fill("冲突后另存的日记");
    await b.getByLabel("新日记正文").fill("已核对的本机正文");
    await b.getByLabel("保留照片 warm-offline.png").uncheck();
    await b.getByRole("button", { name: "保存新日记到待同步队列" }).click();
    await expect(conflicting.getByRole("heading")).toHaveText("待同步队列（2）");
    b.once("dialog", (dialog) => dialog.accept());
    await originalDraft.getByRole("button", { name: "移除此项" }).click();
    await expect(conflicting.getByRole("heading")).toHaveText("待同步队列（1）");
    await conflicting.getByRole("button", { name: "同步待发送日记" }).click();
    await expect(conflicting.getByRole("heading")).toHaveText("待同步队列（0）");
    await b.goto(`${origin}/app/memories`);
    await b.getByRole("heading", { name: "冲突后另存的日记", exact: true }).click();
    await expect(b.getByRole("dialog").locator(".detail-body")).toHaveText("已核对的本机正文");
    await expect(b.getByRole("dialog").getByRole("img", { name: "conflict-copy.png" })).toBeVisible();
    await expect(b.getByRole("dialog").getByRole("img", { name: "warm-offline.png" })).toHaveCount(0);

    await exerciseWebWorkload({ a, b, origin, database: join(dir, "e2e.sqlite"), password: firstPhrase, png, info });
    await b.goto(`${origin}/app/settings`);
    await b.getByRole("button", { name: "锁上我的小世界" }).click();
    await b.getByRole("checkbox", { name: "在此浏览器记住解锁 24 小时" }).uncheck();
    await b.getByLabel("本机解锁口令", { exact: false }).fill(secondPhrase);
    await b.getByRole("button", { name: "打开小世界" }).click();
    await expect(b.getByRole("button", { name: "锁上我的小世界" })).toBeVisible();
    await b.reload();
    await expect(b.getByRole("button", { name: "打开小世界" })).toBeVisible();
    await expect(b.getByRole("checkbox", { name: "在此浏览器记住解锁 24 小时" })).not.toBeChecked();
    await b.getByLabel("本机解锁口令", { exact: false }).fill(secondPhrase);
    await b.getByRole("button", { name: "打开小世界" }).click();
    await b.getByRole("button", { name: "收藏册", exact: true }).first().click();
    await b.getByRole("textbox", { name: "搜索回忆" }).fill("第一位更新的标题");
    await expect(b.getByText("第一位更新的标题", { exact: true })).toBeVisible();
    await b.getByRole("heading", { name: "第一位更新的标题", exact: true }).click();
    const secondPhoto = b.waitForEvent("filechooser");
    await b.getByRole("dialog").getByRole("button", { name: "接上我的半张" }).click();
    await (await secondPhoto).setFiles({ name: "reply.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await expect(b.getByRole("dialog").getByRole("img", { name: "reply.png" })).toBeVisible();
    await expect(b.getByRole("button", { name: "接上我的半张" })).toHaveCount(0);
    await a.goto(b.url());
    await expect(a.getByRole("dialog").getByRole("img", { name: "reply.png" })).toBeVisible();
    await expect(a.getByRole("dialog").getByRole("img", { name: "fixture.png" })).toBeVisible();
    const peer = await b.context().newPage();
    await peer.goto(`${origin}/app/settings`);
    await peer.getByRole("button", { name: "退出网站账号" }).click();
    await expect(b.getByRole("heading", { name: "登录双人空间" })).toBeVisible();
    await expect(b.getByText("第一位更新的标题", { exact: true })).toHaveCount(0);
    await signIn(peer, origin, "first", accounts.first);
    await expect(b.getByRole("button", { name: "登记设备，仅加入共同空间" })).toBeVisible();
    await expect(b.getByRole("button", { name: "打开小世界" })).toHaveCount(0);
    await expect(b.getByText("第一位更新的标题", { exact: true })).toHaveCount(0);
    await expect(b.getByRole("heading", { name: "登录双人空间" })).toHaveCount(0);
    const restricted = await page({ width: 390, height: 844 });
    await restricted.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get: () => { throw new DOMException("Storage disabled by test", "SecurityError"); },
      });
    });
    await signIn(restricted, origin, "second", accounts.second);
    await expect(restricted.getByRole("heading", { name: "浏览器本机存储不可用" })).toBeVisible();
    await restricted.getByRole("button", { name: "退出网站账号" }).click();
    await expect(restricted.getByRole("heading", { name: "登录双人空间" })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    try {
      await Promise.all(contexts.map((context) => context.close()));
      await browser?.close();
    } finally {
      await fixture.close();
    }
  }
});
