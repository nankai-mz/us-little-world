import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  validatePublicConfig,
  configureProject,
} from "../scripts/configure.mjs";
describe("公开部署配置", () => {
  it("只接受格式正确的公开标识", () => {
    expect(
      validatePublicConfig({
        appid: "wx0123456789abcdef",
        cloudEnv: "cloud-fixture-123",
      }),
    ).toEqual({
      appid: "wx0123456789abcdef",
      cloudEnv: "cloud-fixture-123",
      cloudFunction: "usApi",
    });
    for (const appid of ["touristappid", "wx-not-valid", "wx0123456789abcdeg"])
      expect(() =>
        validatePublicConfig({ appid, cloudEnv: "cloud-fixture" }),
      ).toThrow();
  });
  it("拒绝密钥字段和可注入代码的环境值，异常不打印敏感值", () => {
    const secret = "fixture-secret-that-must-not-be-printed";
    expect(() =>
      validatePublicConfig({
        appid: "wx0123456789abcdef",
        cloudEnv: "cloud-fixture",
        appSecret: secret,
      }),
    ).toThrow(/不接受密钥/);
    try {
      validatePublicConfig({
        appid: "wx0123456789abcdef",
        cloudEnv: `env';${secret}`,
      });
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
  it("命令行拒绝格式错误的 JSON 时不回显文件内容", async () => {
    const parent = resolve("artifacts/config-tests");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "invalid-"));
    const path = join(root, "config.json");
    const fixture = "secret-fixture-must-not-be-printed";
    await writeFile(path, `{"appid":"${fixture}",`);
    let failure: any;
    try {
      execFileSync(
        process.execPath,
        [resolve("scripts/configure.mjs"), "--file", path],
        { encoding: "utf8", stdio: "pipe" },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure?.status).toBe(1);
    expect(failure.stderr).toContain("配置文件不是有效 JSON");
    expect(failure.stderr).not.toContain(fixture);
  });
  it("配置工具保留其他项目设置，不修改真实工作区配置", async () => {
    const parent = resolve("artifacts/config-tests");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "fixture-"));
    await mkdir(join(root, "miniprogram"));
    await writeFile(
      join(root, "project.config.json"),
      JSON.stringify({
        appid: "touristappid",
        setting: { es6: true },
        projectname: "keep-name",
      }),
    );
    await writeFile(
      join(root, "miniprogram/config.ts"),
      "export const config = {};",
    );
    await configureProject(root, {
      appid: "wx0123456789abcdef",
      cloudEnv: "cloud-fixture-123",
    });
    const actual = JSON.parse(
      await readFile(join(root, "project.config.json"), "utf8"),
    );
    expect(actual).toEqual({
      appid: "wx0123456789abcdef",
      setting: { es6: true },
      projectname: "keep-name",
    });
    expect(
      await readFile(join(root, "miniprogram/config.ts"), "utf8"),
    ).toContain("cloud-fixture-123");
  });
});
