import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { expect, it, vi } from "vitest";

function loadCloudFunction(test: boolean, cloud: object, env: NodeJS.ProcessEnv) {
  const code = buildSync({
    entryPoints: ["src/server/cloud-entry.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["wx-server-sdk"],
    define: { US_SHARED_TEST: String(test) },
  }).outputFiles[0].text;
  const module = { exports: {} as { main: (event: unknown) => Promise<any> } };
  const require = createRequire(import.meta.url);
  runInNewContext(code, {
    module,
    require: (name: string) => name === "wx-server-sdk" ? cloud : require(name),
    process: { env },
    Buffer,
  });
  return module.exports.main;
}

it("同一 OpenID 可绑定两个空间，测试入口拒绝越权及访问正式照片", async () => {
  const tester = "fixture-tester";
  let openId = tester;
  const fingerprint = createHash("sha256").update(tester).digest("hex");
  const rows = new Map<string, any>();
  const collection = vi.fn((name: string) => ({
    doc: (id: string) => ({
      get: async () => ({ data: rows.get(`${name}/${id}`) }),
      set: async ({ data }: { data: unknown }) => rows.set(`${name}/${id}`, data),
    }),
    where: () => ({
      orderBy: () => ({ skip: () => ({ limit: () => ({ get: async () => ({ data: [] }) }) }) }),
    }),
  }));
  const db = { collection, runTransaction: (fn: (tx: { collection: typeof collection }) => unknown) => fn({ collection }) };
  const cloud = {
    init: vi.fn(),
    database: () => db,
    getWXContext: () => ({ OPENID: openId }),
    uploadFile: vi.fn(async ({ cloudPath }: { cloudPath: string }) => ({ fileID: `cloud://fixture/${cloudPath}` })),
    downloadFile: vi.fn(),
    deleteFile: vi.fn(),
  };
  const env: NodeJS.ProcessEnv = {};
  const test = loadCloudFunction(true, cloud, env);
  const production = loadCloudFunction(false, cloud, env);
  expect(await test({ action: "testIdentity" })).toMatchObject({ success: true, data: { fingerprint } });
  expect(await test({ action: "bootstrap" })).toMatchObject({ error: { code: "TEST_ACCESS_DENIED" } });
  expect(collection).not.toHaveBeenCalled();
  env.US_TEST_OPENID_SHA256 = fingerprint;
  openId = "fixture-outsider";
  expect(await test({ action: "createSpace", data: { userId: tester } })).toMatchObject({ error: { code: "TEST_ACCESS_DENIED" } });
  expect(collection).not.toHaveBeenCalled();
  openId = tester;

  const liveSpace = await production({ action: "createSpace" });
  const sandbox = await test({ action: "createSpace", data: { scope: "production" } });
  expect(liveSpace.success).toBe(true);
  expect(sandbox.success).toBe(true);
  expect(liveSpace.data.id).not.toBe(sandbox.data.id);
  expect(await production({ action: "bootstrap" })).toMatchObject({ data: { space: liveSpace.data } });
  expect(await test({ action: "bootstrap" })).toMatchObject({ data: { space: sandbox.data } });
  expect(rows.get(`users/${tester}`).spaceId).toBe(liveSpace.data.id);
  expect(rows.get(`test_users/${tester}`).spaceId).toBe(sandbox.data.id);

  const spaceId = sandbox.data.id;
  const deviceId = "fixture-device";
  rows.set(`test_devices/${deviceId}`, { id: deviceId, spaceId, userId: tester, status: "active" });
  expect(await test({ action: "listDevices", data: { spaceId, deviceId } })).toMatchObject({ success: true });
  expect(collection).toHaveBeenLastCalledWith("test_devices");

  const saved = await test({ action: "filePut", data: {
    spaceId, deviceId, visibility: "shared",
    envelope: { version: 1, algorithm: "XCHACHA20-POLY1305", keyVersion: 1, nonce: "A".repeat(32), ciphertext: "A".repeat(24) },
  } });
  expect(saved.success).toBe(true);
  const fileId = saved.data.id;
  expect(cloud.uploadFile).toHaveBeenCalledWith(expect.objectContaining({ cloudPath: `test/encrypted/${spaceId}/${fileId}.enc` }));
  const row = rows.get(`test_encrypted_files/${fileId}`);
  row.storageId = `cloud://fixture/encrypted/${liveSpace.data.id}/${fileId}.enc`;
  expect(await test({ action: "fileGet", data: { spaceId, deviceId, fileId } })).toMatchObject({ success: false });
  expect(await test({ action: "fileDelete", data: { spaceId, deviceId, fileId } })).toMatchObject({ success: false });
  expect(cloud.downloadFile).not.toHaveBeenCalled();
  expect(cloud.deleteFile).not.toHaveBeenCalled();
});
