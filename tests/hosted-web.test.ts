import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { b64, fingerprint, publicKeys } from "../src/core/crypto";
import { UsService } from "../src/core/service";
import { AppError, type Transport } from "../src/core/types";

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
    await expect(second.create(secondPass, "Some space", "2025-10-10")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await first.create(firstPass, "双端联调空间", "2025-10-10");
    const { token } = await first.call<{ token: string }>("createInvitation");
    await second.join(secondPass, token);
    const devices = await first.devices();
    const recipient = devices.find((device) => device.id === second.secrets!.deviceId)!;
    await first.transfer(recipient, fingerprint(recipient));
    await second.receive(fingerprint(publicKeys(first.secrets!)));
    const photoData = b64(randomBytes(500 * 1024));
    const photo = await first.addPhoto(photoData, "image/jpeg", "测试照片", "shared");
    const shared = await first.save({ kind: "memory", title: "共享记录", date: "2025-10-10", photos: [photo] }, "shared");
    const secret = "This plaintext must not be in the database";
    await first.save({ kind: "memory", title: secret, date: "2025-10-10" }, "private");
    await second.refresh();
    expect(second.entries.find((entry) => entry.id === shared.id)?.data.title).toBe("共享记录");
    expect(second.entries.some((entry) => entry.data.title === secret)).toBe(false);
    expect(await second.readPhoto(photo, "shared")).toBe(photoData);
    await stop();
    expect((await readFile(join(dir, "test.sqlite"))).includes(Buffer.from(secret))).toBe(false);
    await start();
    expect((await post("/api/space", { action: "bootstrap" }, "second", secondCookie)).status).toBe(401);
    firstCookie = await login("first");
    secondCookie = await login("second");
    second.lock();
    await second.unlock(secondPass);
    expect(second.entries.some((entry) => entry.id === shared.id)).toBe(true);
    expect(await second.readPhoto(photo, "shared")).toBe(photoData);
    await post("/api/logout", {}, "second", secondCookie);
    expect((await post("/api/space", { action: "bootstrap" }, "second", secondCookie)).status).toBe(401);
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
