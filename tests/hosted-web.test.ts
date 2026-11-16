import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { b64, fingerprint, publicKeys } from "../src/core/crypto";
import { today } from "../src/core/date";
import { UsService } from "../src/core/service";
import { AppError, type Transport } from "../src/core/types";
import { App } from "../web/App";

it("网页双账号可邀请、交换密钥、同步照片，重启后仍隔离私人记录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "us-web-test-"));
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  const accounts = { first: randomBytes(20).toString("hex"), second: randomBytes(20).toString("hex") };
  let server: ChildProcess | undefined;
  async function stop() {
    if (server?.exitCode === null && server.signalCode === null) {
      const stopped = once(server, "exit");
      server.kill();
      await stopped;
    }
  }
  async function start() {
    server = spawn(process.execPath, [join(dir, "server.mjs")], {
      cwd: dir,
      env: { ...process.env, US_WEB_ACCOUNTS: JSON.stringify(accounts), US_WEB_PORT: String(port),
        US_WEB_ORIGIN: origin, US_WEB_DB: join(dir, "test.sqlite") },
    });
    await Promise.race([
      once(server.stdout!, "data"),
      once(server, "exit").then(([code]) => { throw new Error(`Test web server exited with ${code}`); }),
    ]);
  }
  async function post(path: string, data: object, name = "", cookie = "", site = origin) {
    return fetch(origin + path, { method: "POST", headers: {
      Origin: site, "Content-Type": "application/json", Cookie: cookie, "X-Us-Account": name,
    }, body: JSON.stringify(data) });
  }
  async function login(name: keyof typeof accounts) {
    const response = await post("/api/login", { name, password: accounts[name] });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly; SameSite=Strict");
    return cookie.split(";")[0];
  }
  function client(name: keyof typeof accounts, cookie: () => string) {
    const values = new Map<string, string>();
    const transport: Transport = {
      async call<T>(action: string, data = {}) {
        const reply = await (await post("/api/space", { action, data }, name, cookie())).json();
        if (!reply.success) throw new AppError(reply.error.code, reply.error.message);
        return reply.data as T;
      },
    };
    return new UsService(transport, {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => { values.set(key, value); },
      remove: (key) => { values.delete(key); },
    }, async (size) => randomBytes(size));
  }
  try {
    await mkdir(join(dir, "dist"));
    await writeFile(join(dir, "dist", "index.html"), "<html><head></head><body></body></html>");
    await build({ entryPoints: [resolve("src/server/web-entry.ts")], outfile: join(dir, "server.mjs"),
      bundle: true, platform: "node", format: "esm" });
    await start();
    expect(await (await fetch(origin)).text()).toContain("us-web-hosted");
    expect((await post("/api/login", { name: "stranger", password: accounts.first })).status).toBe(401);
    expect((await post("/api/space", { action: "bootstrap" })).status).toBe(401);
    let firstCookie = await login("first");
    let secondCookie = await login("second");
    expect((await post("/api/space", { action: "bootstrap" }, "first", secondCookie)).status).toBe(401);
    expect((await post("/api/space", { action: "bootstrap" }, "first", firstCookie, "https://example.test")).status).toBe(403);
    const first = client("first", () => firstCookie);
    const second = client("second", () => secondCookie);
    const firstPass = "first local unlock phrase";
    const secondPass = "second local unlock phrase";
    await expect(second.setUpDevice(secondPass)).rejects.toMatchObject({ code: "MEMBER_REQUIRED" });
    const forbidden = await post("/api/space", { action: "createSpace" }, "second", secondCookie);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    await first.create(firstPass, "双端联调空间", "2025-10-10");
    const { token } = await first.call<{ token: string }>("createInvitation");
    await expect(second.join(secondPass, "invalid")).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
    expect(second.secrets).toBeNull();
    expect(second.space).toBeNull();
    await second.join(secondPass, token);
    expect(second.space?.id).toBe(first.space?.id);
    expect(second.space?.members).toEqual([first.userId, second.userId]);
    expect(second.ready).toBe(false);
    const joinedDevice = second.secrets!.deviceId;
    await expect(second.join(secondPass, token)).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
    expect(second.secrets?.deviceId).toBe(joinedDevice);
    const devices = await first.devices();
    const recipient = devices.find((device) => device.id === second.secrets!.deviceId)!;
    await first.transfer(recipient, fingerprint(recipient));
    await second.receive(fingerprint(publicKeys(first.secrets!)));
    expect(second.ready).toBe(true);
    const rememberedAccess = second.getUnlockKey()!;
    await second.persistSecrets();
    expect(second.vault?.salt).toBe(rememberedAccess.salt);
    const day = today();
    await first.save({ kind: "mood", title: "有些累", mood: "有些累", date: day });
    await second.save({ kind: "mood", title: "很开心", mood: "很开心", date: day });
    await Promise.all([first.refresh(), second.refresh()]);
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    try {
      const render = (service: UsService, owner: boolean) => renderToStaticMarkup(
        createElement(App, { hosted: { account: owner ? "first" : "second", service, owner, signOut: async () => {} } }),
      );
      const moods = (html: string) =>
        html.match(/class="mood-row"[\s\S]*?(?=<span class="mood-(?:sun|cloud)">)/g);
      const firstView = render(first, true);
      const secondView = render(second, false);
      expect(firstView).toContain('class="avatar small a">臻');
      expect(secondView).toContain('class="avatar small b">悦');
      const firstMood = expect.stringMatching(/avatar a">臻.*有些累/);
      const secondMood = expect.stringMatching(/avatar b">悦.*很开心/);
      expect(moods(firstView)).toEqual([firstMood, secondMood]);
      expect(moods(secondView)).toEqual([secondMood, firstMood]);
    } finally {
      vi.unstubAllGlobals();
    }
    await expect(second.setUpDevice(secondPass)).rejects.toMatchObject({ code: "LOCAL_KEYS_EXIST" });
    const newBrowser = client("second", () => secondCookie);
    await newBrowser.bootstrap();
    expect(newBrowser.space?.id).toBe(first.space?.id);
    expect(newBrowser.vault).toBeNull();
    await newBrowser.setUpDevice(secondPass);
    expect(newBrowser.secrets?.deviceId).not.toBe(joinedDevice);
    expect(newBrowser.ready).toBe(false);
    newBrowser.lock();
    await newBrowser.unlock(secondPass);
    const newDevice = (await first.devices()).find((device) => device.id === newBrowser.secrets!.deviceId)!;
    await first.transfer(newDevice, fingerprint(newDevice));
    await newBrowser.receive(fingerprint(publicKeys(first.secrets!)));
    expect(newBrowser.ready).toBe(true);
    const photoData = b64(randomBytes(500 * 1024));
    const photo = await first.addPhoto(photoData, "image/jpeg", "测试照片", "shared");
    const shared = await first.save({ kind: "memory", title: "共享记录", date: "2025-10-10", photos: [photo] }, "shared");
    const secret = "This plaintext must not be in the database";
    await first.save({ kind: "memory", title: secret, date: "2025-10-10" }, "private");
    await second.refresh();
    expect(second.entries.find((entry) => entry.id === shared.id)?.data.title).toBe("共享记录");
    expect(second.entries.some((entry) => entry.data.title === secret)).toBe(false);
    expect(await second.readPhoto(photo, "shared")).toBe(photoData);
    await newBrowser.refresh();
    expect(newBrowser.entries.some((entry) => entry.id === shared.id)).toBe(true);
    await stop();
    expect((await readFile(join(dir, "test.sqlite"))).includes(Buffer.from(secret))).toBe(false);
    await start();
    expect((await post("/api/space", { action: "bootstrap" }, "second", secondCookie)).status).toBe(401);
    firstCookie = await login("first");
    secondCookie = await login("second");
    second.lock();
    expect(second.getUnlockKey()).toBeNull();
    const reloaded = new UsService(second.transport, second.storage, second.rng);
    try {
      await reloaded.unlockWithKey(rememberedAccess);
    } finally {
      rememberedAccess.key.fill(0);
    }
    expect(reloaded.entries.some((entry) => entry.id === shared.id)).toBe(true);
    expect(await reloaded.readPhoto(photo, "shared")).toBe(photoData);
    await expect(reloaded.createBackup("wrong unlock phrase")).rejects.toMatchObject({ code: "WRONG_PASSWORD" });
    await post("/api/logout", {}, "second", secondCookie);
    expect((await post("/api/space", { action: "bootstrap" }, "second", secondCookie)).status).toBe(401);
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
