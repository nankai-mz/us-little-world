import { afterEach, describe, expect, it, vi } from "vitest";
import { selectCloudEnv } from "../src/core/env";
import type { Attachment, Entry, Secrets } from "../src/core/types";

describe("开发/生产云环境选择", () => {
  it("正式版始终使用正式环境", () => {
    expect(selectCloudEnv("prod-env", "dev-env", "release")).toBe("prod-env");
    expect(selectCloudEnv("prod-env", "", "release")).toBe("prod-env");
  });
  it("开发版和体验版使用测试环境，未配置时回落正式环境", () => {
    expect(selectCloudEnv("prod-env", "dev-env", "develop")).toBe("dev-env");
    expect(selectCloudEnv("prod-env", "dev-env", "trial")).toBe("dev-env");
    expect(selectCloudEnv("prod-env", "", "develop")).toBe("prod-env");
    expect(selectCloudEnv("prod-env", "", "trial")).toBe("prod-env");
  });
  it("缺少版本信息时按开发处理，避免开发写入正式数据", () => {
    expect(selectCloudEnv("prod-env", "dev-env", undefined)).toBe("dev-env");
    expect(selectCloudEnv("prod-env", "", undefined)).toBe("prod-env");
  });
});

describe("小程序本机环境隔离", () => {
  afterEach(() => {
    vi.doUnmock("../miniprogram/config");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("同一设备切换版本时保留原密钥库，并独立保存和清理测试照片", async () => {
    let envVersion = "trial";
    const storage = new Map([["us.vault", '{"legacy":true}']]);
    const files = new Map([["/local/us-shared-photo.jpg", "production"]]);
    vi.doMock("../miniprogram/config", () => ({
      config: { cloudEnv: "prod-env", devCloudEnv: "dev-env", cloudFunction: "usApi" },
    }));
    vi.stubGlobal("wx", {
      getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
      getStorageSync: (key: string) => storage.get(key),
      setStorageSync: (key: string, value: string) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
      env: { USER_DATA_PATH: "/local" },
      getFileSystemManager: () => ({
        accessSync: (path: string) => {
          if (!files.has(path)) throw new Error("File does not exist");
        },
        writeFileSync: (path: string, value: string) => files.set(path, value),
        unlinkSync: (path: string) => files.delete(path),
        readdirSync: () => [...files.keys()].map((path) => path.slice("/local/".length)),
      }),
    });
    const entry = { visibility: "shared" } as Entry;
    const photo = { id: "photo", mime: "image/jpeg" } as Attachment;
    const dev = await import("../miniprogram/platform");
    expect(dev.service.vault).toBeNull();
    dev.service.storage.set("vault", '{"testing":true}');
    dev.service.secrets = {} as Secrets;
    vi.spyOn(dev.service, "readPhoto").mockResolvedValue("test image");
    const devPhoto = await dev.photoPath(entry, photo);
    expect(files.get(devPhoto)).toBe("test image");

    envVersion = "release";
    vi.resetModules();
    const prod = await import("../miniprogram/platform");
    expect(prod.service.vault).toEqual({ legacy: true });
    prod.service.secrets = {} as Secrets;
    const prodPhoto = await prod.photoPath(entry, photo);
    expect(files.get(prodPhoto)).toBe("production");
    prod.clearDecryptedFiles();
    expect(files.has(devPhoto)).toBe(true);
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
