import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { signIn, startReleaseFixture } from "./release-fixture";
import { addDays, spaceDay } from "../src/core/date";

test("发布包验收命令校验证书、会话策略和当前静态资源", async () => {
  test.skip(!process.env.US_WEB_TEST_PACKAGE, "此项验证从部署 ZIP 运行的验收命令");
  const fixture = await startReleaseFixture();
  try {
    const certificate = join(fixture.dir, "test-trust.pem");
    await writeFile(certificate, fixture.certificate);
    const execute = promisify(execFile);
    const check = (trust?: string) => execute(process.execPath, ["scripts/check-web-origin.mjs", fixture.origin], {
      cwd: fixture.dir, env: { ...process.env, NODE_EXTRA_CA_CERTS: trust, NODE_TLS_REJECT_UNAUTHORIZED: undefined },
    });
    await expect(check()).rejects.toMatchObject({ stderr: expect.stringContaining("/healthz 无法通过 HTTPS 读取") });
    const { stdout } = await check(certificate);
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({ origin: fixture.origin, release: expect.any(String), assetCount: expect.any(Number) });
    expect(report.assetCount).toBeGreaterThan(2);
    expect(report.checked).toContain("asset-hashes");
    const path = join(fixture.dir, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    const css = Object.keys(manifest.files).find((key) => key.endsWith(".css"))!;
    manifest.files[css] = "0".repeat(64);
    await writeFile(path, JSON.stringify(manifest));
    await expect(check(certificate)).rejects.toMatchObject({ stderr: expect.stringContaining("内容与发布清单不一致") });
  } finally {
    await fixture.close();
  }
});

test("页面跨上海零点自动更新，并在从挂起恢复时校准日期", async ({ browser }) => {
  const fixture = await startReleaseFixture();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, timezoneId: "Pacific/Honolulu" });
  try {
    const page = await context.newPage();
    const date = spaceDay();
    const midnight = Date.parse(`${addDays(date, 1)}T00:00:00+08:00`);
    await page.clock.install();
    await signIn(page, fixture.origin, "first", fixture.accounts.first);
    await page.getByRole("button", { name: "创建双人空间", exact: true }).click();
    await page.getByLabel("恋爱开始日期").fill(date);
    await page.getByLabel("本机解锁口令", { exact: false }).fill("calendar fixture unlock phrase");
    await page.getByRole("button", { name: "创建我们的空间" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    const together = page.locator(".together-number");
    await expect(together).toHaveText(/^1天/);

    await page.clock.setSystemTime(new Date(midnight - 5000));
    await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
    await page.clock.runFor(6000);
    await expect(together).toHaveText(/^2天/);

    // Cross the same boundary again without running the scheduled timeout or crossing the unlock expiry.
    await page.clock.setSystemTime(new Date(midnight - 60_000));
    await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
    await expect(together).toHaveText(/^1天/);
    await page.clock.setSystemTime(new Date(midnight + 1000));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(together).toHaveText(/^2天/);
  } finally {
    await context.close();
    await fixture.close();
  }
});
