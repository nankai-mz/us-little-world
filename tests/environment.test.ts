import { describe, it, expect } from "vitest";
import { selectCloudEnv } from "../src/core/env";

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
