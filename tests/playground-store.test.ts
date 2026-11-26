import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { b64, browserRandom, hashText, newSecrets, publicKeys } from "../src/core/crypto";
import { checkpointContext, opContext, encryptPlay, seedContext, workContext, decryptPlay } from "../src/features/play-core/crypto";
import { playActions, playRetention, type OpHeader, type RoomPage, type WorkHeader } from "../src/features/play-core/protocol";
import { createPlayApi } from "../src/server/activities/api";
import { collections } from "../src/server/activities/store";
import { openWebRepository } from "../src/server/web-repository";
import { archiveGame } from "../src/features/play-core/works";

const id = () => randomBytes(16).toString("hex");
const flags = "playground,async_games,shared_canvas";
const rejected = (code: string) => ({ success: false, error: { code } });

it("同一房间的双人权限、回合 CAS、重发回执、密钥轮换和过期清理", async () => {
  const files = openWebRepository(":memory:");
  let now = Date.now();
  const fail = (error: unknown) => { throw error; };
  const api = createPlayApi(files.playRepository, flags, () => now, hashText, fail);
  const spaceId = id(), roomId = id();
  const a = await newSecrets(browserRandom, "a", spaceId);
  const b = await newSecrets(browserRandom, "b", spaceId);
  a.spaceKeys[1] = b.spaceKeys[1] = b64(randomBytes(32));
  const write = (accountId: string, deviceId: string, action: string, input: Record<string, unknown>, valid = true) =>
    api.call({ accountId, deviceId, spaceId }, action, input, () => valid);
  try {
    await files.repo.put("spaces", spaceId, { id: spaceId, status: "active", keyVersion: 1, members: ["a", "b"] });
    for (const secrets of [a, b]) await files.repo.put("devices", secrets.deviceId, {
      id: secrets.deviceId, userId: secrets.userId, spaceId, status: "active", ...publicKeys(secrets),
    });
    const metadata = { id: roomId, spaceId, seedDeviceId: a.deviceId, createdBy: a.userId,
      keyVersion: 1, mode: "asynchronous", stage: "async_games" } as const;
    const seed = await encryptPlay({ title: "secret-plan-title" }, a, seedContext(metadata), browserRandom);
    expect(await write("a", a.deviceId, playActions.create, { ...metadata, roomId, seed, initialTurn: 0 }))
      .toMatchObject({ success: true, data: { turn: 0, revision: 0, expiresAt: null } });
    expect(await write("other", b.deviceId, playActions.get, { roomId })).toMatchObject(rejected("MEMBER_REQUIRED"));
    expect(await write("a", b.deviceId, playActions.get, { roomId })).toMatchObject(rejected("DEVICE_REVOKED"));
    expect(await write("a", a.deviceId, playActions.get, { roomId }, false)).toMatchObject(rejected("AUTH_REQUIRED"));
    expect(await write("b", b.deviceId, playActions.get, { roomId: id() })).toMatchObject(rejected("ROOM_UNAVAILABLE"));
    const header: OpHeader = { roomId, spaceId, opId: id(), deviceId: a.deviceId, actor: 0,
      keyVersion: 1, protocolVersion: 1, expectedRevision: 0, turn: 0, nextTurn: 1 };
    const envelope = await encryptPlay({ move: "secret-plan-move" }, a, opContext(header), browserRandom);
    const request = { roomId, header, envelope };
    const first = await write("a", a.deviceId, playActions.submit, request);
    expect(first).toMatchObject({ success: true, data: { sequence: 1, revision: 1 } });
    expect(await write("a", a.deviceId, playActions.submit, request)).toMatchObject({ success: true, data: { sequence: 1, revision: 1 } });
    expect(await write("a", a.deviceId, playActions.submit, { ...request, header: { ...header, opId: id() } }))
      .toMatchObject(rejected("REVISION_CONFLICT"));
    expect(await write("a", a.deviceId, playActions.submit, { ...request, header: { ...header, nextTurn: 0 } }))
      .toMatchObject(rejected("OPERATION_REUSED"));
    const response = await write("b", b.deviceId, playActions.get, { roomId });
    expect(response).toMatchObject({ success: true, data: { room: { turn: 1, lastSeq: 1 }, operations: [{ sequence: 1 }] } });
    expect(JSON.stringify(response)).not.toContain("secret-plan");
    for (const member of [a, b]) expect(await write(member.userId, member.deviceId, playActions.approveArchive,
      { roomId, expectedSequence: 1 })).toMatchObject({ success: true, data: { status: "active" } });
    const workId = id();
    const workMeta = { id: workId, authorId: a.userId, opId: id(), deviceId: a.deviceId, revision: 1,
      visibility: "shared", spaceId } as const;
    const workInput = { workId, opId: workMeta.opId, expectedRevision: 0, sourceRoomId: roomId, visibility: workMeta.visibility,
      envelope: await encryptPlay({ note: "合成共同作品" }, a, workContext(workMeta, 1), browserRandom) };
    expect(await write("a", a.deviceId, playActions.saveWork, { ...workInput, sourceSequence: 0 })).toMatchObject(rejected("ROOM_INACTIVE"));
    expect(await write("a", a.deviceId, playActions.saveWork, { ...workInput, sourceSequence: 1 })).toMatchObject({ success: true });
    for (const [index, member] of [a, b].entries()) expect(await write(member.userId, member.deviceId, playActions.close,
      { roomId, expectedSequence: 1 })).toMatchObject({ success: true, data: {
        status: index === 0 ? "active" : "completed", expiresAt: index === 0 ? null : now + playRetention,
      } });
    const foreign = id();
    await files.repo.put("spaces", foreign, { id: foreign, status: "active", members: ["a", "b"], keyVersion: 1 });
    await files.repo.put("devices", "foreign-device", { userId: "b", spaceId: foreign, status: "active" });
    expect(await api.call({ accountId: "b", deviceId: "foreign-device", spaceId: foreign }, playActions.get, { roomId }, () => true))
      .toMatchObject(rejected("ROOM_UNAVAILABLE"));
    await files.repo.put("spaces", spaceId, { id: spaceId, status: "active", keyVersion: 2, members: ["a", "b"] });
    expect(await write("b", b.deviceId, playActions.pause, { roomId, expectedRevision: 1 })).toMatchObject(rejected("KEY_VERSION_CHANGED"));
    expect(await write("b", b.deviceId, playActions.get, { roomId })).toMatchObject({ success: true });
    await files.repo.put("devices", b.deviceId, { id: b.deviceId, userId: "b", spaceId, status: "revoked" });
    expect(await write("b", b.deviceId, playActions.get, { roomId })).toMatchObject(rejected("DEVICE_REVOKED"));
    now += playRetention + 1;
    await api.prune();
    expect(await files.repo.get(collections.rooms, roomId)).toBeNull();
    expect(await files.repo.get(collections.receipts, roomId + ":" + header.opId)).toBeNull();
    expect(await files.repo.get(collections.works, workId)).not.toBeNull();
  } finally { await files.close(); }
});

it("未完成房间经两位成员确认才开始闲置清理，可取消、继续或手动延长", async () => {
  const files = openWebRepository(":memory:");
  let now = Date.now();
  const api = createPlayApi(files.playRepository, flags, () => now, hashText, (error) => { throw error; });
  const spaceId = id(), roomId = id();
  const a = await newSecrets(browserRandom, "a", spaceId);
  const b = await newSecrets(browserRandom, "b", spaceId);
  a.spaceKeys[1] = b.spaceKeys[1] = b64(randomBytes(32));
  const call = (actor: typeof a, action: string, input: Record<string, unknown> = {}) =>
    api.call({ accountId: actor.userId, deviceId: actor.deviceId, spaceId }, action, { roomId, ...input }, () => true);
  try {
    await files.repo.put("spaces", spaceId, { id: spaceId, status: "active", keyVersion: 1, members: ["a", "b"] });
    for (const actor of [a, b]) await files.repo.put("devices", actor.deviceId, {
      id: actor.deviceId, userId: actor.userId, spaceId, status: "active",
    });
    const metadata = { id: roomId, spaceId, seedDeviceId: a.deviceId, createdBy: a.userId,
      keyVersion: 1, mode: "asynchronous", stage: "async_games" } as const;
    const seed = await encryptPlay({ title: "长时间进行的活动" }, a, seedContext(metadata), browserRandom);
    expect(await call(a, playActions.create, { ...metadata, seed, initialTurn: null }))
      .toMatchObject({ success: true, data: { expiresAt: null } });
    expect(await call(a, playActions.approveCleanup, { expectedRevision: 0 }))
      .toMatchObject({ success: true, data: { cleanupVotes: [0], expiresAt: null } });
    now += playRetention + 1;
    await api.prune();
    expect(await call(b, playActions.list)).toMatchObject({ success: true, data: { items: [{ id: roomId }] } });
    expect(await call(b, playActions.approveCleanup, { expectedRevision: 0 })).toMatchObject(rejected("REVISION_CONFLICT"));
    expect(await call(b, playActions.approveCleanup, { expectedRevision: 1 }))
      .toMatchObject({ success: true, data: { cleanupVotes: [0, 1], expiresAt: now + playRetention } });
    expect(await call(a, playActions.keepRoom, { expectedRevision: 2 }))
      .toMatchObject({ success: true, data: { expiresAt: null } });
    now += playRetention + 1;
    await api.prune();
    expect(await call(b, playActions.get)).toMatchObject({ success: true, data: { room: { expiresAt: null } } });
    await call(b, playActions.approveCleanup, { expectedRevision: 3 });
    await call(a, playActions.approveCleanup, { expectedRevision: 4 });
    now += playRetention - 1;
    const header: OpHeader = { roomId, spaceId, opId: id(), deviceId: a.deviceId, actor: 0,
      keyVersion: 1, protocolVersion: 1, expectedRevision: 5, turn: null, nextTurn: null };
    const envelope = await encryptPlay({ move: "continued" }, a, opContext(header), browserRandom);
    expect(await call(a, playActions.submit, { header, envelope })).toMatchObject({ success: true });
    expect(await call(b, playActions.get)).toMatchObject({ success: true, data: { room: { expiresAt: now + playRetention } } });
    now += 2;
    expect(await call(b, playActions.extend)).toMatchObject({ success: true, data: { expiresAt: now + playRetention } });
    now += playRetention - 1;
    await api.prune();
    expect(await call(b, playActions.get)).toMatchObject({ success: true });
    now += 1;
    await api.prune();
    expect(await call(b, playActions.get)).toMatchObject(rejected("ROOM_UNAVAILABLE"));
    expect(await files.repo.get(collections.operations, roomId + ":00000001")).toBeNull();
  } finally { files.close(); }
});

it("作品保存可幂等重试，私人、共享设备和旧版本访问均核对授权", async () => {
  const files = openWebRepository(":memory:");
  const api = createPlayApi(files.playRepository, flags, Date.now, hashText, (error) => { throw error; });
  const spaceId = id(), workId = id();
  const a = await newSecrets(browserRandom, "a", spaceId);
  const b = await newSecrets(browserRandom, "b", spaceId);
  const limited = await newSecrets(browserRandom, "a", spaceId);
  const call = (actor: typeof a, action: string, input: Record<string, unknown> = {}) =>
    api.call({ accountId: actor.userId, deviceId: actor.deviceId, spaceId }, action, input, () => true);
  try {
    await files.repo.put("spaces", spaceId, { id: spaceId, status: "active", keyVersion: 1, members: ["a", "b"] });
    for (const secrets of [a, b, limited]) await files.repo.put("devices", secrets.deviceId, {
      id: secrets.deviceId, userId: secrets.userId, spaceId, status: "active", sharedOnly: secrets === limited,
    });
    const fields = { id: workId, spaceId, visibility: "private", authorId: a.userId,
      deviceId: a.deviceId, opId: id(), revision: 1 } as const;
    const envelope = await encryptPlay({ story: "只给自己收藏的合成文字" }, a, workContext(fields, 1), browserRandom);
    const request = { workId, opId: fields.opId, visibility: "private", expectedRevision: 0, envelope };
    expect(await call(a, playActions.saveWork, request)).toMatchObject({ success: true, data: { revision: 1 } });
    expect(await call(a, playActions.saveWork, request)).toMatchObject({ success: true, data: { revision: 1 } });
    for (const actor of [b, limited]) {
      expect(await call(actor, playActions.getWork, { workId })).toMatchObject(rejected("WORK_UNAVAILABLE"));
      expect(await call(actor, playActions.listWorks)).toMatchObject({ success: true, data: { items: [] } });
    }
    const another = { ...fields, opId: id(), revision: 2 };
    expect(await call(a, playActions.saveWork, { ...request, opId: another.opId, expectedRevision: 1,
      envelope: await encryptPlay({ story: "改稿" }, a, workContext(another, 1), browserRandom) }))
      .toMatchObject({ success: true, data: { revision: 2 } });
    const work = (await call(a, playActions.getWork, { workId, revision: 1 })).data as WorkHeader;
    expect(decryptPlay(work.envelope, a, workContext(work, 1))).toEqual({ story: "只给自己收藏的合成文字" });
    const deletion = { workId, opId: id(), expectedRevision: 2 };
    expect(await call(a, playActions.deleteWork, deletion)).toMatchObject({ success: true });
    expect(await call(a, playActions.deleteWork, deletion)).toMatchObject({ success: true });
    expect(await call(a, playActions.saveWork, request)).toMatchObject(rejected("WORK_UNAVAILABLE"));
  } finally { await files.close(); }
});

it("5000 次加密操作顺序一致，双成员检查点才压缩，老回执仍可重试", async () => {
  const files = openWebRepository(":memory:");
  let at = Date.now();
  const api = createPlayApi(files.playRepository, flags, () => at, hashText, (error) => { throw error; });
  const spaceId = id(), roomId = id();
  const a = await newSecrets(browserRandom, "a", spaceId);
  const b = await newSecrets(browserRandom, "b", spaceId);
  a.spaceKeys[1] = b.spaceKeys[1] = b64(randomBytes(32));
  const call = (actor: typeof a, action: string, input: object) =>
    api.call({ accountId: actor.userId, deviceId: actor.deviceId, spaceId }, action, { roomId, ...input }, () => true);
  try {
    await files.repo.put("spaces", spaceId, { id: spaceId, status: "active", keyVersion: 1, members: ["a", "b"] });
    for (const actor of [a, b]) await files.repo.put("devices", actor.deviceId, { id: actor.deviceId, userId: actor.userId, spaceId, status: "active", ...publicKeys(actor) });
    const room = { id: roomId, spaceId, seedDeviceId: a.deviceId, createdBy: a.userId, keyVersion: 1,
      mode: "realtime", stage: "shared_canvas" } as const;
    expect((await call(a, playActions.create, { ...room, initialTurn: null,
      seed: await encryptPlay({ activityId: "c15" }, a, seedContext(room), browserRandom) })).success).toBe(true);
    await call(b, playActions.join, {});
    let first: { header: OpHeader; envelope: WorkHeader["envelope"] } | undefined;
    for (let number = 1; number <= 5000; number++) {
      at += 55;
      const actor = number % 2 ? a : b;
      const header: OpHeader = { roomId, spaceId, opId: id(), deviceId: actor.deviceId, actor: number % 2 ? 0 : 1,
        keyVersion: 1, protocolVersion: 1, expectedRevision: number, turn: null, nextTurn: null };
      const envelope = await encryptPlay({ draw: number }, actor, opContext(header), browserRandom);
      if (!first) first = { header, envelope };
      const stored = await call(actor, playActions.submit, { header, envelope });
      expect(stored).toMatchObject({ success: true, data: { sequence: number, revision: number + 1 } });
      if (number === 200) {
        const checkpoint = { id: id(), roomId, spaceId, deviceId: a.deviceId, keyVersion: 1, through: number, author: 0 as const };
        const envelope = await encryptPlay({ counter: number }, a, checkpointContext(checkpoint), browserRandom);
        expect((await call(a, playActions.putSnapshot, { snapshotId: checkpoint.id, through: number, envelope })).success).toBe(true);
        expect(((await call(b, playActions.get, { after: 0 })).data as RoomPage).operations[0].sequence).toBe(1);
        await call(a, playActions.confirmSnapshot, { snapshotId: checkpoint.id });
        expect(((await call(a, playActions.get, { after: 0 })).data as RoomPage).room.snapshotThrough).toBeUndefined();
        await call(b, playActions.confirmSnapshot, { snapshotId: checkpoint.id });
        const page = (await call(b, playActions.get, { after: 0 })).data as RoomPage;
        expect(page.operations).toHaveLength(0);
        expect(page.checkpoint?.confirmations).toEqual([0, 1]);
        expect(decryptPlay(page.checkpoint!.envelope, b, checkpointContext(page.checkpoint!))).toEqual({ counter: 200 });
      }
      if (number % 500 === 0) {
        const page = (await call(b, playActions.get, { after: number - 2 })).data as RoomPage;
        expect(page.operations.map(({ sequence }) => sequence)).toEqual([number - 1, number]);
      }
    }
    expect(await call(a, playActions.submit, first!)).toMatchObject({ success: true, data: { sequence: 1, revision: 2 } });
  } finally { await files.close(); }
}, 30000);

it("SQLite v2 原库升级和隔离恢复保留旧日记、作品历史与撤销状态", async () => {
  const root = resolve("artifacts");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "play-recovery-"));
  const authority = join(dir, "authority.sqlite"), backup = join(dir, "backup.sqlite"), candidate = join(dir, "candidate.sqlite");
  const run = promisify(execFile);
  const spaceId = id();
  const a = await newSecrets(browserRandom, "a", spaceId);
  const b = await newSecrets(browserRandom, "b", spaceId);
  const former = new DatabaseSync(authority);
  former.exec(`
    CREATE TABLE documents (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id));
    CREATE TABLE photos (path TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE web_history (slot INTEGER PRIMARY KEY, lineage TEXT NOT NULL, generation INTEGER NOT NULL);
    PRAGMA user_version = 2;
  `);
  former.prepare("INSERT INTO web_history VALUES (1, ?, 4)").run("a".repeat(64));
  former.prepare("INSERT INTO documents VALUES ('spaces', ?, ?)").run(spaceId,
    JSON.stringify({ id: spaceId, members: ["a", "b"], status: "active", keyVersion: 1 }));
  const memoryId = id();
  former.prepare("INSERT INTO documents VALUES ('encrypted_records', ?, ?)").run(memoryId,
    JSON.stringify({ id: memoryId, spaceId, creatorId: "a", visibility: "shared", revision: 1 }));
  former.close();
  let files = openWebRepository(authority);
  const apiFor = () => createPlayApi(files.playRepository, flags, Date.now, hashText, (error) => { throw error; });
  const call = (secrets: typeof a, action: string, input: Record<string, unknown>) => apiFor().call({
    accountId: secrets.userId, deviceId: secrets.deviceId, spaceId,
  }, action, input, () => true);
  try {
    const opened = new DatabaseSync(authority, { readOnly: true });
    expect(opened.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    opened.close();
    for (const actor of [a, b]) await files.repo.put("devices", actor.deviceId, { id: actor.deviceId, userId: actor.userId, spaceId, status: "active" });
    const roomId = id();
    a.spaceKeys[1] = b.spaceKeys[1] = b64(randomBytes(32));
    const roomSeed = { id: roomId, spaceId, seedDeviceId: a.deviceId, createdBy: a.userId,
      keyVersion: 1, mode: "asynchronous", stage: "async_games" } as const;
    const seed = await encryptPlay({ title: "保留中的房间" }, a, seedContext(roomSeed), browserRandom);
    expect(await call(a, playActions.create, { ...roomSeed, roomId, seed, initialTurn: null })).toMatchObject({ success: true });
    const oldRoom = await files.repo.get(collections.rooms, roomId);
    await files.repo.put(collections.rooms, roomId, { ...oldRoom, expiresAt: Date.now() - playRetention });
    files.close();
    files = openWebRepository(authority);
    await apiFor().prune();
    expect(await call(b, playActions.get, { roomId })).toMatchObject({ success: true, data: { room: { expiresAt: null } } });
    await call(a, playActions.approveCleanup, { roomId, expectedRevision: 0 });
    await call(b, playActions.approveCleanup, { roomId, expectedRevision: 1 });
    const kept = id(), removed = id();
    for (const workId of [kept, removed]) {
      const fields = { id: workId, spaceId, authorId: a.userId, visibility: "private",
        deviceId: a.deviceId, opId: id(), revision: 1 } as const;
      const envelope = await encryptPlay({ note: "合成恢复文字" }, a, workContext(fields, 1), browserRandom);
      expect((await call(a, playActions.saveWork, { workId, visibility: "private", opId: fields.opId, expectedRevision: 0, envelope })).success).toBe(true);
    }
    await run(process.execPath, ["scripts/backup-web.mjs", authority, backup]);
    expect(await call(b, playActions.keepRoom, { roomId, expectedRevision: 2 })).toMatchObject({ success: true });
    await call(a, playActions.deleteWork, { workId: removed, opId: id(), expectedRevision: 1 });
    await files.repo.put("devices", b.deviceId, { userId: b.userId, spaceId, status: "revoked" });
    await files.close();
    await run(process.execPath, ["scripts/recover-web.mjs", backup, authority, candidate]);
    files = openWebRepository(candidate);
    expect(await files.repo.get("encrypted_records", memoryId)).toMatchObject({ revision: 1, visibility: "shared" });
    const restoredRoom = (await call(a, playActions.get, { roomId })).data as RoomPage;
    expect(restoredRoom.room.expiresAt).toBeNull();
    expect(restoredRoom.room.cleanupVotes).toBeUndefined();
    expect(await call(a, playActions.getWork, { workId: removed })).toMatchObject(rejected("WORK_UNAVAILABLE"));
    const work = (await call(a, playActions.getWork, { workId: kept, revision: 1 })).data as WorkHeader;
    expect(decryptPlay(work.envelope, a, workContext(work, 1))).toEqual({ note: "合成恢复文字" });
    expect(await call(b, playActions.list, {})).toMatchObject(rejected("DEVICE_REVOKED"));
  } finally {
    try { files.close(); } catch { /* The authority may already be closed if candidate construction failed. */ }
    for (const filename of await readdir(dir)) await unlink(join(dir, filename));
    await rmdir(dir);
  }
});

it("过期房间照片在最后一份作品删除后随密文、索引一起清理", async () => {
  const files = openWebRepository(":memory:");
  const api = createPlayApi(files.playRepository, flags, Date.now, hashText, (error) => { throw error; });
  const recordId = id(), roomId = id(), fileId = id(), spaceId = id(), deviceId = id();
  const workIds = [id(), id()];
  const storageId = "encrypted/fixture/once.enc";
  try {
    await files.repo.put("spaces", spaceId, { id: spaceId, members: ["a", "b"], status: "active", keyVersion: 1 });
    await files.repo.put("devices", deviceId, { id: deviceId, userId: "a", spaceId, status: "active" });
    await files.repo.put("encrypted_records", recordId, { id: recordId, spaceId, creatorId: "a",
      visibility: "shared", ownerOnly: true, playMediaRoomId: roomId, photoRefs: [fileId] });
    await files.repo.put("encrypted_files", fileId, { spaceId, recordId, storageId });
    await files.filePut(storageId, JSON.stringify({ ciphertext: "synthetic-storage" }));
    for (const workId of workIds) {
      await files.repo.put(collections.works, workId, { id: workId, spaceId, authorId: "a", visibility: "shared", revision: 1 });
      await files.repo.put(collections.workMedia, recordId + ":" + workId, { spaceId, workId });
    }
    for (const [index, workId] of workIds.entries()) {
      await api.prune();
      expect(await files.repo.get("encrypted_files", fileId)).not.toBeNull();
      expect(await api.call({ accountId: "a", deviceId, spaceId }, playActions.deleteWork,
        { workId, opId: id(), expectedRevision: 1 }, () => true)).toMatchObject({ success: true });
      expect(await files.repo.get(collections.workMedia, recordId + ":" + workId)).toBeNull();
      if (index === 0) expect(await files.repo.get(collections.workMedia, recordId + ":" + workIds[1])).not.toBeNull();
    }
    await api.prune();
    expect(await files.repo.get("encrypted_records", recordId)).toBeNull();
    await expect(files.fileGet(storageId)).rejects.toThrow("Encrypted photo missing");
  } finally { files.close(); }
});

it("一千段授权回忆全部保留在树作品中，另一人的私人记录仍不能关联", async () => {
  const files = openWebRepository(":memory:");
  const api = createPlayApi(files.playRepository, "playground,creative_worlds", Date.now, hashText, (error) => { throw error; });
  const spaceId = id(), workId = id(), foreign = id();
  const actor = await newSecrets(browserRandom, "a", spaceId);
  const selected = Array.from({ length: 1000 }, id);
  const roomId = id();
  const call = (action: string, input: Record<string, unknown>) => api.call({
    accountId: actor.userId, deviceId: actor.deviceId, spaceId,
  }, action, input, () => true);
  try {
    await files.repo.transaction(async (tx) => {
      await tx.put("spaces", spaceId, { id: spaceId, members: ["a", "b"], status: "active", keyVersion: 1 });
      await tx.put("devices", actor.deviceId, { id: actor.deviceId, userId: "a", spaceId, status: "active" });
      for (const record of selected) await tx.put("encrypted_records", record, { id: record, spaceId, creatorId: "a", visibility: "shared" });
      await tx.put("encrypted_records", foreign, { id: foreign, spaceId, creatorId: "b", visibility: "private" });
    });
    const fields = { id: workId, spaceId, authorId: actor.userId, visibility: "private",
      deviceId: actor.deviceId, opId: id(), revision: 1 } as const;
    const data = archiveGame({ id: "w24", selected }, "一千片叶子", roomId);
    const envelope = await encryptPlay(data, actor, workContext(fields, 1), browserRandom);
    const request = { workId, expectedRevision: 0, opId: fields.opId, visibility: "private", envelope };
    expect(await call(playActions.saveWork, { ...request, references: [...data.references, { recordId: foreign }] }))
      .toMatchObject(rejected("INVALID_REQUEST"));
    expect(await call(playActions.saveWork, { ...request, references: [...data.references.slice(1), { recordId: foreign }] }))
      .toMatchObject(rejected("REFERENCE_UNAVAILABLE"));
    expect(await call(playActions.saveWork, { ...request, references: data.references })).toMatchObject({ success: true });
    const restored = (await call(playActions.getWork, { workId })).data as WorkHeader;
    expect(decryptPlay(restored.envelope, actor, workContext(restored, 1))).toMatchObject({ references: selected.map((recordId) => ({ recordId })) });
  } finally { files.close(); }
});
