import { randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { b64, fingerprint, hashText, newSecrets, publicKeys } from "../src/core/crypto";
import { signWebDevice } from "../src/core/web-device";
import { onThisDay } from "../src/core/companionship";
import { addWardrobeItem, privateWardrobe, publishWardrobe, respondToWardrobe, suggestWardrobe, wardrobeSelection, wardrobeSuggestion } from "../src/core/wardrobe";
import type { SyncPage } from "../src/core/web-sync";
import { markRecordChange, syncRecords } from "../src/server/web-sync";
import { today } from "../src/core/date";
import { UsService } from "../src/core/service";
import { AppError, type CipherRecord, type Envelope, type Transport } from "../src/core/types";
import { App } from "../web/App";
import { CLOSING_GRACE_MS, runMaintenance } from "../src/server/lifecycle";
import { openWebRepository } from "../src/server/web-repository";

async function usableFetchPort() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const probe = createServer((_, response) => response.writeHead(204).end()).listen(0, "127.0.0.1");
    await once(probe, "listening");
    const { port } = probe.address() as { port: number };
    try {
      await fetch(`http://127.0.0.1:${port}`);
      return port;
    } catch (error) {
      // The OS can allocate a port that Fetch refuses before trying to connect.
      if (!(error instanceof Error && error.cause instanceof Error && error.cause.message === "bad port")) throw error;
    } finally {
      await new Promise<void>((done) => probe.close(() => done()));
    }
  }
  throw new Error("Could not allocate a loopback port usable by Fetch");
}

it("网页双账号支持配对、换机、加密照片同步和在线快照恢复", async () => {
  const port = await usableFetchPort();
  const tempRoot = resolve("artifacts");
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, "us-web-test-"));
  const origin = `http://127.0.0.1:${port}`;
  const accounts = { first: randomBytes(20).toString("hex"), second: randomBytes(20).toString("hex") };
  let server: ChildProcess | undefined;
  async function stop() {
    if (server?.exitCode === null && server.signalCode === null) {
      const stopped = once(server, "exit");
      server.kill();
      await stopped;
    }
  }
  async function start(database = "test.sqlite") {
    server = spawn(process.execPath, [join(dir, "server.mjs")], {
      cwd: dir,
      env: { ...process.env, US_WEB_ACCOUNTS: JSON.stringify(accounts), US_WEB_PORT: String(port),
        US_WEB_ORIGIN: origin, US_WEB_DB: join(dir, database) },
    });
    await Promise.race([
      once(server.stdout!, "data"),
      once(server, "exit").then(([code]) => { throw new Error(`Test web server exited with ${code}`); }),
    ]);
  }
  async function post(path: string, data: object, name = "", cookie = "", site = origin) {
    return fetch(origin + path, { method: "POST", headers: {
      Origin: site, "Content-Type": "application/json", Cookie: cookie, "X-Us-Account": name,
    }, body: JSON.stringify(data) });
  }
  async function login(name: keyof typeof accounts) {
    const response = await post("/api/login", { name, password: accounts[name] });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly; SameSite=Strict");
    return cookie.split(";")[0];
  }
  function client(name: keyof typeof accounts, cookie: () => string, fault?: { rejectSetup?: boolean; dropAfter?: string; rejectDevice?: string }, values = new Map<string, string>()) {
    const transport: Transport = {
      webDeviceChallenges: true,
      webRecordSync: true,
      async call<T>(action: string, data: Record<string, unknown> = {}) {
        if (fault?.rejectDevice === action) {
          delete fault.rejectDevice;
          data = { ...data, proof: { ...(data.proof as object), signature: "invalid-test-signature" } };
        }
        const reply = await (await post("/api/space", { action, data }, name, cookie())).json();
        if (!reply.success) throw new AppError(reply.error.code, reply.error.message);
        if (fault?.dropAfter === action) {
          delete fault.dropAfter;
          throw new AppError("NETWORK_ERROR", "合成回执丢失");
        }
        return reply.data as T;
      },
    };
    return new UsService(transport, {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => {
        if (fault?.rejectSetup && key === "webSetupVault") throw new AppError("LOCAL_STORAGE_UNAVAILABLE", "合成存储限制");
        values.set(key, value);
      },
      remove: (key) => { values.delete(key); },
    }, async (size) => randomBytes(size));
  }
  async function authorize(client: UsService, name: keyof typeof accounts, forAction: string) {
    await client.call("authorizeSensitiveAction", { forAction, password: accounts[name] });
  }
  try {
    await mkdir(join(dir, "dist"));
    await writeFile(join(dir, "dist", "index.html"), "<html><head></head><body></body></html>");
    await build({ entryPoints: [resolve("src/server/web-entry.ts")], outfile: join(dir, "server.mjs"),
      bundle: true, platform: "node", format: "esm" });
    await start();
    expect(await (await fetch(origin)).text()).toContain("us-web-hosted");
    for (const pathname of ["/app/home", "/app/album", "/app/play/question", "/app/plans/dates", "/app/settings"]) {
      const response = await fetch(origin + pathname);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("us-web-hosted");
    }
    expect((await fetch(`${origin}/app/unknown`)).status).toBe(404);
    expect((await fetch(`${origin}/api/unknown`)).status).toBe(404);
    expect((await post("/api/login", { name: "stranger", password: accounts.first })).status).toBe(401);
    for (let attempt = 0; attempt < 10; attempt++)
      expect((await post("/api/login", { name: "stranger", password: accounts.first })).status).toBe(attempt < 9 ? 401 : 429);
    expect((await post("/api/space", { action: "bootstrap" })).status).toBe(401);
    let firstCookie = await login("first");
    let secondCookie = await login("second");
    expect((await post("/api/space", { action: "bootstrap" }, "first", secondCookie)).status).toBe(401);
    expect((await post("/api/space", { action: "bootstrap" }, "first", firstCookie, "https://example.test")).status).toBe(403);
    const firstFault: { rejectSetup?: boolean; dropAfter?: string } = { rejectSetup: true };
    const secondFault: { rejectDevice?: string } = {};
    const firstValues = new Map<string, string>();
    const secondValues = new Map<string, string>();
    let first = client("first", () => firstCookie, firstFault, firstValues);
    let second = client("second", () => secondCookie, secondFault, secondValues);
    const firstPass = "first local unlock phrase";
    const secondPass = "second local unlock phrase";
    await expect(second.setUpDevice(secondPass)).rejects.toMatchObject({ code: "MEMBER_REQUIRED" });
    const forbidden = await post("/api/space", { action: "createSpace" }, "second", secondCookie);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    await expect(first.create(firstPass, "合成创建", "2025-10-10")).rejects.toMatchObject({ code: "LOCAL_STORAGE_UNAVAILABLE" });
    expect(await first.transport.call("bootstrap")).toMatchObject({ space: null });
    firstFault.rejectSetup = false;
    firstFault.dropAfter = "createSpace";
    await expect(first.create(firstPass, "合成创建", "2025-10-10")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(first.enrollmentPending).toBe(true);
    expect(JSON.stringify([...firstValues])).not.toContain("合成创建");
    const committedSpace = await first.transport.call<{ space: { id: string } }>("bootstrap");
    first = client("first", () => firstCookie, undefined, firstValues);
    await first.unlock(firstPass);
    expect(first.enrollmentPending).toBe(false);
    expect(first.space!.id).toBe(committedSpace.space.id);
    expect(first.active.filter(({ data }) => data.category === "relationship").map(({ data }) => [data.title, data.date]))
      .toEqual([["合成创建", "2025-10-10"]]);
    expect(first.hasPrivateAccess).toBe(true);
    const { token } = await first.call<{ token: string }>("createInvitation");
    await expect(second.join(secondPass, "invalid")).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
    expect(second.secrets).toBeNull();
    expect(second.space).toBeNull();
    secondFault.rejectDevice = "joinSpace";
    await expect(second.join(secondPass, token)).rejects.toMatchObject({ code: "DEVICE_PROOF_INVALID" });
    expect(second.enrollmentPending).toBe(true);
    expect(JSON.stringify([...secondValues])).not.toContain(token);
    expect(await second.transport.call("bootstrap")).toMatchObject({ space: null });
    second = client("second", () => secondCookie, undefined, secondValues);
    await second.unlock(secondPass);
    expect(second.enrollmentPending).toBe(false);
    expect(second.hasPrivateAccess).toBe(true);
    expect(second.space?.id).toBe(first.space?.id);
    expect(second.space?.members).toEqual([first.userId, second.userId]);
    expect(second.ready).toBe(false);
    const joinedDevice = second.secrets!.deviceId;
    await expect(second.join(secondPass, token)).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
    expect(second.secrets?.deviceId).toBe(joinedDevice);
    const devices = await first.devices();
    const recipient = devices.find((device) => device.id === second.secrets!.deviceId)!;
    await expect(first.transfer(recipient, "INVALID-FINGERPRINT")).rejects.toMatchObject({ code: "FINGERPRINT_MISMATCH" });
    await expect(first.transfer(recipient, fingerprint(recipient))).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    await expect(first.call("authorizeSensitiveAction", { forAction: "putTransfer", password: accounts.second }))
      .rejects.toMatchObject({ code: "INVALID_PASSWORD" });
    await authorize(first, "first", "putTransfer");
    await first.transfer(recipient, fingerprint(recipient));
    await expect(first.transfer(recipient, fingerprint(recipient))).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    await expect(second.receive("INVALID-FINGERPRINT")).rejects.toMatchObject({ code: "KEY_NOT_FOUND" });
    await second.receive(fingerprint(publicKeys(first.secrets!)));
    expect(second.ready).toBe(true);
    const rememberedAccess = second.getUnlockKey()!;
    await second.persistSecrets();
    expect(second.vault?.salt).toBe(rememberedAccess.salt);
    const day = today();
    await first.save({ kind: "mood", title: "有些累", mood: "有些累", date: day });
    await second.save({ kind: "mood", title: "很开心", mood: "很开心", date: day });
    await Promise.all([first.refresh(), second.refresh()]);
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    try {
      const render = (service: UsService, owner: boolean) => renderToStaticMarkup(
        createElement(App, { hosted: { account: owner ? "first" : "second", service, owner, signOut: async () => {} } }),
      );
      const moods = (html: string) =>
        html.match(/class="mood-row"[\s\S]*?(?=<span class="mood-(?:sun|cloud)">)/g);
      const firstView = render(first, true);
      const secondView = render(second, false);
      expect(firstView).toContain('class="avatar small a" aria-label="打开我的空间">臻');
      expect(secondView).toContain('class="avatar small b" aria-label="打开我的空间">悦');
      const firstMood = expect.stringMatching(/avatar a">臻.*有些累/);
      const secondMood = expect.stringMatching(/avatar b">悦.*很开心/);
      expect(moods(firstView)).toEqual([firstMood, secondMood]);
      expect(moods(secondView)).toEqual([secondMood, firstMood]);
    } finally {
      vi.unstubAllGlobals();
    }
    const wardrobePhoto = await first.addPhoto(b64(randomBytes(16)), "image/png", "私人衣物.png", "private");
    await addWardrobeItem(first, "分享用外套", "外套", wardrobePhoto);
    await addWardrobeItem(first, "未授权鞋履", "鞋履");
    const [coat] = privateWardrobe(first).filter(({ data }) => data.category === "外套");
    await publishWardrobe(first, [coat.id], "合成天气", 0);
    await second.refresh();
    const sharedClothes = wardrobeSelection(second, first.userId)!;
    expect(sharedClothes.data.wardrobeSelection?.items.map(({ name }) => name)).toEqual(["分享用外套"]);
    expect(JSON.stringify(sharedClothes)).not.toContain(wardrobePhoto.fileId!);
    expect(second.entries.some(({ data }) => data.kind === "wardrobe-item")).toBe(false);
    await expect(second.readPhoto(wardrobePhoto, "private")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(second.save({ ...sharedClothes.data, title: "非所有者修改" }, "shared", sharedClothes)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(second.trash(sharedClothes)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const edition = sharedClothes.data.wardrobeSelection!.edition;
    await suggestWardrobe(second, first.userId, [sharedClothes.data.wardrobeSelection!.items[0].id], edition, 0);
    await first.refresh();
    const suggestion = wardrobeSuggestion(first, second.userId, first.userId)!;
    await expect(respondToWardrobe(first, edition, suggestion.revision + 1, true)).rejects.toMatchObject({ code: "WARDROBE_CHANGED" });
    await respondToWardrobe(first, edition, suggestion.revision, false);
    await second.refresh();
    expect(wardrobeSelection(second, first.userId)?.data.wardrobeSelection?.response).toEqual({ revision: 1, accepted: false });
    await publishWardrobe(first, [], "", edition);
    await second.refresh();
    expect(wardrobeSelection(second, first.userId)?.data.wardrobeSelection?.items).toEqual([]);
    expect(wardrobeSuggestion(second, second.userId, first.userId)).toBeUndefined();
    await expect(suggestWardrobe(second, first.userId, ["stale"], edition, 1)).rejects.toMatchObject({ code: "WARDROBE_CHANGED" });
    await expect(second.setUpDevice(secondPass)).rejects.toMatchObject({ code: "LOCAL_KEYS_EXIST" });
    const newBrowserCookie = await login("second");
    const newBrowser = client("second", () => newBrowserCookie);
    await newBrowser.bootstrap();
    expect(newBrowser.space?.id).toBe(first.space?.id);
    expect(newBrowser.vault).toBeNull();
    const spaceIdForEnrollment = newBrowser.space!.id;
    await expect(newBrowser.transport.call("getSpace", { spaceId: spaceIdForEnrollment, deviceId: joinedDevice }))
      .rejects.toMatchObject({ code: "DEVICE_UNBOUND" });
    const candidate = await newSecrets(newBrowser.rng, second.userId);
    const device = {
      id: candidate.deviceId, spaceId: spaceIdForEnrollment, label: "联调设备", ...publicKeys(candidate),
    };
    const challenge = () => newBrowser.transport.call<{ nonce: string }>("deviceChallenge", device);
    const { nonce } = await challenge();
    const proof = signWebDevice(device, nonce, candidate.signingSecret, {
      userId: second.userId, key: randomBytes(32).toString("hex"),
    });
    await expect(second.transport.call("registerDevice", { ...device, proof }))
      .rejects.toMatchObject({ code: "DEVICE_CHALLENGE_REQUIRED" });
    await expect(newBrowser.transport.call("registerDevice", { ...device, label: "变更标签", proof }))
      .rejects.toMatchObject({ code: "DEVICE_PROOF_INVALID" });
    await expect(newBrowser.transport.call("registerDevice", { ...device, proof }))
      .rejects.toMatchObject({ code: "DEVICE_CHALLENGE_REQUIRED" });
    const renewal = await challenge();
    const unrelatedRecovery = signWebDevice(device, renewal.nonce, candidate.signingSecret, {
      userId: second.userId, key: randomBytes(32).toString("hex"),
    });
    await expect(newBrowser.transport.call("registerDevice", { ...device, proof: unrelatedRecovery }))
      .rejects.toMatchObject({ code: "PRIVATE_RECOVERY_REQUIRED" });
    await newBrowser.setUpDevice(secondPass);
    expect(newBrowser.secrets?.deviceId).not.toBe(joinedDevice);
    expect(newBrowser.ready).toBe(false);
    newBrowser.lock();
    await newBrowser.unlock(secondPass);
    const newDevice = (await first.devices()).find((device) => device.id === newBrowser.secrets!.deviceId)!;
    await authorize(first, "first", "putTransfer");
    await first.transfer(newDevice, fingerprint(newDevice));
    await newBrowser.receive(fingerprint(publicKeys(first.secrets!)));
    expect(newBrowser.ready).toBe(true);
    expect(newBrowser.hasPrivateAccess).toBe(false);
    const privatePhotoData = b64(randomBytes(35));
    const privatePhoto = await second.addPhoto(privatePhotoData, "image/jpeg", "本人照片", "private");
    const privateRecord = await second.save({ kind: "memory", title: "本人记录", date: day, photos: [privatePhoto] }, "private");
    const { records } = await newBrowser.call<{ records: { id: string }[] }>("listRecords");
    expect(records.some(({ id }) => id === privateRecord.id)).toBe(false);
    await expect(newBrowser.call("fileGet", { fileId: privatePhoto.fileId })).rejects.toMatchObject({ code: "PRIVATE_KEY_REQUIRED" });
    await expect(newBrowser.call("deleteRecord", { recordId: privateRecord.id, expectedRevision: privateRecord.revision })).rejects.toMatchObject({ code: "PRIVATE_KEY_REQUIRED" });
    await expect(newBrowser.save({ kind: "memory", title: "不能另建私钥记录", date: day }, "private")).rejects.toMatchObject({ code: "PRIVATE_KEY_REQUIRED" });
    await expect(newBrowser.createBackup(secondPass)).rejects.toMatchObject({ code: "PRIVATE_KEY_REQUIRED" });
    const sharedOnlyDevice = newBrowser.secrets!.deviceId;
    const oldBrowserCookie = await login("second");
    const oldBrowser = client("second", () => oldBrowserCookie);
    oldBrowser.storage.set("vault", JSON.stringify(newBrowser.vault));
    await oldBrowser.unlock(secondPass);
    const privateBackup = await second.createBackup(secondPass);
    await newBrowser.saveDraft({ text: "恢复前的本机共同草稿" });
    await newBrowser.recover(privateBackup.vault, privateBackup.recoveryKey, "restored browser unlock phrase");
    expect(newBrowser.secrets!.deviceId).not.toBe(sharedOnlyDevice);
    expect(newBrowser.hasPrivateAccess).toBe(true);
    expect(newBrowser.loadDraft()).toEqual({ text: "恢复前的本机共同草稿" });
    expect(newBrowser.entries.some(({ id }) => id === privateRecord.id)).toBe(true);
    expect(await newBrowser.readPhoto(privatePhoto, "private")).toBe(privatePhotoData);
    const secondNickname = "同步昵称二号";
    await second.saveDisplayName(secondNickname);
    await first.refresh();
    expect(first.displayNames.get(second.userId)).toBe(secondNickname);
    expect(first.displayNames.get(first.userId)).toBeUndefined();
    const photoData = b64(randomBytes(500 * 1024));
    const photo = await first.addPhoto(photoData, "image/jpeg", "测试照片", "shared");
    const shared = await first.save({ kind: "memory", title: "共享记录", date: "2025-10-10", photos: [photo] }, "shared");
    const full = await second.call<{ envelope: Envelope }>("fileGet", { fileId: photo.fileId });
    expect(full.envelope.encoding).toBe("bytes");
    const firstPart = await second.call<{ parts: number; envelope: Envelope }>("fileGet", { fileId: photo.fileId, part: 0 });
    expect(firstPart.parts).toBeGreaterThan(1);
    let ciphertext = firstPart.envelope.ciphertext;
    for (let part = 1; part < firstPart.parts; part++) {
      const response = await second.call<typeof firstPart>("fileGet", { fileId: photo.fileId, part });
      expect(response).toMatchObject({ parts: firstPart.parts, envelope: { encoding: "bytes", nonce: full.envelope.nonce } });
      ciphertext += response.envelope.ciphertext;
    }
    expect(ciphertext).toBe(full.envelope.ciphertext);
    const page = await second.call<{ records: CipherRecord[]; nextAfter: string | null }>("listRecords", { after: "" });
    expect(page.nextAfter).toBeNull();
    expect(page.records.some(({ id }) => id === shared.id)).toBe(true);
    const snapshot = await second.call<SyncPage>("syncRecords");
    const idle = await second.call<SyncPage>("syncRecords", { cursor: snapshot.cursor });
    expect(idle).toMatchObject({ records: [], removed: [], more: false });
    await expect(first.call("syncRecords", { cursor: idle.cursor })).rejects.toMatchObject({ code: "SYNC_RESET" });
    await expect(newBrowser.call("syncRecords", { cursor: idle.cursor })).rejects.toMatchObject({ code: "SYNC_RESET" });
    const hidden = await first.save({ kind: "memory", title: "不可见的变更", date: day }, "private");
    const visible = await first.save({ kind: "memory", title: "可见的变更", date: day }, "shared");
    const changes = await second.call<SyncPage>("syncRecords", { cursor: idle.cursor });
    expect(changes.records.map(({ id }) => id)).toEqual([visible.id]);
    expect(changes.records.some(({ id }) => id === hidden.id)).toBe(false);
    await first.trash(visible);
    await first.purge(first.entries.find(({ id }) => id === visible.id)!);
    const removed = await second.call<SyncPage>("syncRecords", { cursor: changes.cursor });
    expect(removed).toMatchObject({ records: [], removed: [visible.id], more: false });
    expect(onThisDay(first.entries, "2026-10-10").map(({ id }) => id)).toEqual([shared.id]);
    await Promise.all([first.sendThought(day), first.sendThought(day)]);
    await second.refresh();
    const received = second.active.filter((entry) => entry.data.kind === "thought" && entry.creatorId === first.userId);
    expect(received).toHaveLength(1);
    await expect(second.withdrawThought(received[0].id)).rejects.toMatchObject({ code: "THOUGHT_UNAVAILABLE" });
    await second.sendThought(day, received[0].id);
    await first.refresh();
    expect(first.active.some((entry) => entry.data.targetId === received[0].id && entry.creatorId === second.userId)).toBe(true);
    await first.withdrawThought(received[0].id);
    await second.refresh();
    expect(second.active.some((entry) => entry.id === received[0].id)).toBe(false);
    const savedReceiptRequest = {
      operationId: "synthetic-trash-operation", recordId: shared.id, expectedRevision: shared.revision,
    };
    const trashed = await first.call<{ revision: number }>("deleteRecord", savedReceiptRequest);
    expect(await first.call("deleteRecord", savedReceiptRequest)).toMatchObject({ revision: trashed.revision });
    await expect(first.call("restoreRecord", { ...savedReceiptRequest, expectedRevision: trashed.revision }))
      .rejects.toMatchObject({ code: "OPERATION_REUSED" });
    expect(await second.call("mutationStatus", { operationId: savedReceiptRequest.operationId })).toBeNull();
    const result = await first.call<{ result: object }>("mutationStatus", { operationId: savedReceiptRequest.operationId });
    expect(result.result).not.toHaveProperty("envelope");
    await first.call("restoreRecord", { recordId: shared.id, expectedRevision: trashed.revision });
    await first.refresh();
    const secret = "This plaintext must not be in the database";
    await first.save({ kind: "memory", title: secret, date: "2025-10-10" }, "private");
    await second.refresh();
    expect(second.entries.find((entry) => entry.id === shared.id)?.data.title).toBe("共享记录");
    expect(second.entries.some((entry) => entry.data.title === secret)).toBe(false);
    expect(await second.readPhoto(photo, "shared")).toBe(photoData);
    await newBrowser.refresh();
    expect(newBrowser.entries.some((entry) => entry.id === shared.id)).toBe(true);
    const removedPhoto = await first.addPhoto(b64(randomBytes(64)), "image/png", "待删除.png", "private");
    const removeLater = await first.save({ kind: "memory", title: "删除后不能恢复", date: day, photos: [removedPhoto] }, "private");
    const trashLater = await first.save({ kind: "memory", title: "恢复后仍要在回收站", date: day }, "private");
    const beforeBackup = await first.call<{ records: CipherRecord[] }>("listRecords");
    const oldRecord = beforeBackup.records.find(({ id }) => id === removeLater.id)!;
    const backup = () => promisify(execFile)(process.execPath, [resolve("scripts/backup-web.mjs"), join(dir, "test.sqlite"), join(dir, "snapshot.sqlite")]);
    await backup();
    await expect(backup()).rejects.toMatchObject({ stderr: expect.stringContaining("目标文件已存在") });
    await authorize(second, "second", "revokeDevice");
    await expect(second.closeSpace()).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    await second.call("revokeDevice", { targetDeviceId: sharedOnlyDevice });
    await expect(oldBrowser.call("getSpace")).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
    await first.trash(removeLater);
    await first.purge(first.entries.find(({ id }) => id === removeLater.id)!);
    await first.trash(trashLater);
    await stop();
    expect((await readFile(join(dir, "snapshot.sqlite"))).includes(Buffer.from(secret))).toBe(false);
    expect((await readFile(join(dir, "snapshot.sqlite"))).includes(Buffer.from(secondNickname))).toBe(false);
    const recover = (snapshot: string, reference: string, output: string) => promisify(execFile)(process.execPath, [
      resolve("scripts/recover-web.mjs"), join(dir, snapshot), join(dir, reference), join(dir, output),
    ]);
    await expect(recover("test.sqlite", "snapshot.sqlite", "rejected.sqlite"))
      .rejects.toMatchObject({ stderr: expect.stringContaining("版本序号不早于快照") });
    const recovered = await recover("snapshot.sqlite", "test.sqlite", "restored.sqlite");
    expect(JSON.parse(recovered.stdout)).toMatchObject({ revokedDevices: 1, removedRecords: 1, removedPhotos: 1, updatedTrash: 1 });
    await start("restored.sqlite");
    expect((await post("/api/space", { action: "bootstrap" }, "second", secondCookie)).status).toBe(401);
    firstCookie = await login("first");
    secondCookie = await login("second");
    await first.registerDevice();
    second.lock();
    expect(second.getUnlockKey()).toBeNull();
    const reloaded = new UsService(second.transport, second.storage, second.rng);
    try {
      await reloaded.unlockWithKey(rememberedAccess);
    } finally {
      rememberedAccess.key.fill(0);
    }
    expect(reloaded.entries.some((entry) => entry.id === shared.id)).toBe(true);
    expect(reloaded.displayNames.get(reloaded.userId)).toBe(secondNickname);
    expect(await reloaded.readPhoto(photo, "shared")).toBe(photoData);
    expect(await reloaded.readPhoto(privatePhoto, "private")).toBe(privatePhotoData);
    expect(reloaded.active.some((entry) => entry.data.title === secret)).toBe(false);
    await first.refresh();
    expect(first.active.some((entry) => entry.data.title === secret)).toBe(true);
    expect(first.active.some((entry) => entry.id === privateRecord.id)).toBe(false);
    expect(first.entries.some((entry) => entry.id === removeLater.id)).toBe(false);
    expect(first.entries.find((entry) => entry.id === trashLater.id)?.deletedAt).toBeTruthy();
    await expect(first.readPhoto(removedPhoto, "private")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(first.call("putRecord", { record: oldRecord, expectedRevision: 0, operationId: "retired-operation" }))
      .rejects.toMatchObject({ code: "RECORD_PURGED" });
    expect(await first.readPhoto(photo, "shared")).toBe(photoData);
    await expect(reloaded.transport.call("getSpace", { spaceId: reloaded.space!.id, deviceId: sharedOnlyDevice })).rejects.toMatchObject({ code: "DEVICE_UNBOUND" });
    await expect(reloaded.createBackup("wrong unlock phrase")).rejects.toMatchObject({ code: "WRONG_PASSWORD" });
    const spaceId = first.space!.id;
    await authorize(first, "first", "closeSpace");
    await first.closeSpace();
    await authorize(reloaded, "second", "closeSpace");
    await reloaded.closeSpace();
    await expect(reloaded.save({ kind: "memory", title: "关闭后不能写入", date: day })).rejects.toMatchObject({ code: "SPACE_CLOSING" });
    await post("/api/logout", {}, "second", secondCookie);
    expect((await post("/api/space", { action: "bootstrap" }, "second", secondCookie)).status).toBe(401);
    await stop();
    const referenceStore = openWebRepository(join(dir, "restored.sqlite"));
    try {
      const cleanup = await runMaintenance({ ...referenceStore, now: () => Date.now() + CLOSING_GRACE_MS + 1000,
        hash: hashText, id: () => randomBytes(16).toString("hex"), recordReceipts: true, managedPhotos: true,
        webDeviceChallenges: true });
      expect(cleanup.completedSpaces).toBe(1);
    } finally { referenceStore.close(); }
    const closed = await recover("snapshot.sqlite", "restored.sqlite", "closed.sqlite");
    expect(JSON.parse(closed.stdout)).toMatchObject({ closedSpaces: 1 });
    const closedStore = openWebRepository(join(dir, "closed.sqlite"));
    try {
      expect(await closedStore.repo.get("spaces", spaceId)).toMatchObject({ status: "closed", members: [] });
      for (const collection of ["encrypted_records", "encrypted_files", "devices", "record_receipts", "record_tombstones", "web_profiles", "web_recovery_keys", "web_record_streams", "web_record_changes"])
        expect(await closedStore.repo.list(collection, { spaceId }, 0, 1)).toEqual([]);
      await expect(closedStore.fileGet(`encrypted/${spaceId}/${photo.fileId}.enc`)).rejects.toThrow("Encrypted photo missing");
    } finally { closedStore.close(); }
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("Web 记录按可见范围分页，并用稳定标识继续下一页", async () => {
  const db = openWebRepository(":memory:");
  const orderedIds = Array.from({ length: 120 }, (_, index) => String(index).padStart(3, "0"));
  try {
    await db.repo.transaction(async (tx) => {
      for (const suffix of orderedIds) {
        for (const visibility of ["private", "shared"]) {
          const id = `${visibility}-${suffix}`;
          await tx.put("encrypted_records", id, { id, spaceId: "test-space", creatorId: "other", visibility });
        }
      }
      await tx.put("encrypted_records", "own", {
        id: "own", spaceId: "test-space", creatorId: "me", visibility: "private",
      });
    });
    const first = await db.listVisibleRecords("test-space", "me", "", 0);
    expect(first.map(({ id }) => id)).toEqual(["own", ...orderedIds.slice(0, 100).map((suffix) => `shared-${suffix}`)]);
    await db.repo.put("encrypted_records", "early", {
      id: "early", spaceId: "test-space", creatorId: "other", visibility: "shared",
    });
    const second = await db.listVisibleRecords("test-space", "me", first[99].id, 0);
    expect(second.map(({ id }) => id)).toEqual(orderedIds.slice(99).map((suffix) => `shared-${suffix}`));
    const sharedOnly = await db.listVisibleRecords("test-space", null, "", 0);
    expect(sharedOnly.every(({ visibility }) => visibility === "shared")).toBe(true);
  } finally {
    db.close();
  }
});

it("增量游标补上翻页期间插入的早序记录，并在到期后要求重建", async () => {
  const db = openWebRepository(":memory:");
  const device = {
    id: "test-device", spaceId: "test-space", userId: "me", label: "测试设备",
    encryptionPublicKey: "", signingPublicKey: "", status: "active" as const, createdAt: 1,
  };
  const now = Date.now();
  const fetchPage = (token?: string, at = now) =>
    db.webSync.read((tx) => syncRecords(tx, db.webSync, device, token, at));
  try {
    await db.repo.transaction(async (tx) => {
      for (let index = 0; index < 120; index++) {
        const id = `shared-${String(index).padStart(3, "0")}`;
        await tx.put("encrypted_records", id, { id, spaceId: device.spaceId, creatorId: "me", visibility: "shared" });
      }
    });
    const first = await fetchPage();
    expect(first.records).toHaveLength(100);
    const added = { id: "a-inserted", spaceId: device.spaceId, creatorId: device.userId, visibility: "shared" as const };
    await db.repo.transaction(async (tx) => {
      await tx.put("encrypted_records", added.id, added);
      await markRecordChange(tx, device.spaceId, device.userId, added);
    });
    const second = await fetchPage(first.cursor);
    expect(second.records).toHaveLength(20);
    const caughtUp = await fetchPage(second.cursor);
    expect(caughtUp).toMatchObject({ records: [added], removed: [], more: false });
    await expect(fetchPage(caughtUp.cursor, now + 7 * 86400000)).rejects.toMatchObject({ code: "SYNC_RESET" });
  } finally {
    db.close();
  }
});
