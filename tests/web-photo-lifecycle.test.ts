import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { UsService } from "../src/core/service";
import { b64, hashText } from "../src/core/crypto";
import { photoReceiptFor } from "../src/core/photo-write";
import { AppError, type CipherRecord } from "../src/core/types";
import { createApi } from "../src/server/api";
import { CLOSING_GRACE_MS, PHOTO_DRAFT_TTL_MS, RECORD_RECEIPTS, runMaintenance } from "../src/server/lifecycle";
import { openWebRepository } from "../src/server/web-repository";

it("SQLite 维护可删除旧格式的已用邀请码，并完成双人空间清理", async () => {
  const store = openWebRepository(":memory:");
  let time = Date.now();
  const deps = { ...store, now: () => time, id: () => randomBytes(16).toString("hex"),
    hash: hashText, recordReceipts: true, managedPhotos: true };
  const api = createApi(deps);
  function member(userId: string) {
    const values = new Map<string, string>();
    return new UsService({
      async call<T>(action: string, data: Record<string, unknown> = {}) {
        const reply = await api(userId, action, data);
        if (!reply.success) throw new AppError(reply.error!.code, reply.error!.message);
        return reply.data as T;
      },
    }, { get: (key) => values.get(key) ?? null, set: (key, value) => { values.set(key, value); },
      remove: (key) => { values.delete(key); } }, async (size) => randomBytes(size));
  }
  try {
    const a = member("fixture-a");
    const b = member("fixture-b");
    await a.create("synthetic first member phrase", "维护回归空间", "2026-11-01");
    const used = await a.call<{ token: string }>("createInvitation");
    const unused = await a.call<{ token: string }>("createInvitation");
    await b.join("synthetic second member phrase", used.token);
    const spaceId = a.space!.id;
    expect(await store.repo.get("invitations", hashText(used.token))).toMatchObject({ usedBy: b.userId });
    expect((await store.repo.list("invitations", { spaceId }, 0, 10)).map(({ id }) => id))
      .toEqual([hashText(used.token), hashText(unused.token)].sort());
    await store.repo.put(RECORD_RECEIPTS, "expired-receipt", { spaceId, expiresAt: time + 1 });
    time += 3600001;
    await runMaintenance(deps);
    expect(await store.repo.get("invitations", hashText(used.token))).toBeNull();
    expect(await store.repo.get(RECORD_RECEIPTS, "expired-receipt")).toBeNull();
    await store.repo.put("invitations", "legacy-used-invitation", { spaceId, usedBy: b.userId, expiresAt: time });
    await a.closeSpace();
    await b.closeSpace();
    time += CLOSING_GRACE_MS + 1;
    expect(await runMaintenance(deps)).toMatchObject({ completedSpaces: 1 });
    expect(await store.repo.get("spaces", spaceId)).toMatchObject({ status: "closed", members: [], purgedAt: time });
    expect(await store.repo.list("invitations", { spaceId }, 0, 10)).toEqual([]);
    expect(await store.repo.list("encrypted_records", { spaceId }, 0, 10)).toEqual([]);
    expect(await runMaintenance(deps)).toMatchObject({ completedSpaces: 0 });
  } finally { store.close(); }
});

it("Web 照片的引用、回收站、到期清理和永久删除保留事务边界", async () => {
  const store = openWebRepository(":memory:");
  let time = Date.now();
  let storageLow = false;
  const deps = { ...store, now: () => time, id: () => randomBytes(16).toString("hex"), hash: hashText,
    recordReceipts: true, managedPhotos: true, checkPhotoCapacity: async () => {
      if (storageLow) throw new AppError("PHOTO_STORAGE_LOW", "合成低磁盘测试");
    } };
  const api = createApi(deps);
  const vaultData = new Map<string, string>();
  const service = new UsService({
    async call<T>(action: string, data: Record<string, unknown> = {}) {
      const reply = await api("fixture-owner", action, data);
      if (!reply.success) throw new AppError(reply.error!.code, reply.error!.message);
      return reply.data as T;
    },
  }, {
    get: (key) => vaultData.get(key) ?? null,
    set: (key, value) => { vaultData.set(key, value); },
    remove: (key) => { vaultData.delete(key); },
  }, async (size) => randomBytes(size), { recordReceipts: true, managedPhotos: true });
  try {
    await service.create("synthetic local unlock phrase", "合成空间", "2026-11-17");
    const data = b64(randomBytes(15));
    const orphan = await service.addPhoto(data, "image/png", "abandoned.png", "shared");
    const retained = await service.addPhoto(data, "image/png", "retained.png", "shared");
    const photoMeta = (fileId: string) => store.repo.get("encrypted_files", fileId);
    const orphanPath = (await photoMeta(orphan.fileId!)).storageId;
    const retainedPath = (await photoMeta(retained.fileId!)).storageId;
    const record = await service.save({ kind: "memory", title: "保留照片", date: "2026-11-17", photos: [retained] });
    expect(await photoMeta(retained.fileId!)).toMatchObject({ recordId: record.id });
    storageLow = true;
    const envelope = JSON.parse(await store.fileGet(retainedPath));
    await expect(service.call("filePut", { envelope, receipt: photoReceiptFor("shared", envelope), visibility: "shared", managed: true }))
      .resolves.toMatchObject({ id: retained.fileId });
    await expect(service.addPhoto(data, "image/png", "one-shot.png", "shared")).rejects.toMatchObject({ code: "PHOTO_STORAGE_LOW" });
    await expect(service.addPhoto(data, "image/png", "segmented.png", "shared", () => {})).rejects.toMatchObject({ code: "PHOTO_STORAGE_LOW" });
    await expect(service.readPhoto(retained, "shared")).resolves.toBe(data);
    await expect(service.save({ kind: "memory", title: "空间不足时仍保留文字", date: "2026-11-17" }))
      .resolves.toMatchObject({ data: { title: "空间不足时仍保留文字" } });
    storageLow = false;
    await expect(service.call("fileDelete", { fileId: retained.fileId })).rejects.toMatchObject({ code: "PHOTO_LINKED" });
    await expect(service.save({ kind: "memory", title: "重复引用", date: "2026-11-17", photos: [retained] }))
      .rejects.toMatchObject({ code: "PHOTO_UNAVAILABLE" });

    const replacement = await service.addPhoto(data, "image/png", "replacement.png", "shared");
    const missing = { ...orphan, fileId: "nonexistent-file" };
    await expect(service.save({ ...record.data, photos: [replacement, missing] }, "shared", record))
      .rejects.toMatchObject({ code: "PHOTO_UNAVAILABLE" });
    expect((await photoMeta(replacement.fileId!)).recordId).toBeUndefined();
    expect(await photoMeta(retained.fileId!)).toMatchObject({ recordId: record.id });
    const initial = await store.repo.get("encrypted_records", record.id) as CipherRecord;
    expect(initial.revision).toBe(record.revision);

    await service.trash(record);
    time += PHOTO_DRAFT_TTL_MS + 1;
    await runMaintenance(deps);
    expect(await photoMeta(orphan.fileId!)).toBeNull();
    await expect(store.fileGet(orphanPath)).rejects.toThrow("Encrypted photo missing");
    expect(await service.readPhoto(retained, "shared")).toBe(data);
    const trashed = service.entries.find(({ id }) => id === record.id)!;
    await service.trash(trashed, true);
    expect(service.active.some(({ id }) => id === record.id)).toBe(true);
    await service.trash(service.active.find(({ id }) => id === record.id)!);
    await service.purge(service.entries.find(({ id }) => id === record.id)!);
    expect(await photoMeta(retained.fileId!)).toBeNull();
    await expect(store.fileGet(retainedPath)).rejects.toThrow("Encrypted photo missing");
    expect(await store.repo.get("encrypted_records", record.id)).toBeNull();
  } finally {
    store.close();
  }
});
