import { firefox, webkit, test, expect, type Browser, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { signIn, startReleaseFixture } from "./release-fixture";

type VaultBackup = { key: string; file: Buffer };

const closeModal = (page: Page) => page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();

function withTestExif(jpeg: Buffer) {
  // EXIF orientation 6 plus a synthetic GPS coordinate, both discarded after browser encoding.
  const tag = Buffer.alloc(140);
  tag.write("II", 0);
  tag.writeUInt16LE(42, 2);
  tag.writeUInt32LE(8, 4);
  tag.writeUInt16LE(2, 8);
  const field = (offset: number, id: number, type: number, length: number, value: number) => {
    tag.writeUInt16LE(id, offset);
    tag.writeUInt16LE(type, offset + 2);
    tag.writeUInt32LE(length, offset + 4);
    tag.writeUInt32LE(value, offset + 8);
  };
  field(10, 0x0112, 3, 1, 6);
  field(22, 0x8825, 4, 1, 38);
  tag.writeUInt16LE(4, 38);
  field(40, 1, 2, 2, "N".charCodeAt(0));
  field(52, 2, 5, 3, 92);
  field(64, 3, 2, 2, "E".charCodeAt(0));
  field(76, 4, 5, 3, 116);
  for (const [index, numerator] of [30, 0, 0, 120, 0, 0].entries()) {
    tag.writeUInt32LE(numerator, 92 + index * 8);
    tag.writeUInt32LE(1, 96 + index * 8);
  }
  const exif = Buffer.from("Exif\0\0", "ascii");
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(exif.length + tag.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, exif, tag, jpeg.subarray(2)]);
}

async function saveDiary(page: Page, origin: string, title: string, filename: string, visibility: "shared" | "private", height: number) {
  await page.goto(`${origin}/app/memories/new`);
  await page.getByLabel("这一页的小标题").fill(title);
  await page.getByLabel("慢慢写，不用着急").fill(`${title}的合成正文`);
  await page.getByLabel("谁可以看见").selectOption(visibility);
  const orient = filename.endsWith(".jpg");
  const fixture = await page.evaluate(({ height, orient }) => {
    const canvas = document.createElement("canvas");
    canvas.width = orient ? height : 96;
    canvas.height = orient ? 96 : height;
    const drawing = canvas.getContext("2d")!;
    drawing.fillStyle = "#935a71";
    drawing.fillRect(0, 0, canvas.width / 2, canvas.height);
    return canvas.toDataURL(orient ? "image/jpeg" : "image/png").split(",")[1];
  }, { height, orient });
  const pixels = Buffer.from(fixture, "base64");
  const buffer = orient ? withTestExif(pixels) : pixels;
  await page.getByLabel("添加照片").setInputFiles({ name: filename, mimeType: "", buffer });
  await expect(page.getByRole("dialog").getByRole("img", { name: filename })).toBeVisible();
  await page.getByRole("button", { name: "收藏到我们的小世界" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function checkDiary(page: Page, title: string, filename: string, height: number) {
  await page.getByRole("heading", { name: title, exact: true }).click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByText(`${title}的合成正文`, { exact: true })).toBeVisible();
  const photo = detail.getByRole("img", { name: filename, exact: true });
  await expect.poll(() => photo.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([96, height]);
  if (filename.endsWith(".jpg")) {
    const source = await photo.getAttribute("src");
    expect(source).toMatch(/^data:image\/jpeg;base64,/);
    expect(Buffer.from(source!.split(",")[1], "base64").includes(Buffer.from("Exif\0\0"))).toBe(false);
  } else {
    expect(await photo.evaluate((image: HTMLImageElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const drawing = canvas.getContext("2d")!;
      drawing.drawImage(image, 0, 0);
      return drawing.getImageData(95, 0, 1, 1).data[3];
    })).toBe(0);
  }
  await closeModal(page);
}

async function downloadVault(page: Page, origin: string, phrase: string): Promise<VaultBackup> {
  await page.goto(`${origin}/app/settings`);
  await page.getByRole("button", { name: /备份与恢复密钥/ }).click();
  await page.getByLabel("再次输入本机口令").fill(phrase);
  await page.getByRole("button", { name: "验证并查看恢复密钥" }).click();
  const code = page.locator(".recovery-code");
  await expect(code).toHaveText(/^[a-f0-9]{64}$/);
  const key = await code.innerText();
  const downloadReady = page.waitForEvent("download");
  await page.getByRole("button", { name: "保存加密备份文件" }).click();
  const download = await downloadReady;
  const file = await readFile(await download.path());
  const backup = JSON.parse(file.toString("utf8"));
  expect(backup).toMatchObject({ format: "UsBackup", version: 2 });
  expect(Object.keys(backup.vault).sort()).toEqual(["recoveryEnvelope", "version"]);
  await closeModal(page);
  return { key, file };
}

test("Firefox 与 WebKit 双人图文、冷启动离线与互换浏览器恢复", async ({}, info) => {
  test.setTimeout(240000);
  const fixture = await startReleaseFixture();
  const { accounts, origin } = fixture;
  const browsers: Browser[] = [];
  const errors: string[] = [];
  // WebKit reports fetches that are cancelled by a page navigation as page errors
  // ("Fetch API cannot load ... due to access control checks."). The app rejects and
  // handles those promises, so they are recorded as engine noise instead of failures.
  const engineNetworkNoise: string[] = [];
  const firstPhrase = "first compatibility unlock phrase";
  const secondPhrase = "second compatibility unlock phrase";
  const newPage = async (browser: Browser, width: number) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 820 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => {
      if (/due to access control checks|Load failed|Network request failed/.test(error.message))
        engineNetworkNoise.push(error.message);
      else errors.push(error.message);
    });
    return page;
  };
  try {
    const ff = await firefox.launch();
    browsers.push(ff);
    const wk = await webkit.launch();
    browsers.push(wk);
    const bIsWebKit = wk.browserType().name() === "webkit";
    const a = await newPage(ff, 1200);
    const b = await newPage(wk, 360);
    await signIn(a, origin, "first", accounts.first);
    await a.getByRole("button", { name: "创建双人空间", exact: true }).click();
    await a.getByLabel("给我们的空间起个名字").fill("跨浏览器合成空间");
    await a.getByLabel("本机解锁口令", { exact: false }).fill(firstPhrase);
    await a.getByRole("button", { name: "创建我们的空间" }).click();
    await expect(a.locator(".recovery-code")).not.toBeEmpty();
    await closeModal(a);
    await a.goto(`${origin}/app/settings/devices`);
    await a.getByRole("button", { name: "生成一次性邀请码" }).click();
    await expect(a.locator(".invitation")).not.toBeEmpty();
    const token = (await a.locator(".invitation").innerText()).trim();
    const firstCode = (await a.locator(".safety-code").innerText()).trim();

    await signIn(b, origin, "second", accounts.second);
    await b.getByRole("button", { name: "输入邀请码加入" }).click();
    await b.getByLabel("一次性邀请码").fill(token);
    await b.getByLabel("本机解锁口令", { exact: false }).fill(secondPhrase);
    await b.getByRole("button", { name: "加入双人空间", exact: true }).click();
    const secondCode = await b.getByLabel("我的设备安全码").inputValue();
    await a.getByRole("button", { name: "刷新设备列表" }).click();
    await a.getByLabel("对方的设备安全码").fill(secondCode);
    await a.getByRole("button", { name: "发送空间密钥" }).click();
    await a.getByLabel("重新输入网站密码").fill(accounts.first);
    await a.getByRole("button", { name: "验证并继续" }).click();
    await expect(a.getByRole("status")).toHaveText("空间密钥已发送");
    await b.getByLabel("对方的设备安全码").fill(firstCode);
    await b.getByRole("button", { name: "接收空间密钥" }).click();
    await expect(b.locator(".recovery-code")).not.toBeEmpty();
    await closeModal(b);

    await saveDiary(a, origin, "Firefox 共同日记", "共同横图.jpg", "shared", 54);
    await saveDiary(a, origin, "Firefox 私人日记", "甲的私人图.png", "private", 120);
    await saveDiary(b, origin, "WebKit 共同日记", "共同竖图.png", "shared", 120);
    await saveDiary(b, origin, "WebKit 私人日记", "乙的私人图.jpg", "private", 54);
    await a.goto(`${origin}/app/memories`);
    await checkDiary(a, "WebKit 共同日记", "共同竖图.png", 120);
    await expect(a.getByRole("heading", { name: "WebKit 私人日记" })).toHaveCount(0);
    await b.goto(`${origin}/app/settings`);
    await b.getByRole("checkbox", { name: /本机密文缓存/ }).check();
    await b.goto(`${origin}/app/memories`);
    await checkDiary(b, "Firefox 共同日记", "共同横图.jpg", 54);
    await expect(b.getByRole("heading", { name: "Firefox 私人日记" })).toHaveCount(0);
    // 缓存载荷必须是文本：WebKit 的 IndexedDB 无法保存 Blob，写 Blob 会让断网重开无缓存。
    const cachedPayloadTypes = await b.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("us-web-cipher");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const rows = await new Promise<{ payload: unknown }[]>((resolve, reject) => {
          const request = db.transaction("snapshots").objectStore("snapshots").getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return { count: rows.length, types: [...new Set(rows.map(({ payload }) => Object.prototype.toString.call(payload)))] };
      } finally { db.close(); }
    });
    expect(cachedPayloadTypes.count).toBeGreaterThan(0);
    expect(cachedPayloadTypes.types).toEqual(["[object String]"]);
    const titledCard = (page: Page) => page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "Firefox 共同日记", exact: true }),
    });
    const favorite = titledCard(b).getByRole("button", { name: "收藏回忆" });
    await favorite.click();
    await expect(favorite).toHaveClass(/\bliked\b/);
    await titledCard(b).getByRole("heading").click();
    await b.getByPlaceholder("想说点什么…").fill("跨浏览器合成留言");
    await b.getByRole("button", { name: "留言", exact: true }).click();
    await expect(b.getByRole("dialog").locator(".comments p").filter({ hasText: "跨浏览器合成留言" })).toHaveText("我跨浏览器合成留言");
    await closeModal(b);
    await a.reload();
    await expect(titledCard(a).getByRole("button", { name: "收藏回忆" })).not.toHaveClass(/\bliked\b/);
    await titledCard(a).getByRole("heading").click();
    await expect(a.getByRole("dialog").locator(".comments p").filter({ hasText: "跨浏览器合成留言" })).toHaveText("对方跨浏览器合成留言");
    await closeModal(a);

    await expect.poll(() => b.evaluate(() => Boolean(navigator.serviceWorker?.controller))).toBe(true);
    // Playwright's engine-level offline emulation is not applied to service worker
    // sessions, so the fixture stops forwarding as well. WebKit reports an internal
    // navigation error when its network emulation is combined with a worker-cached page,
    // so the WebKit profile only loses the real upstream connection.
    fixture.setNetworkAvailable(false);
    if (!bIsWebKit) await b.context().setOffline(true);
    try {
      await b.reload({ waitUntil: "domcontentloaded" });
      await expect(b.getByRole("heading", { name: "离线日记", exact: true })).toBeVisible();
      await b.getByLabel("本机解锁口令").fill(secondPhrase);
      await b.getByRole("button", { name: "解锁离线日记" }).click();
      const cached = b.getByRole("article").filter({ hasText: "Firefox 共同日记" });
      await cached.getByText("查看离线照片", { exact: true }).click();
      await expect.poll(() => cached.getByRole("img", { name: "共同横图.jpg" })
        .evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(96);
      await expect(b.getByText("Firefox 私人日记", { exact: true })).toHaveCount(0);
    } finally {
      fixture.setNetworkAvailable(true);
      if (!bIsWebKit) await b.context().setOffline(false);
    }

    const firstBackup = await downloadVault(a, origin, firstPhrase);
    const secondBackup = await downloadVault(b, origin, secondPhrase);
    const pairTitle = { first: "Firefox 共同日记", second: "WebKit 共同日记" } as const;
    for (const example of [
      { account: "first", browser: wk, backup: firstBackup, other: secondBackup, own: "Firefox 私人日记", otherPrivate: "WebKit 私人日记", photo: "甲的私人图.png", height: 120 },
      { account: "second", browser: ff, backup: secondBackup, other: firstBackup, own: "WebKit 私人日记", otherPrivate: "Firefox 私人日记", photo: "乙的私人图.jpg", height: 54 },
    ] as const) {
      const page = await newPage(example.browser, 390);
      await signIn(page, origin, example.account, accounts[example.account]);
      const vaultStored = () => page.evaluate(() => Object.keys(localStorage).some((key) => key.endsWith(".vault")));
      await page.getByRole("button", { name: "使用备份恢复", exact: true }).click();
      const restore = page.getByRole("dialog");
      const file = restore.getByLabel("加密备份 JSON");
      const phrase = `${example.account} restored compatibility phrase`;

      // 错误恢复密钥必须拒绝，且不得写入密钥库
      await file.setInputFiles({ name: "fixture-backup.json", mimeType: "application/json", buffer: example.backup.file });
      await restore.getByLabel("64 位恢复密钥").fill("0".repeat(64));
      await restore.getByLabel("新的本机解锁口令").fill(phrase);
      await restore.getByRole("button", { name: "验证并恢复备份" }).click();
      await expect(page.getByRole("status")).toHaveText("解密失败，请检查恢复密钥或密文完整性");
      expect(await vaultStored()).toBe(false);

      // 另一位成员的备份即使密钥正确也不得覆盖本机密钥库
      await file.setInputFiles({ name: "fixture-backup.json", mimeType: "application/json", buffer: example.other.file });
      await restore.getByLabel("64 位恢复密钥").fill(example.other.key);
      await restore.getByRole("button", { name: "验证并恢复备份" }).click();
      await expect(page.getByRole("status")).toHaveText("备份不属于当前账号和空间");
      expect(await vaultStored()).toBe(false);

      await file.setInputFiles({ name: "fixture-backup.json", mimeType: "application/json", buffer: example.backup.file });
      await restore.getByLabel("64 位恢复密钥").fill(example.backup.key);
      await restore.getByRole("button", { name: "验证并恢复备份" }).click();
      await expect(restore).toHaveCount(0);
      await page.goto(`${origin}/app/memories`);
      await checkDiary(page, example.own, example.photo, example.height);
      await expect(page.getByRole("heading", { name: example.otherPrivate })).toHaveCount(0);
      await checkDiary(page, "Firefox 共同日记", "共同横图.jpg", 54);

      // 恢复后的新设备写入一条共同图文，对方从另一引擎读回并解密照片
      const restoredTitle = `恢复后的 ${example.account} 共同日记`;
      await saveDiary(page, origin, restoredTitle, "恢复后照片.png", "shared", 48);
      const peer = example.account === "first" ? b : a;
      await peer.goto(`${origin}/app/memories`);
      await checkDiary(peer, restoredTitle, "恢复后照片.png", 48);

      // 记住解锁后完整刷新仍可解密
      await page.reload();
      await expect(page.getByRole("heading", { name: example.own })).toBeVisible();

      // 取消记住解锁后刷新必须重新输入口令，再恢复默认记忆
      await page.goto(`${origin}/app/settings`);
      await page.getByRole("button", { name: "锁上我的小世界" }).click();
      await expect(page.getByRole("button", { name: "打开小世界" })).toBeVisible();
      const rememberUnlock = page.getByRole("checkbox", { name: "在此浏览器记住解锁 24 小时" });
      await rememberUnlock.uncheck();
      await page.getByLabel("本机解锁口令", { exact: false }).fill(phrase);
      await page.getByRole("button", { name: "打开小世界" }).click();
      await expect(page.getByRole("button", { name: "锁上我的小世界" })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("button", { name: "打开小世界" })).toBeVisible();
      await rememberUnlock.check();
      await page.getByLabel("本机解锁口令", { exact: false }).fill(phrase);
      await page.getByRole("button", { name: "打开小世界" }).click();
      await expect(page.getByRole("button", { name: "锁上我的小世界" })).toBeVisible();

      // 主动锁定会清除记住的解锁，刷新后必须重新输入口令
      await page.goto(`${origin}/app/settings`);
      await page.getByRole("button", { name: "锁上我的小世界" }).click();
      await expect(page.getByRole("button", { name: "打开小世界" })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("button", { name: "打开小世界" })).toBeVisible();
      await page.getByLabel("本机解锁口令", { exact: false }).fill(phrase);
      await page.getByRole("button", { name: "打开小世界" }).click();
      await expect(page.getByRole("button", { name: "锁上我的小世界" })).toBeVisible();

      // 跨标签：另一标签同步锁定，并能用自己的口令重新打开
      const sibling = await page.context().newPage();
      await sibling.goto(`${origin}/app/memories`);
      await expect(sibling.getByRole("heading", { name: example.own })).toBeVisible();
      await page.goto(`${origin}/app/settings`);
      await page.getByRole("button", { name: "锁上我的小世界" }).click();
      await expect(sibling.getByRole("button", { name: "打开小世界" })).toBeVisible();
      await expect(sibling.getByRole("heading", { name: example.own })).toHaveCount(0);
      await sibling.getByLabel("本机解锁口令", { exact: false }).fill(phrase);
      await sibling.getByRole("button", { name: "打开小世界" }).click();
      await expect(sibling.getByRole("heading", { name: example.own })).toBeVisible();

      // 原设备撤销恢复出的设备：被撤销设备不得继续读取新数据
      const original = example.account === "first" ? a : b;
      const revokeActiveDevice = async () => {
        await original.goto(`${origin}/app/settings/devices`);
        await original.getByRole("button", { name: "刷新设备列表" }).click();
        const revoke = original.getByRole("button", { name: "撤销", exact: true });
        await expect(revoke).toHaveCount(1);
        await revoke.click();
        await original.getByLabel("重新输入网站密码").fill(accounts[example.account]);
        await original.getByRole("button", { name: "验证并继续" }).click();
        await expect(original.getByRole("status")).toHaveText("该设备的后续云访问已撤销");
      };
      await revokeActiveDevice();
      await page.goto(`${origin}/app/memories`);
      await expect(page.getByText("这台设备的空间访问已被撤销。可使用自己的加密备份重新登记。")).toBeVisible();
      await expect(page.getByRole("heading", { name: example.own })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: pairTitle[example.account === "first" ? "second" : "first"] })).toHaveCount(0);

      // 被撤销设备仍可用本人加密备份重新登记并读回旧内容
      await page.getByRole("button", { name: "使用备份恢复" }).click();
      const again = page.getByRole("dialog");
      await again.getByLabel("加密备份 JSON").setInputFiles({ name: "fixture-backup.json", mimeType: "application/json", buffer: example.backup.file });
      await again.getByLabel("64 位恢复密钥").fill(example.backup.key);
      await again.getByLabel("新的本机解锁口令").fill(`${example.account} re-registered compatibility phrase`);
      await again.getByRole("button", { name: "验证并恢复备份" }).click();
      await expect(again).toHaveCount(0);
      await page.goto(`${origin}/app/memories`);
      await checkDiary(page, example.own, example.photo, example.height);
      await revokeActiveDevice();
    }

    // 仅共同授权设备：由第二位成员发送空间密钥，私人记录不可见且私人写入被禁用
    const restricted = await newPage(wk, 390);
    await signIn(restricted, origin, "second", accounts.second);
    await restricted.getByLabel("本机解锁口令", { exact: false }).fill("shared only compatibility phrase");
    await restricted.getByRole("button", { name: "登记设备，仅加入共同空间" }).click();
    await expect(restricted.getByRole("heading", { name: "已加入双人空间" })).toBeVisible();
    const restrictedCode = await restricted.getByLabel("我的设备安全码").inputValue();
    await b.goto(`${origin}/app/settings/devices`);
    await b.getByRole("button", { name: "刷新设备列表" }).click();
    await b.getByLabel("对方的设备安全码").fill(restrictedCode);
    await b.getByRole("button", { name: "发送空间密钥", disabled: false }).click();
    await b.getByLabel("重新输入网站密码").fill(accounts.second);
    await b.getByRole("button", { name: "验证并继续" }).click();
    await expect(b.getByRole("status")).toHaveText("空间密钥已发送");
    const secondDeviceCode = (await b.locator(".safety-code").innerText()).trim();
    await restricted.getByLabel("对方的设备安全码").fill(secondDeviceCode);
    await restricted.getByRole("button", { name: "接收空间密钥" }).click();
    await expect(restricted.getByRole("status")).toHaveText("已接收空间密钥");
    await restricted.goto(`${origin}/app/memories`);
    await expect(restricted.getByRole("heading", { name: "Firefox 共同日记" })).toBeVisible({ timeout: 20000 });
    await expect(restricted.getByRole("heading", { name: "WebKit 私人日记" })).toHaveCount(0);
    await restricted.goto(`${origin}/app/memories/new`);
    await expect(restricted.getByRole("combobox", { name: "谁可以看见" }).locator('option[value="private"]'))
      .toHaveAttribute("disabled", "");
    await restricted.getByLabel("这一页的小标题").fill("仅共同设备的合成日记");
    await restricted.getByRole("button", { name: "收藏到我们的小世界" }).click();
    await expect(restricted.getByRole("dialog")).toHaveCount(0);
    await a.goto(`${origin}/app/memories`);
    await expect(a.getByRole("heading", { name: "仅共同设备的合成日记" })).toBeVisible();

    expect(errors).toEqual([]);
    const report = info.outputPath("browser-compat.json");
    await mkdir(dirname(report), { recursive: true });
    await writeFile(report, JSON.stringify({ engines: { firefox: ff.version(), webkit: wk.version() }, platform: process.platform,
      profiles: 5, viewportWidths: [360, 390, 1200], privateIsolation: true, swappedRecovery: true,
      webkitColdOfflineRead: true, crossTabLock: true, jpegOrientation: true, exifRemoved: true, transparentPng: true,
      commentSynchronized: true, favoritesPerMember: true, wrongRecoveryKeyRejected: true,
      foreignBackupRejected: true, revokedDeviceLocked: true, revokedDeviceReRegistered: true,
      restoredDeviceWriteBack: true, sharedOnlyDevice: true, rememberedUnlockReload: true,
      rememberedUnlockCancelled: true, cachePayloadText: true,
      engineNetworkNoise: engineNetworkNoise.length }, null, 2));
    await info.attach("browser-compat", { path: report, contentType: "application/json" });
  } finally {
    try { await Promise.all(browsers.map((browser) => browser.close())); }
    finally { await fixture.close(); }
  }
});
