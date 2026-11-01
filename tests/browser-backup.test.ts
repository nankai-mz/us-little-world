import { describe, it, expect, vi } from "vitest";
import { createLocalService, stageBackup, commitBackup } from "../web/platform";
import type { StorageAdapter } from "../src/core/types";

function storage(values: Record<string, string>): StorageAdapter {
  return {
    get: (k) => values[k] ?? null,
    set: (k, v) => {
      values[k] = v;
    },
    remove: (k) => {
      delete values[k];
    },
  };
}
describe("浏览器备份导入", () => {
  it("在隔离存储中恢复记录和图片，原存储完全不改变", async () => {
    const values: Record<string, string> = { userId: "local-alice" };
    const service = createLocalService(storage(values));
    const recoveryKey = await service.create(
      "my original local password",
      "本机测试",
      "2026-10-30",
    );
    const photo = await service.addPhoto(
      "AQIDBA==",
      "image/png",
      "fixture.png",
      "private",
    );
    await service.save(
      {
        kind: "memory",
        title: "应当完整恢复的私人记录",
        date: "2026-10-30",
        photos: [photo],
      },
      "private",
    );
    const before = JSON.stringify(values);
    const backup = {
      format: "UsBackup",
      version: 1,
      vault: service.vault,
      database: values.database,
      files: Object.fromEntries(
        Object.entries(values).filter(([k]) => k.startsWith("file.")),
      ),
    };
    const restoredValues = await stageBackup(
      backup,
      recoveryKey,
      "new personal restore password",
    );
    expect(JSON.stringify(values)).toBe(before);
    const restored = createLocalService(storage(restoredValues));
    await restored.unlock("new personal restore password");
    expect(
      restored.entries.some((e) => e.data.title === "应当完整恢复的私人记录"),
    ).toBe(true);
    expect(await restored.readPhoto(photo, "private")).toBe("AQIDBA==");
    expect(restored.secrets!.deviceId).not.toBe(service.secrets!.deviceId);
    await expect(
      stageBackup(backup, "0".repeat(64), "new personal restore password"),
    ).rejects.toThrow();
    expect(JSON.stringify(values)).toBe(before);
  });
  it("提交备份遇到存储配额错误，保留旧数据库、旧密钥及已有文件", () => {
    const values = new Map([
      ["us.personal.database", "old-database"],
      ["us.personal.vault", "old-vault"],
      ["us.personal.file.existing", "old-encrypted-file"],
    ]);
    let rejected = false;
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => values.get(k) ?? null,
      removeItem: (k: string) => {
        values.delete(k);
      },
      setItem: (k: string, v: string) => {
        if (k === "us.personal.vault" && !rejected) {
          rejected = true;
          throw new Error("Quota exceeded");
        }
        values.set(k, v);
      },
    });
    try {
      expect(() =>
        commitBackup("personal", {
          userId: "new-id",
          database: "new-database",
          vault: "new-vault",
        }),
      ).toThrow();
      expect(values.get("us.personal.database")).toBe("old-database");
      expect(values.get("us.personal.vault")).toBe("old-vault");
      expect(values.has("us.personal.userId")).toBe(false);
      expect(values.get("us.personal.file.existing")).toBe(
        "old-encrypted-file",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
