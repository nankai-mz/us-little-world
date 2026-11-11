import { afterEach, describe, expect, it, vi } from "vitest";
import { selectCloudTarget } from "../src/core/env";
import type { Attachment, Secrets } from "../src/core/types";

describe("开发/生产云环境选择", () => {
  it("正式版始终走正式入口并沿用本机旧密钥库", () => {
    expect(selectCloudTarget("prod-env", "dev-env", "usApi", "release")).toEqual({
      env: "prod-env", functionName: "usApi", localScope: "",
    });
  });
  it.each(["develop", "trial", undefined])("%s 只走测试数据", (version) => {
    expect(selectCloudTarget("prod-env", "dev-env", "usApi", version)).toEqual({
      env: "dev-env", functionName: "usApi", localScope: "env.dev-env",
    });
    expect(selectCloudTarget("prod-env", "", "usApi", version)).toEqual({
      env: "prod-env", functionName: "usApiTest", localScope: "test.prod-env",
    });
  });
});

describe("小程序本机环境隔离", () => {
  afterEach(() => {
    vi.doUnmock("../miniprogram/config");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each(["", "dev-env"])("同一设备切换版本时隔离本机数据（独立云环境 %s）", async (devCloudEnv) => {
    let envVersion = "trial";
    const storage = new Map([["us.vault", '{"legacy":true}']]);
    const files = new Map([["/local/us-shared-photo.jpg", "production"]]);
    vi.doMock("../miniprogram/config", () => ({
      config: { cloudEnv: "prod-env", devCloudEnv, cloudFunction: "usApi" },
    }));
    const callFunction = vi.fn(async () => ({ result: { success: true, data: {} } }));
    vi.stubGlobal("wx", {
      getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
      getStorageSync: (key: string) => storage.get(key),
      setStorageSync: (key: string, value: string) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
      cloud: { callFunction },
      env: { USER_DATA_PATH: "/local" },
      getFileSystemManager: () => ({
        writeFile: ({ filePath, data, success }: { filePath: string; data: string; success: () => void }) => {
          files.set(filePath, data);
          success();
        },
        unlinkSync: (path: string) => files.delete(path),
        readdirSync: () => [...files.keys()].map((path) => path.slice("/local/".length)),
      }),
    });
    const photo = { id: "photo", mime: "image/jpeg" } as Attachment;
    const dev = await import("../miniprogram/platform");
    await dev.service.transport.call("health");
    expect(callFunction).toHaveBeenLastCalledWith(expect.objectContaining({
      name: devCloudEnv ? "usApi" : "usApiTest",
      config: { env: devCloudEnv || "prod-env" },
    }));
    expect(dev.service.vault).toBeNull();
    dev.service.storage.set("vault", '{"testing":true}');
    dev.service.secrets = {} as Secrets;
    const download = vi.spyOn(dev.service, "readPhoto").mockResolvedValue("test image");
    const [devPhoto, secondPath] = await Promise.all([
      dev.photoPath("shared", photo), dev.photoPath("shared", photo),
    ]);
    expect(secondPath).toBe(devPhoto);
    expect(download).toHaveBeenCalledOnce();
    expect(dev.cachedPhotoPath("shared", photo)).toBe(devPhoto);
    expect(files.get(devPhoto)).toBe("test image");

    envVersion = "release";
    vi.resetModules();
    const prod = await import("../miniprogram/platform");
    await prod.service.transport.call("health");
    expect(callFunction).toHaveBeenLastCalledWith(expect.objectContaining({
      name: "usApi", config: { env: "prod-env" },
    }));
    expect(prod.service.vault).toEqual({ legacy: true });
    expect(dev.localExportPath("backup.json")).not.toBe(prod.localExportPath("backup.json"));
    prod.service.secrets = {} as Secrets;
    const prodPhoto = await prod.photoPath("shared", photo, "production");
    expect(files.get(prodPhoto)).toBe("production");
    prod.clearDecryptedFiles();
    expect(files.has(devPhoto)).toBe(true);
    expect(prod.cachedPhotoPath("shared", photo)).toBe("");
    files.set(prodPhoto, "production");

    envVersion = "develop";
    vi.resetModules();
    const reopened = await import("../miniprogram/platform");
    expect(reopened.service.vault).toEqual({ testing: true });
    reopened.clearDecryptedFiles();
    reopened.service.storage.remove("vault");
    expect(reopened.service.vault).toBeNull();
    expect(prod.service.vault).toEqual({ legacy: true });
    expect(files.has(devPhoto)).toBe(false);
    expect(files.get(prodPhoto)).toBe("production");
  });
});
