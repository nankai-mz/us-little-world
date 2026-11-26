import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  acceptTransfer,
  b64,
  context,
  createTransfer,
  decryptRecord,
  encryptRecord,
  fingerprint,
  hashText,
  lockVault,
  newSecrets,
  publicKeys,
  recoverVault,
  seal,
  unb64,
  unlockVault,
} from "../src/core/crypto";
import {
  addDays,
  daysBetween,
  nextAnniversary,
  togetherDays,
} from "../src/core/date";
import {
  canOpenCapsule,
  newPet,
  petAction,
  report,
  secureChoice,
} from "../src/core/domain";
import { createApi } from "../src/server/api";
import { canReplyToPhoto, finishPhotoPair, rebaseJournalEdit, receiptOf, stampMeal } from "../src/core/keepsakes";
import { MemoryRepository } from "../src/server/memory-repo";
import { MAX_PHOTO_BYTES, MAX_PHOTO_CIPHERTEXT, PHOTO_UPLOAD_PART_SIZE } from "../src/core/photos";
import {
  AppError,
  type Entry,
  type Payload,
  type Secrets,
  type Transport,
} from "../src/core/types";
import { UsService } from "../src/core/service";
const rng = async (n: number) => new Uint8Array(randomBytes(n));
const id = () => randomBytes(16).toString("hex");
const meta = {
  id: "record-one",
  spaceId: "space-one",
  creatorId: "alice",
  visibility: "shared" as const,
  revision: 0,
  createdAt: 1,
  updatedAt: 1,
};
async function identity(user: string) {
  const s = await newSecrets(rng, user, meta.spaceId);
  s.spaceKeys["1"] = b64(await rng(32));
  return s;
}

describe("端到端加密与密钥", () => {
  it("中文和 emoji 加密往返，不包含明文；每次使用不同 nonce", async () => {
    const s = await identity("alice");
    const data = {
      title: "只属于我们的晚霞🌅",
      latitude: 39.1,
      kind: "memory",
    };
    const a = await encryptRecord(meta, data, s, rng);
    const b = await encryptRecord(meta, data, s, rng);
    expect(JSON.stringify(a)).not.toContain(data.title);
    expect(a.envelope.nonce).not.toBe(b.envelope.nonce);
    expect(decryptRecord(a, s)).toEqual(data);
  });
  it("拒绝篡改密文、空间、记录 ID、作者和可见范围", async () => {
    const s = await identity("alice");
    const r = await encryptRecord(meta, { secret: "private data" }, s, rng);
    for (const patch of [
      { spaceId: "other" },
      { id: "other" },
      { creatorId: "mallory" },
      { visibility: "private" as const },
    ])
      expect(() => decryptRecord({ ...r, ...patch }, s)).toThrow();
    expect(() =>
      decryptRecord(
        {
          ...r,
          envelope: {
            ...r.envelope,
            ciphertext:
              (r.envelope.ciphertext[0] === "A" ? "B" : "A") +
              r.envelope.ciphertext.slice(1),
          },
        },
        s,
      ),
    ).toThrow();
  });
  it("知道空间密钥的对方，仍然不能解密私人日记", async () => {
    const a = await identity("alice");
    const b = await identity("bob");
    b.spaceKeys = { ...a.spaceKeys };
    const r = await encryptRecord(
      { ...meta, visibility: "private" },
      { body: "仅我自己" },
      a,
      rng,
    );
    expect(decryptRecord(r, a)).toEqual({ body: "仅我自己" });
    expect(() => decryptRecord(r, b)).toThrow();
  });
  it("密钥包只给正确目标，并验证 Ed25519 签名", async () => {
    const a = await identity("alice");
    const b = await identity("bob");
    b.spaceKeys = {};
    const t = await createTransfer(
      a,
      b.deviceId,
      publicKeys(b).encryptionPublicKey,
      rng,
    );
    const accepted = acceptTransfer(t, b, publicKeys(a).signingPublicKey);
    expect(accepted.spaceKeys).toEqual(a.spaceKeys);
    expect(() =>
      acceptTransfer(
        { ...t, toDevice: "attacker" },
        b,
        publicKeys(a).signingPublicKey,
      ),
    ).toThrow();
    expect(() =>
      acceptTransfer(
        { ...t, keyVersion: 9 },
        b,
        publicKeys(a).signingPublicKey,
      ),
    ).toThrow();
    expect(() =>
      acceptTransfer(t, b, publicKeys(b).signingPublicKey),
    ).toThrow();
  });
  it("安全码绑定两把公钥，替换 X25519 公钥也会改变安全码", async () => {
    const a = publicKeys(await identity("alice"));
    const attacker = publicKeys(await identity("mallory"));
    expect(fingerprint(a)).not.toBe(
      fingerprint({ ...a, encryptionPublicKey: attacker.encryptionPublicKey }),
    );
  });
  it("密钥包签名不依赖数据库对象字段顺序", async () => {
    const a = await identity("alice");
    const b = await identity("bob");
    // Isolate signature ordering from the separate known-key conflict check.
    b.spaceKeys = {};
    const t = await createTransfer(
      a,
      b.deviceId,
      publicKeys(b).encryptionPublicKey,
      rng,
    );
    const reordered = Object.fromEntries(
      Object.entries(t).reverse(),
    ) as typeof t;
    expect(
      acceptTransfer(reordered, b, publicKeys(a).signingPublicKey).spaceKeys[
        "1"
      ],
    ).toBe(a.spaceKeys["1"]);
  });
  it("口令和随机恢复密钥均可解锁；错误密钥会被拒绝", async () => {
    const s = await identity("alice");
    const { vault, recoveryKey } = await lockVault(
      s,
      "a long and personal password",
      rng,
    );
    expect(
      (await unlockVault(vault, "a long and personal password")).personalKey,
    ).toBe(s.personalKey);
    expect(recoverVault(vault, recoveryKey).spaceKeys).toEqual(s.spaceKeys);
    await expect(unlockVault(vault, "wrong long password")).rejects.toThrow();
    expect(() => recoverVault(vault, "0".repeat(64))).toThrow();
  });
});

async function setup() {
  let time = 1800000000000;
  const repo = new MemoryRepository();
  const files: Record<string, string> = {};
  const handler = createApi({
    repo,
    now: () => time,
    id,
    hash: hashText,
    filePut: async (p, s) => ((files[p] = s), p),
    fileGet: async (p) => files[p],
    fileDelete: async (p) => {
      delete files[p];
    },
  });
  const transport = (user: string): Transport => ({
    async call<T>(action: string, data = {}) {
      const r = await handler(user, action, data);
      if (!r.success) throw new AppError(r.error!.code, r.error!.message);
      return r.data as T;
    },
  });
  const storages: Record<string, Record<string, string>> = {};
  const make = (user: string) => {
    const s = (storages[user] ||= {});
    return new UsService(
      transport(user),
      {
        get: (k) => s[k] || null,
        set: (k, v) => {
          s[k] = v;
        },
        remove: (k) => {
          delete s[k];
        },
      },
      rng,
    );
  };
  const a = make("alice");
  await a.create(
    "long personal alice password",
    "我们的测试空间",
    "2025-06-01",
  );
  const invitation = await a.call<{ token: string }>("createInvitation");
  const b = make("bob");
  await b.join("long personal bob password", invitation.token);
  const bd = (await b.devices()).find((d) => d.userId === "bob")!;
  await a.transfer(bd, fingerprint(bd));
  await b.receive(fingerprint(publicKeys(a.secrets!)));
  return {
    a,
    b,
    repo,
    files,
    handler,
    make,
    transport,
    storages,
    setTime: (n: number) => {
      time = n;
    },
  };
}
describe("云端权限、并发与客户端集成", () => {
  it("两位成员同时给旧版餐桌小票盖章，各自的印章和原记录都保留", async () => {
    const { a, b, repo } = await setup();
    const data: Payload = { kind: "memory", title: "晚餐吃葱油面", body: "多加了一把葱", date: a.day, tags: ["今天吃什么"] };
    expect(receiptOf({ ...data, tags: ["日记"] })).toBeUndefined();
    const meal = await a.save(data);
    await Promise.all([stampMeal(a, meal.id, "again"), stampMeal(b, meal.id, "other")]);
    await b.refresh();
    const stamped = b.active.find(e => e.id === meal.id)!;
    expect(stamped.data).toMatchObject({ body: data.body, mealReceipt: { dish: "葱油面", meal: "晚餐", stamps: { alice: "again", bob: "other" } } });
    const edited = rebaseJournalEdit(data, { ...data, mealReceipt: { dish: "手擀面", meal: "晚餐" } }, stamped.data);
    expect(edited).toMatchObject({ title: "晚餐吃手擀面", mealReceipt: { stamps: { alice: "again", bob: "other" } } });
    await stampMeal(b, meal.id, "other");
    expect(b.active.find(e => e.id === meal.id)?.revision).toBe(stamped.revision);
    expect(JSON.stringify(repo.data)).not.toContain("葱油面");
  });
  it("共同相纸只接受对方的一次接图，并保留两张加密照片", async () => {
    const { a, b } = await setup();
    const first = await a.addPhoto(new Uint8Array([1, 2]), "image/png", "早晨.png", "shared");
    const second = await b.addPhoto(new Uint8Array([3, 4]), "image/png", "傍晚.png", "shared");
    const sheet = await a.save({ kind: "memory", title: "窗外", date: a.day, photos: [first], photoPage: true });
    expect(canReplyToPhoto(sheet, a.userId)).toBe(false);
    expect(canReplyToPhoto({ ...sheet, visibility: "private" }, b.userId)).toBe(false);
    await expect(finishPhotoPair(a, sheet.id, first)).rejects.toMatchObject({ code: "PHOTO_CHANGED" });
    expect(canReplyToPhoto(sheet, b.userId)).toBe(true);
    await finishPhotoPair(b, sheet.id, second);
    await finishPhotoPair(b, sheet.id, second);
    await expect(finishPhotoPair(b, sheet.id, first)).rejects.toMatchObject({ code: "PHOTO_CHANGED" });
    await a.refresh();
    const pair = a.active.find(e => e.id === sheet.id)!;
    expect(pair.data.photos?.map(p => p.id)).toEqual([first.id, second.id]);
    const localPhoto = { ...first, id: "later-photo" };
    const edited = rebaseJournalEdit(sheet.data, { ...sheet.data, photos: [localPhoto] }, pair.data);
    expect(edited.photos?.map(photo => photo.id)).toEqual([second.id, localPhoto.id]);
    expect(edited.replyPhotoId).toBe(second.id);
    expect(await a.readPhoto(pair.data.photos![1], "shared")).toBe("AwQ=");
    expect(canReplyToPhoto(pair, b.userId)).toBe(false);
  });
  it("同一天不同问题分别保存，双方对同一题异步回答后合并", async () => {
    const { a, b } = await setup();
    await a.answer("第一个话题", "A 的第一个答案");
    await b.answer("第二个话题", "B 的第二个答案");
    await b.answer("第一个话题", "B 的第一个答案");
    await a.refresh();
    const first = a.active.find((e) => e.data.title === "第一个话题")!;
    const second = a.active.find((e) => e.data.title === "第二个话题")!;
    expect(first.data.answers).toEqual({
      alice: "A 的第一个答案",
      bob: "B 的第一个答案",
    });
    expect(second.data.answers).toEqual({ bob: "B 的第二个答案" });
  });
  it("完整双人创建、邀请、签名密钥交换及共同记录同步", async () => {
    const { a, b, repo } = await setup();
    await a.save({
      kind: "memory",
      title: "只有两个人知道的日常",
      body: "测试秘密内容",
      date: "2026-10-30",
    });
    await b.refresh();
    expect(b.active.some((e) => e.data.body === "测试秘密内容")).toBe(true);
    expect(JSON.stringify(repo.data)).not.toContain("测试秘密内容");
    expect(JSON.stringify(repo.data)).not.toContain(a.secrets!.personalKey);
  });
  it("非成员无法列表、改写、读文件；对方无法获取私人记录", async () => {
    const { a, b, handler } = await setup();
    const r = await a.save(
      { kind: "memory", title: "这是我的私人手账", date: "2026-10-30" },
      "private",
    );
    await b.refresh();
    expect(b.entries.some((e) => e.id === r.id)).toBe(false);
    const stranger = await handler("mallory", "listRecords", {
      spaceId: a.space!.id,
      deviceId: a.secrets!.deviceId,
    });
    expect(stranger.error?.code).toBe("MEMBER_REQUIRED");
    const remove = await handler("bob", "deleteRecord", {
      spaceId: a.space!.id,
      deviceId: b.secrets!.deviceId,
      recordId: r.id,
      expectedRevision: r.revision,
    });
    expect(remove.error?.code).toBe("FORBIDDEN");
    const photo = await a.addPhoto(
      b64(new Uint8Array([1, 2, 3])),
      "image/png",
      "私密图.png",
      "private",
    );
    await expect(
      b.call("fileGet", { fileId: photo.fileId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await a.readPhoto(photo, "private")).toBe("AQID");
  });
  it("照片回执丢失时只查询一次保存结果，不重传密文", async () => {
    const { a, b, files } = await setup();
    const invoke = a.transport.call.bind(a.transport);
    let receipt: unknown;
    let writes = 0;
    let checks = 0;
    a.transport.call = async <T>(action: string, data = {} as Record<string, unknown>) => {
      if (action === "filePut") {
        writes++;
        receipt = data.receipt;
        await invoke(action, data);
        throw new AppError("TIMEOUT", "模拟上传回执丢失");
      }
      if (action === "fileUploadStatus") {
        checks++;
        expect(data).not.toHaveProperty("envelope");
      }
      return invoke<T>(action, data);
    };

    const photo = await a.addPhoto("AQID", "image/png", "照片", "private");
    expect(await a.readPhoto(photo, "private")).toBe("AQID");
    expect(writes).toBe(1);
    expect(checks).toBe(1);
    expect(Object.keys(files)).toHaveLength(1);
    expect(await b.call("fileUploadStatus", { receipt })).toEqual({ id: null });
  });
  it("区分云端没有照片登记和照片状态请求失败", async () => {
    const { a } = await setup();
    const invoke = a.transport.call.bind(a.transport);
    let networkUnavailable = false;
    a.transport.call = async <T>(action: string, data = {}) => {
      if (action === "filePut" || (networkUnavailable && action === "fileUploadStatus"))
        throw new AppError("TIMEOUT", "模拟连接超时");
      return invoke<T>(action, data);
    };
    await expect(a.addPhoto("AQID", "image/png", "照片", "shared"))
      .rejects.toMatchObject({ code: "PHOTO_NOT_CONFIRMED" });
    networkUnavailable = true;
    await expect(a.addPhoto("AQID", "image/png", "照片", "shared"))
      .rejects.toMatchObject({ code: "PHOTO_STATUS_UNAVAILABLE" });
  });
  it("最大照片分段传输，回执丢失只重发同一段，并可按原格式读取", async () => {
    const { a, b, files, repo } = await setup();
    const invoke = a.transport.call.bind(a.transport);
    const lengths: number[] = [];
    const indices: number[] = [];
    const progress: number[] = [];
    a.transport.call = async <T>(action: string, data = {} as Record<string, unknown>) => {
      expect(action).not.toBe("filePut");
      if (action === "fileUploadPart") {
        const index = data.index as number;
        const alreadySent = indices.includes(index);
        indices.push(index);
        lengths.push((data.chunk as string).length);
        const result = await invoke<T>(action, data);
        if (!alreadySent && index === 1) throw new AppError("TIMEOUT", "模拟分段回执丢失");
        return result;
      }
      if (action === "fileUploadCommit") {
        expect(data).not.toHaveProperty("chunk");
        await invoke<T>(action, data);
        throw new AppError("TIMEOUT", "模拟完成回执丢失");
      }
      return invoke<T>(action, data);
    };
    const bytes = b64(randomBytes(MAX_PHOTO_BYTES));
    const photo = await a.addPhoto(bytes, "image/png", "照片", "shared", (sent) => progress.push(sent));
    const total = Math.ceil(MAX_PHOTO_CIPHERTEXT / PHOTO_UPLOAD_PART_SIZE);
    expect(indices).toEqual([0, 1, 1, ...Array.from({ length: total - 2 }, (_, i) => i + 2)]);
    expect(lengths.every((length) => length <= PHOTO_UPLOAD_PART_SIZE)).toBe(true);
    expect(progress).toHaveLength(total);
    expect(Object.keys(files)).toHaveLength(1);
    expect(await repo.list("encrypted_files", { staging: true }, 0, 10)).toEqual([]);
    expect(await b.readPhoto(photo, "shared")).toBe(bytes);
    expect(await b.readPhoto(photo, "shared", () => true)).toBe(bytes);
  });
  it("邀请码只用一次，两个同时加入也不能出现第三名成员", async () => {
    const { a, repo, transport } = await setup();
    await expect(a.call("createInvitation")).rejects.toMatchObject({
      code: "SPACE_FULL",
    });
    const c = new UsService(
      transport("charlie"),
      { get: () => null, set() {}, remove() {} },
      rng,
    );
    await c.create("charlie long password", "另一个空间", "2026-01-01");
    const invitation = await c.call<{ token: string }>("createInvitation");
    const second = await c.call<{ token: string }>("createInvitation");
    const outcomes = await Promise.allSettled([
      transport("dana").call("joinSpace", { token: invitation.token }),
      transport("eve").call("joinSpace", { token: second.token }),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await repo.get("spaces", c.space!.id)).members).toHaveLength(2);
    await expect(
      transport("fred").call("joinSpace", { token: invitation.token }),
    ).rejects.toThrow();
  });
  it("过期邀请和伪造 creatorId 均被拒绝", async () => {
    const { repo, handler, a, setTime, transport } = await setup();
    await repo.put("invitations", hashText("expired"), {
      spaceId: a.space!.id,
      expiresAt: 1,
    });
    await expect(
      transport("eve").call("joinSpace", { token: "expired" }),
    ).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
    const r = await encryptRecord(
      { ...meta, spaceId: a.space!.id, creatorId: "bob" },
      {},
      a.secrets!,
      rng,
    );
    const result = await handler("alice", "putRecord", {
      spaceId: a.space!.id,
      deviceId: a.secrets!.deviceId,
      record: r,
      expectedRevision: 0,
    });
    expect(result.error?.code).toBe("FORBIDDEN");
  });
  it("乐观锁阻止旧版本覆盖；支持回收站恢复", async () => {
    const { a, b } = await setup();
    const first = await a.save({
      kind: "wish",
      title: "共同愿望",
      date: "2026-10-30",
    });
    await b.refresh();
    const stale = b.entries.find((e) => e.id === first.id)!;
    await a.save(
      { ...first.data, title: "对方刚刚修改后的愿望" },
      "shared",
      first,
    );
    await expect(
      b.save({ ...stale.data, title: "旧版本" }, "shared", stale),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await b.refresh();
    await b.trash(b.active.find((e) => e.id === first.id)!);
    expect(b.active.some((e) => e.id === first.id)).toBe(false);
    await b.trash(b.entries.find((e) => e.id === first.id)!, true);
    expect(b.active.some((e) => e.id === first.id)).toBe(true);
  });
  it("移除设备后令牌不能继续读写；旧公钥不能通过再次注册复活", async () => {
    const { a } = await setup();
    await a.call("revokeDevice", { targetDeviceId: a.secrets!.deviceId });
    await expect(a.refresh()).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
    await expect(a.registerDevice()).rejects.toMatchObject({
      code: "DEVICE_REVOKED",
    });
  });
  it("轮换后只向已验证设备送新密钥，并保持旧记录可读", async () => {
    const { a, b } = await setup();
    const old = await a.save({
      kind: "memory",
      title: "轮换前的回忆",
      date: "2026-10-30",
    });
    const oldSecrets = structuredClone(b.secrets!);
    expect(await a.rotateKey()).toBe(1);
    const fresh = await a.save({
      kind: "memory",
      title: "轮换后的回忆",
      date: "2026-10-30",
    });
    await b.refresh();
    expect(b.unreadable).toBe(1);
    expect(b.ready).toBe(false);
    await b.receive(fingerprint(publicKeys(a.secrets!)));
    expect(b.active.some((e) => e.id === old.id)).toBe(true);
    expect(b.active.some((e) => e.id === fresh.id)).toBe(true);
    const page = await a.call<{ records: any[] }>("listRecords");
    const encrypted = page.records.find((e) => e.id === fresh.id);
    expect(() => decryptRecord(encrypted, oldSecrets)).toThrow();
  });
  it("并发轮换不会让失败的一方使用错误的同版本密钥", async () => {
    const { a, b } = await setup();
    await Promise.allSettled([a.rotateKey(), b.rotateKey()]);
    await a.refresh();
    await b.refresh();
    for (const session of [a, b])
      if (session.ready)
        expect(
          hashText(session.secrets!.spaceKeys[session.space!.keyVersion]),
        ).toBe(session.space!.keyCommitment);
  });
  it("永久删除仅允许作者清理回收站中的本人记录", async () => {
    const { a, b } = await setup();
    const e = await a.save({
      kind: "memory",
      title: "可清理的测试记录",
      date: "2026-10-30",
    });
    await expect(a.purge(e)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await a.trash(e);
    await b.refresh();
    await expect(
      b.purge(b.entries.find((x) => x.id === e.id)!),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await a.purge(a.entries.find((x) => x.id === e.id)!);
    await b.refresh();
    expect(b.entries.some((x) => x.id === e.id)).toBe(false);
  });
  it("分页在整页都是对方私人记录时也会继续加载后面的共同记录", async () => {
    const { a, repo } = await setup();
    for (let i = 0; i < 205; i++)
      await repo.put("encrypted_records", `private-${i}`, {
        ...meta,
        id: `private-${i}`,
        spaceId: a.space!.id,
        creatorId: "bob",
        visibility: "private",
        createdAt: i + 1,
        updatedAt: i + 1,
      });
    const e = await a.save({
      kind: "memory",
      title: "第三页的共同回忆",
      date: "2026-10-30",
    });
    await a.refresh();
    expect(a.active.some((x) => x.id === e.id)).toBe(true);
    expect(a.unreadable).toBe(0);
  });
  it("恢复包必须属于当前账号，失败不得覆盖现有密钥库", async () => {
    const { a, b } = await setup();
    const previous = JSON.stringify(b.vault);
    await expect(
      b.recover(a.vault!, a.secrets!.recoveryKey!, "new long password"),
    ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(JSON.stringify(b.vault)).toBe(previous);
  });
  it("恢复时设备登记失败会保留正在使用的密钥库和已读取记录", async () => {
    const { a } = await setup();
    const entry = await a.save({ kind: "memory", title: "现有私人记录", date: "2026-10-30" }, "private");
    const originalVault = a.vault!;
    const originalSecrets = a.secrets!;
    const delegate = a.transport;
    a.transport = {
      call: (action, data) => action === "registerDevice"
        ? Promise.reject(new AppError("NETWORK_ERROR", "测试网络故障"))
        : delegate.call(action, data),
    };
    await expect(a.recover(originalVault, originalSecrets.recoveryKey!, "strong new recovery phrase"))
      .rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(a.vault).toEqual(originalVault);
    expect(a.secrets).toBe(originalSecrets);
    expect(a.active).toContainEqual(entry);
  });
  it("恢复同一账号时注册新设备、重包装密钥且可读取原记录", async () => {
    const { a, make } = await setup();
    await a.save({ kind: "memory", title: "恢复后还在", date: "2026-10-30" });
    const previousDevice = a.secrets!.deviceId;
    const restored = make("alice");
    await restored.recover(
      a.vault!,
      a.secrets!.recoveryKey!,
      "new strong recovery password",
    );
    expect(restored.secrets!.deviceId).not.toBe(previousDevice);
    expect(restored.active.some((e) => e.data.title === "恢复后还在")).toBe(
      true,
    );
  });
  it("关闭冷静期内双方只读，任一成员可撤销关闭", async () => {
    const { a, b } = await setup();
    await a.closeSpace();
    await b.closeSpace();
    await b.refresh();
    expect(b.space?.status).toBe("closing");
    await expect(
      b.save({ kind: "memory", title: "冷静期不可新增", date: "2026-11-01" }),
    ).rejects.toMatchObject({ code: "SPACE_CLOSING" });
    await b.cancelClose();
    await a.refresh();
    expect(a.space?.status).toBe("active");
  });
  it("AI 缺少一次性授权不能调用，未配置服务不会伪造 AI 结果", async () => {
    const { a } = await setup();
    await expect(
      a.call("aiGenerate", { text: "测试", task: "整理" }),
    ).rejects.toMatchObject({ code: "AI_CONSENT_REQUIRED" });
    await expect(
      a.call("aiGenerate", {
        text: "测试",
        taskId: "story",
        consent: true,
        consentAt: 1800000000000,
      }),
    ).rejects.toMatchObject({ code: "AI_NOT_CONFIGURED" });
    const privateEntry = await a.save(
      { kind: "memory", title: "绝不发送的个人内容", date: "2026-10-30" },
      "private",
    );
    await expect(
      a.ai([privateEntry.id], Date.now(), "story"),
    ).rejects.toMatchObject({ code: "INVALID_SELECTION" });
  });
});

describe("日期、宠物、胶囊与报告", () => {
  it("使用日历日期计算，含闰年、同日及未来开始日期", () => {
    expect(togetherDays("2026-10-30", "2026-10-30")).toBe(1);
    expect(togetherDays("2026-11-01", "2026-10-30")).toBe(0);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(nextAnniversary("2024-02-29", true, "2025-01-01")).toBe(
      "2025-02-28",
    );
    expect(nextAnniversary("2024-02-29", true, "2025-03-01")).toBe(
      "2026-02-28",
    );
    expect(() => daysBetween("2026-02-30", "2026-03-01")).toThrow();
  });
  it("宠物互动有每日上限，长期离线不会扣减或死亡", () => {
    let p = newPet();
    for (let i = 0; i < 5; i++)
      p = petAction(p, "feed", "alice", Date.UTC(2026, 9, 30));
    expect(p.hunger).toBe(100);
    expect(() =>
      petAction(p, "feed", "alice", Date.UTC(2026, 9, 30)),
    ).toThrow();
    expect(petAction(p, "pat", "alice", Date.UTC(2030, 1, 1)).hunger).toBe(100);
  });
  it("双人胶囊必须到期且两个不同成员都确认", () => {
    const e = {
      ...meta,
      data: {
        kind: "capsule",
        title: "未来",
        date: "2026-10-30",
        unlockDate: "2027-01-01",
        needsBoth: true,
        confirmedBy: ["alice"],
      },
    } as Entry;
    expect(canOpenCapsule(e, ["alice", "bob"], "2027-01-01")).toBe(false);
    e.data.confirmedBy!.push("bob");
    expect(canOpenCapsule(e, ["alice", "bob"], "2026-12-31")).toBe(false);
    expect(canOpenCapsule(e, ["alice", "bob"], "2027-01-01")).toBe(true);
    expect(canOpenCapsule(e, ["alice"], "2027-01-01")).toBe(false);
  });
  it("报告只统计范围内共同内容，不计入私人日记或已删除条目", () => {
    const entry = (id: string, date: string, patch: Partial<Entry> = {}) =>
      ({
        ...meta,
        id,
        data: {
          kind: "memory",
          title: id,
          date,
          photos: [{ id: "p", bytes: 10 }],
        },
        ...patch,
      }) as Entry;
    const result = report(
      [
        entry("one", "2026-10-01"),
        entry("private", "2026-10-02", { visibility: "private" }),
        entry("deleted", "2026-10-03", { deletedAt: 1 }),
        entry("old", "2025-10-01"),
      ],
      "2026-10-01",
      "2026-10-31",
    );
    expect(result.memories).toBe(1);
    expect(result.photos).toBe(1);
  });
  it("转盘拒绝空选项，使用拒绝采样避免模偏差", () => {
    expect(() => secureChoice(["a"], new Uint8Array([0]))).toThrow();
    expect(secureChoice(["a", "b", "c"], new Uint8Array([255, 254]))).toBe("c");
  });
});
