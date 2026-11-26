import { expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { buildWebServer } from "../scripts/web-server-build.mjs";
import { strFromU8, unzipSync } from "fflate";
import { startHttpsFixture } from "./tls-fixture";

export async function signIn(page: Page, origin: string, name: string, password: string) {
  await page.goto(origin);
  await page.getByLabel("网站账号").fill(name);
  await page.getByLabel("网站密码").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

export type VaultBackup = { key: string; file: Buffer };

export async function downloadVault(page: Page, origin: string, phrase: string): Promise<VaultBackup> {
  await page.goto(`${origin}/app/settings`);
  await page.getByRole("button", { name: /备份与恢复密钥/ }).click();
  await page.getByLabel("再次输入本机口令").fill(phrase);
  await page.getByRole("button", { name: "验证并查看恢复密钥" }).click();
  const code = page.locator(".recovery-code");
  await expect(code).toHaveText(/^[a-f0-9]{64}$/);
  const key = await code.innerText();
  const downloadReady = page.waitForEvent("download");
  await page.getByRole("button", { name: "保存加密备份文件" }).click();
  const file = await readFile(await (await downloadReady).path());
  const backup = JSON.parse(file.toString("utf8"));
  expect(backup).toMatchObject({ format: "UsBackup", version: 2 });
  expect(Object.keys(backup.vault).sort()).toEqual(["recoveryEnvelope", "version"]);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  return { key, file };
}

async function stageRelease(directory: string) {
  const archive = process.env.US_WEB_TEST_PACKAGE;
  if (!archive) {
    await cp(resolve("dist"), join(directory, "dist"), { recursive: true });
    await buildWebServer(join(directory, "server.mjs"));
    return;
  }
  const files = unzipSync(await readFile(archive));
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  expect(Object.keys(files).sort()).toEqual(["manifest.json", ...Object.keys(manifest.files)].sort());
  const buildManifest = JSON.parse(strFromU8(files["dist/.vite/manifest.json"])) as Record<string, { file: string; css?: string[] }>;
  const bundledScripts = new Set(Object.values(buildManifest).flatMap(({ file, css }) => [file, ...(css ?? [])])
    .filter((path) => /\.(css|js)$/.test(path)));
  expect(Object.keys(files).filter((path) => /^dist\/assets\/.*\.(css|js)$/.test(path)).sort())
    .toEqual([...bundledScripts].map((path) => `dist/${path}`).sort());
  for (const [name, bytes] of Object.entries(files)) {
    expect(name.split("/").every((piece) => /^[\w.-]+$/.test(piece) && piece !== "." && piece !== "..")).toBe(true);
    if (name !== "manifest.json") expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.files[name]);
    const output = join(directory, name);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, bytes);
  }
}

export async function startReleaseFixture(playground = "") {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as { port: number };
  await new Promise<void>((done) => probe.close(() => done()));
  const accounts = { first: randomBytes(20).toString("hex"), second: randomBytes(20).toString("hex") };
  const root = resolve("artifacts");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "web-e2e-"));
  let server: ReturnType<typeof spawn> | undefined;
  let proxy: Awaited<ReturnType<typeof startHttpsFixture>> | undefined;
  const stop = async () => {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, "exit");
      server.kill();
      await stopped;
    }
    server = undefined;
  };
  const start = async (file = "e2e.sqlite") => {
    if (server || !proxy || !/^[\w-]+\.sqlite$/.test(file)) throw new Error("Invalid fixture database restart");
    server = spawn(process.execPath, [join(dir, "server.mjs")], { cwd: dir, env: {
      ...process.env, US_WEB_ACCOUNTS: JSON.stringify(accounts), US_WEB_PORT: String(port),
      US_WEB_ORIGIN: proxy.origin, US_WEB_DB: join(dir, file), US_WEB_PLAYGROUND: playground,
    } });
    await Promise.race([
      once(server.stdout!, "data"),
      once(server, "exit").then(([code]) => { throw new Error(`Fixture exited with code ${code}`); }),
    ]);
  };
  const close = async () => {
    try {
      await stop();
      await proxy?.close();
    } finally {
      if (dirname(dir) === root) await rm(dir, { recursive: true, force: true });
    }
  };
  try {
    await stageRelease(dir);
    proxy = await startHttpsFixture(dir, port);
    await start();
    return { ...proxy, accounts, dir, start, stop, close };
  } catch (error) {
    await close();
    throw error;
  }
}
