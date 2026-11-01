import { describe, it, expect } from "vitest";
import { cloudRepository } from "../src/server/cloud-repository";
describe("CloudBase 适配器", () => {
  it("兼容 SDK 单文档对象和数组返回，剥离数据库内部 ID", async () => {
    for (const data of [
      { _id: "r", id: "r", revision: 1 },
      [{ _id: "r", id: "r", revision: 1 }],
    ]) {
      const db = {
        collection: () => ({ doc: () => ({ get: async () => ({ data }) }) }),
      };
      expect(await cloudRepository(db).get("records", "r")).toEqual({
        id: "r",
        revision: 1,
      });
    }
  });
  it("不存在文档返回空，权限或网络错误不会伪装成空数据库", async () => {
    const db = (failure: any) => ({
      collection: () => ({
        doc: () => ({
          get: async () => {
            throw failure;
          },
        }),
      }),
    });
    expect(
      await cloudRepository(db({ code: "DOCUMENT_NOT_EXIST" })).get("x", "r"),
    ).toBeNull();
    await expect(
      cloudRepository(db({ code: "PERMISSION_DENIED" })).get("x", "r"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
