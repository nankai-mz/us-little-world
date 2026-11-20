import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { startReleaseFixture } from "./release-fixture";

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
