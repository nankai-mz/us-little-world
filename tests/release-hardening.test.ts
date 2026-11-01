import { describe, it, expect, vi } from "vitest";
import { createApi } from "../src/server/api";
import { MemoryRepository } from "../src/server/memory-repo";
import { createTransport } from "../src/core/transport";
import { createLocalService } from "../web/platform";
import { type Transport, AppError } from "../src/core/types";
import { hashText } from "../src/core/crypto";
import { API_PROTOCOL } from "../src/core/protocol";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function local() {
  const values: Record<string, string> = { userId: "phase2-alice" };
  return createLocalService({
    get: (key) => values[key] || null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  });
}
async function session() {
  const service = local();
  await service.create("phase two test password", "已验收的空间", "2025-08-29");
  return service;
}
function holdResponse(service: ReturnType<typeof local>, target: string) {
  const original = service.transport;
  const reached = gate();
  const release = gate();
  let held = false;
  service.transport = {
    async call<T>(action: string, data = {}) {
      const result = await original.call<T>(action, data);
      if (action === target && !held) {
        held = true;
        reached.resolve();
        await release.promise;
      }
      return result;
    },
  };
  return { reached: reached.promise, release: release.resolve };
}

describe("上线前请求与存储加固", () => {
  it("拒绝非法请求根节点而不暴露服务器异常", async () => {
    const api = createApi({
      repo: new MemoryRepository(),
      now: Date.now,
      id: () => "safe-id",
      hash: hashText,
    });
    for (const bad of [null, [], 2, "text"])
      expect((await api("alice", "bootstrap", bad)).error?.code).toBe(
        "INVALID_REQUEST",
      );
    expect((await api("alice", "", {})).error?.code).toBe("INVALID_REQUEST");
  });
  it("连接检查只返回运行状态，身份未认证时不能调用", async () => {
    const repo = new MemoryRepository();
    await repo.put("users", "alice", { spaceId: "secret-space" });
    const api = createApi({
      repo,
      now: () => 100,
      id: () => "safe-id",
      hash: hashText,
      runtime: { mode: "local" },
    });
    expect((await api("", "health")).error?.code).toBe("AUTH_REQUIRED");
    const result = await api("alice", "health");
    expect(result.data).toMatchObject({
      protocol: API_PROTOCOL,
      mode: "local",
      serverTime: 100,
    });
    expect(JSON.stringify(result)).not.toContain("secret-space");
    expect(JSON.stringify(result)).not.toContain("alice");
  });
  it("本机数据库不读取原型链，保留特殊键也不会污染全局对象", async () => {
    const repo = new MemoryRepository();
    expect(await repo.get("records", "constructor")).toBeNull();
    await repo.put("records", "__proto__", { title: "fixture" });
    expect(await repo.get("records", "__proto__")).toEqual({
      title: "fixture",
    });
    expect(({} as any).title).toBeUndefined();
  });
  it("存储配额失败时，单条修改和事务都不改变内存中的已验收数据", async () => {
    let reject = false;
    const repo = new MemoryRepository(undefined, () => {
      if (reject) throw new Error("quota");
    });
    await repo.put("records", "a", { revision: 1 });
    reject = true;
    await expect(repo.put("records", "a", { revision: 2 })).rejects.toThrow();
    expect((await repo.get("records", "a")).revision).toBe(1);
    await expect(
      repo.transaction(async (tx) => {
        await tx.put("records", "a", { revision: 3 });
      }),
    ).rejects.toThrow();
    expect((await repo.get("records", "a")).revision).toBe(1);
  });
});
describe("网络重试与超时", () => {
  it("只读请求遇到网络中断后有界重试", async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ success: true, data: 42 });
    expect(await createTransport(invoke).call("health")).toBe(42);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("修改请求不自动重发，提示先确认云端结果", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("lost response"));
    await expect(
      createTransport(invoke).call("putRecord"),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("身份拒绝和错误响应不重试", async () => {
    const denied = vi
      .fn()
      .mockResolvedValue({
        success: false,
        error: { code: "DEVICE_REVOKED", message: "revoked" },
      });
    await expect(
      createTransport(denied).call("listRecords"),
    ).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
    expect(denied).toHaveBeenCalledTimes(1);
    await expect(
      createTransport(async () => null).call("health"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("读取超时有界结束，不无限阻塞操作", async () => {
    vi.useFakeTimers();
    try {
      const invoke = vi.fn(() => new Promise(() => {}));
      const pending = createTransport(invoke, {
        timeoutMs: 10,
        retries: 1,
      }).call("health");
      const assertion = expect(pending).rejects.toMatchObject({
        code: "TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("接口协议不匹配时明确报错", async () => {
    const service = local();
    service.transport = {
      async call<T>() {
        return { protocol: API_PROTOCOL + 1 } as T;
      },
    };
    await expect(service.checkConnection()).rejects.toMatchObject({
      code: "PROTOCOL_MISMATCH",
    });
  });
});
describe("并发同步与会话锁定", () => {
  it("删除已成功但后续刷新断网时，缓存保持已删除状态并记录同步失败", async () => {
    const service = await session();
    const entry = await service.save({
      kind: "memory",
      title: "已删除的记录",
      date: "2026-10-30",
    });
    const original = service.transport;
    service.transport = {
      async call<T>(action: string, data = {}) {
        if (action === "listRecords")
          throw new AppError("NETWORK_ERROR", "fixture offline");
        return original.call<T>(action, data);
      },
    };
    await expect(service.trash(entry)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect(service.active.some((current) => current.id === entry.id)).toBe(
      false,
    );
    expect(
      service.entries.find((current) => current.id === entry.id)?.deletedAt,
    ).toBeTruthy();
    expect(service.lastSyncError).toBe("fixture offline");
  });
  it("较早开始的刷新不会覆盖期间新建或编辑的记录", async () => {
    const service = await session();
    const first = await service.save({
      kind: "memory",
      title: "原内容",
      date: "2026-10-30",
    });
    const held = holdResponse(service, "listRecords");
    const pending = service.refresh();
    await held.reached;
    await service.save(
      { ...first.data, title: "刚刚编辑后的内容" },
      "shared",
      first,
    );
    await service.save({
      kind: "memory",
      title: "刷新期间的新记录",
      date: "2026-10-30",
    });
    held.release();
    await pending;
    expect(
      service.active.some((e) => e.data.title === "刚刚编辑后的内容"),
    ).toBe(true);
    expect(
      service.active.some((e) => e.data.title === "刷新期间的新记录"),
    ).toBe(true);
  });
  it("锁定后，未完成的刷新不能恢复明文或空间状态", async () => {
    const service = await session();
    const held = holdResponse(service, "listRecords");
    const pending = service.refresh();
    await held.reached;
    service.lock();
    held.release();
    await pending;
    expect(service.entries).toEqual([]);
    expect(service.space).toBeNull();
    expect(service.secrets).toBeNull();
  });
  it("锁定后返回的保存响应不能把私人内容放回界面缓存", async () => {
    const service = await session();
    const held = holdResponse(service, "putRecord");
    const pending = service.save(
      { kind: "memory", title: "锁定期间的私人内容", date: "2026-10-30" },
      "private",
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: "SESSION_CHANGED",
    });
    await held.reached;
    service.lock();
    held.release();
    await assertion;
    expect(service.entries).toEqual([]);
    expect(service.space).toBeNull();
  });
  it("后发的刷新完成后，旧响应不能倒退同步状态", async () => {
    const service = await session();
    const held = holdResponse(service, "listRecords");
    const pending = service.refresh();
    await held.reached;
    await service.save({
      kind: "memory",
      title: "最新状态",
      date: "2026-10-30",
    });
    await service.refresh();
    const last = service.lastSyncedAt;
    held.release();
    await pending;
    expect(service.lastSyncedAt).toBe(last);
    expect(service.active.some((e) => e.data.title === "最新状态")).toBe(true);
  });
});
