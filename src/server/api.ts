import {
  AppError,
  type CipherRecord,
  type Device,
  type Envelope,
  type RecordMeta,
  type Space,
  type ApiReply,
} from "../core/types";
import { API_PROTOCOL, APP_VERSION, RECORD_RECEIPT_TTL_MS } from "../core/protocol";
import { base64ByteLength, MAX_PHOTO_BYTES, MAX_PHOTO_CIPHERTEXT, PHOTO_DOWNLOAD_PART_SIZE, PHOTO_UPLOAD_PART_SIZE } from "../core/photos";
import { verifyWebDeviceSignature, webRecoveryKeys, type WebDevice, type WebDeviceProof } from "../core/web-device";
import { webProfiles, type WebProfile } from "../core/web-profile";
import { markRecordChange, syncRecords, type WebSync } from "./web-sync";
import { photoFileId } from "../core/photo-write";
import {
  AI_TASKS,
  AI_TEXT_LIMIT,
  AI_SPACE_DAILY_LIMIT,
  AI_GLOBAL_DAILY_LIMIT,
} from "../core/ai";
import {
  availableBinding,
  readableSpace,
  CLOSING_GRACE_MS,
  TRANSFER_TTL_MS,
  RECORD_RECEIPTS,
  RECORD_TOMBSTONES,
  PHOTO_DRAFT_TTL_MS,
} from "./lifecycle";
export interface Tx {
  get(collection: string, id: string): Promise<any>;
  put(collection: string, id: string, value: any): Promise<void>;
  remove(collection: string, id: string): Promise<void>;
  putPhoto?(path: string, data: string): Promise<string>;
  deletePhoto?(path: string): Promise<void>;
}
export interface Repository extends Tx {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  list(
    collection: string,
    where: Record<string, unknown>,
    offset: number,
    limit: number,
  ): Promise<any[]>;
}
export interface ServerDeps {
  onInternalError?: (error: unknown) => void;
  repo: Repository;
  now: () => number;
  id: () => string;
  hash: (s: string) => string;
  ai?: (text: string, task: string) => Promise<string>;
  filePut?: (path: string, bytes: string) => Promise<string>;
  fileGet?: (fileId: string) => Promise<string>;
  fileGetPart?: (fileId: string, part: number) => Promise<{ envelope: Envelope; parts: number } | undefined>;
  fileDelete?: (fileId: string) => Promise<void>;
  checkPhotoCapacity?: () => Promise<void>;
  runtime?: { mode: "cloud" | "local"; sdkVersion?: string };
  aiLimits?: { spaceDaily: number; globalDaily: number };
  recordReceipts?: boolean;
  managedPhotos?: boolean;
  webDeviceChallenges?: boolean;
  listVisibleRecords?: (
    spaceId: string, privateOwner: string | null, after: string, offset: number,
  ) => Promise<CipherRecord[]>;
  webSync?: WebSync;
  playCollections?: readonly string[];
  playMediaEnabled?: boolean;
}
type RecordChange = RecordMeta | { id: string; visibility: RecordMeta["visibility"]; deleted: true; deletedFileIds?: string[] };
type RecordReceipt = { action: string; digest: string; result: RecordChange; expiresAt: number };
interface StoredPhoto {
  id: string;
  spaceId: string;
  creatorId: string;
  visibility: RecordMeta["visibility"];
  storageId: string;
  managed?: true;
  recordId?: string | null;
  attachUntil?: number;
}
function ensure(ok: unknown, code: string, msg: string): asserts ok {
  if (!ok) throw new AppError(code, msg);
}
function str(v: unknown, max = 200): string {
  ensure(
    typeof v === "string" && v.length > 0 && v.length <= max,
    "INVALID_REQUEST",
    "请求字段格式不正确",
  );
  return v;
}
function id(v: unknown): string {
  const s = str(v, 80);
  ensure(/^[a-zA-Z0-9_-]+$/.test(s), "INVALID_REQUEST", "无效资源 ID");
  ensure(
    !["__proto__", "constructor", "prototype"].includes(s),
    "INVALID_REQUEST",
    "无效资源 ID",
  );
  return s;
}
export function validateEnvelope(v: any, photoBytes = false): Envelope {
  ensure(
    v &&
      v.version === 1 &&
      v.algorithm === "XCHACHA20-POLY1305" &&
      (v.encoding === undefined || (photoBytes && v.encoding === "bytes")) &&
      Number.isSafeInteger(v.keyVersion) &&
      v.keyVersion > 0,
    "INVALID_ENVELOPE",
    "无效密文格式",
  );
  const nonce = str(v.nonce, 32);
  const ciphertext = str(v.ciphertext, 1500000);
  ensure(
    /^[A-Za-z0-9+/]{32}$/.test(nonce) &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext) &&
      ciphertext.length >= 24,
    "INVALID_ENVELOPE",
    "密文编码不正确",
  );
  ensure(ciphertext.length % 4 === 0, "INVALID_ENVELOPE", "密文编码长度不正确");
  if (v.encoding === "bytes")
    ensure(base64ByteLength(ciphertext) <= MAX_PHOTO_BYTES + 16, "FILE_TOO_LARGE", "照片超过 500 KB");
  return {
    version: 1,
    algorithm: "XCHACHA20-POLY1305",
    keyVersion: v.keyVersion,
    nonce,
    ciphertext,
    ...(v.encoding === "bytes" ? { encoding: "bytes" } : {}),
  };
}
async function member(
  tx: Tx,
  spaceId: string,
  userId: string,
  readOnly = false,
  at = Date.now(),
): Promise<Space> {
  const s = await tx.get("spaces", id(spaceId));
  ensure(
    s &&
      (readOnly ? readableSpace(s, at) : s.status === "active") &&
      s.members.includes(userId),
    "MEMBER_REQUIRED",
    "当前账号不能访问这个空间",
  );
  return s;
}
export async function authorizedDevice(
  tx: Tx,
  deviceId: unknown,
  userId: string,
  spaceId: string,
): Promise<Device> {
  const d: Device | null = await tx.get("devices", id(deviceId));
  ensure(
    d && d.userId === userId && d.spaceId === spaceId && d.status === "active",
    "DEVICE_REVOKED",
    "设备未授权或已移除",
  );
  return d;
}
function requireDeviceVisibility(device: Device, visibility: unknown) {
  ensure(!device.sharedOnly || visibility !== "private",
    "PRIVATE_KEY_REQUIRED", "此设备仅用于共同空间，请从加密备份恢复私人记录");
}
export function createApi(deps: ServerDeps) {
  const { repo, now, hash } = deps;
  async function verifyWebEnrollment(
    tx: Tx, userId: string, device: WebDevice, previous: Device | null, proof: WebDeviceProof | undefined,
  ) {
    ensure(
      proof && verifyWebDeviceSignature(device, proof, device.signingPublicKey, proof.signature),
      "DEVICE_PROOF_INVALID", "设备签名未通过，请重新解锁",
    );
    if (device.sharedOnly || previous?.sharedOnly) return;
    const keyId = hash(JSON.stringify([device.spaceId, userId]));
    const pinned = await tx.get(webRecoveryKeys, keyId);
    if (previous && pinned) return;
    const validRecovery = typeof proof.recoveryPublicKey === "string" &&
      verifyWebDeviceSignature(device, proof, proof.recoveryPublicKey, proof.recoverySignature);
    if (previous && !validRecovery) return; // An existing full legacy device may still unlock.
    const user = await tx.get("users", userId);
    if (pinned) {
      ensure(validRecovery && pinned.publicKey === proof.recoveryPublicKey,
        "PRIVATE_RECOVERY_REQUIRED", "请使用该账号已有的个人恢复包");
      return;
    }
    const source = typeof proof.sourceId === "string" ? await tx.get("devices", id(proof.sourceId)) : null;
    const legacyRecovery = source?.spaceId === device.spaceId && source?.userId === userId &&
      source?.status === "active" && !source?.sharedOnly &&
      verifyWebDeviceSignature(device, proof, source.signingPublicKey, proof.sourceSignature);
    ensure(validRecovery && (previous || user?.webInitialDevicePending === device.spaceId || legacyRecovery),
      "PRIVATE_RECOVERY_REQUIRED", "请使用该账号已有的个人恢复包，或先在原设备解锁");
    await tx.put(webRecoveryKeys, keyId, { id: keyId, spaceId: device.spaceId, publicKey: proof.recoveryPublicKey });
    if (user?.webInitialDevicePending === device.spaceId)
      await tx.put("users", userId, { ...user, webInitialDevicePending: null });
  }
  async function storeDevice(tx: Tx, userId: string, input: Record<string, unknown>) {
    const spaceId = id(input.spaceId);
    const deviceId = id(input.id);
    const previous: Device | null = await tx.get("devices", deviceId);
    ensure(!previous || (previous.userId === userId && previous.status === "active" && previous.spaceId === spaceId),
      "DEVICE_REVOKED", "设备标识已被撤销或占用");
    const encryptionPublicKey = str(input.encryptionPublicKey, 44);
    const signingPublicKey = str(input.signingPublicKey, 44);
    ensure(/^[A-Za-z0-9+/]{43}=$/.test(encryptionPublicKey) && /^[A-Za-z0-9+/]{43}=$/.test(signingPublicKey),
      "INVALID_KEY", "公钥格式不正确");
    ensure(!previous || (previous.encryptionPublicKey === encryptionPublicKey && previous.signingPublicKey === signingPublicKey),
      "KEY_CHANGED", "禁止替换已有设备公钥");
    const sharedOnly = previous ? previous.sharedOnly : input.sharedOnly === true;
    const registration: WebDevice = { spaceId, id: deviceId, encryptionPublicKey, signingPublicKey,
      label: str(input.label, 50), ...(sharedOnly ? { sharedOnly: true } : {}) };
    if (deps.webDeviceChallenges)
      await verifyWebEnrollment(tx, userId, registration, previous, input.proof as WebDeviceProof | undefined);
    const device: Device = { ...registration, userId, status: "active", createdAt: previous?.createdAt || now() };
    await tx.put("devices", deviceId, device);
    return device;
  }
  async function invitationSpace(tx: Pick<Tx, "get">, tokenHash: string, userId: string) {
    const invitation = await tx.get("invitations", tokenHash);
    ensure(invitation && !invitation.usedBy && invitation.expiresAt > now(),
      "INVITE_EXPIRED", "邀请已过期或已经使用");
    const space = await tx.get("spaces", invitation.spaceId) as Space | null;
    ensure(space?.status === "active" && !space.members.includes(userId), "INVALID_INVITE", "此邀请不可使用");
    ensure(space.members.length < 2, "SPACE_FULL", "这个空间已经住了两个人");
    return { invitation, space };
  }
  async function completedEnrollment(tx: Tx, userId: string, input: Record<string, unknown>) {
    const user = await tx.get("users", userId);
    if (user?.spaceId !== input.spaceId || user?.webEnrollmentDevice !== input.id) return;
    const space = await member(tx, id(input.spaceId), userId, false, now());
    await storeDevice(tx, userId, input);
    return space;
  }
  async function bindInitialDevice(tx: Tx, userId: string, input: Record<string, unknown>) {
    ensure(input.sharedOnly !== true && input.proof, "DEVICE_PROOF_INVALID", "首次登记需要完整的设备与恢复签名");
    const device = await storeDevice(tx, userId, input);
    ensure(!device.sharedOnly, "DEVICE_PROOF_INVALID", "首次登记需要完整的个人密钥");
    const user = await tx.get("users", userId);
    await tx.put("users", userId, { ...user, webEnrollmentDevice: device.id });
  }
  function receiptId(spaceId: string, userId: string, operationId: unknown) {
    return hash(JSON.stringify([spaceId, userId, id(operationId)]));
  }
  function changeRecord(
    spaceId: string, userId: string, deviceId: unknown, action: string,
    operationId: unknown, payload: unknown,
    apply: (tx: Tx, space: Space, device: Device) => Promise<RecordChange | CipherRecord>,
  ) {
    const key = deps.recordReceipts && operationId !== undefined ? receiptId(spaceId, userId, operationId) : null;
    const digest = key ? hash(JSON.stringify([action, payload])) : "";
    return repo.transaction(async (tx) => {
      const space = await member(tx, spaceId, userId);
      const device = await authorizedDevice(tx, deviceId, userId, spaceId);
      if (key) {
        const previous: RecordReceipt | null = await tx.get(RECORD_RECEIPTS, key);
        if (previous) {
          requireDeviceVisibility(device, previous.result.visibility);
          ensure(previous.digest === digest, "OPERATION_REUSED", "该保存编号已有其它用途，请刷新后核对");
          return previous.result;
        }
      }
      const changed = await apply(tx, space, device);
      if (deps.webSync) await markRecordChange(tx, spaceId, userId, changed);
      if (key) {
        const { envelope: _ciphertext, photoRefs: _refs, ...metadata } = changed as CipherRecord;
        await tx.put(RECORD_RECEIPTS, key, {
          id: key, spaceId, action, digest, result: metadata, expiresAt: now() + RECORD_RECEIPT_TTL_MS,
        });
      }
      return changed;
    });
  }
  function photoReceipt(value: unknown) {
    const receipt = str(value, 64);
    ensure(/^[a-f0-9]{64}$/.test(receipt), "INVALID_REQUEST", "照片回执格式不正确");
    return receipt;
  }
  function photoStageId(spaceId: string, userId: string, deviceId: string, receipt: string) {
    return "photo-stage-" + hash(JSON.stringify([spaceId, userId, deviceId, receipt])).slice(0, 32);
  }
  async function storePhoto(
    spaceId: string, userId: string, visibility: unknown, envelope: Envelope, receipt?: string,
    managed?: { deviceId: unknown; ownerTrack: boolean },
  ) {
    ensure(visibility === "shared" || visibility === "private", "INVALID_REQUEST", "可见范围不正确");
    if (receipt !== undefined)
      ensure(
        receipt === hash(JSON.stringify([visibility, envelope])),
        "INVALID_REQUEST",
        "照片回执与密文不匹配",
      );
    ensure(deps.filePut, "NOT_CONFIGURED", "文件服务尚未配置");
    const fileId = receipt === undefined ? deps.id() : photoFileId(spaceId, userId, receipt, hash);
    const path = `encrypted/${spaceId}/${fileId}.enc`;
    const bytes = JSON.stringify(envelope);
    if (managed) {
      await repo.transaction(async (tx) => {
        await member(tx, spaceId, userId);
        const device = await authorizedDevice(tx, managed.deviceId, userId, spaceId);
        requireDeviceVisibility(device, visibility);
        if (receipt && (await tx.get("encrypted_files", fileId))?.storageId) return;
        await deps.checkPhotoCapacity?.();
        ensure(tx.putPhoto, "NOT_CONFIGURED", "照片事务存储未配置");
        const storageId = await tx.putPhoto(path, bytes);
        await tx.put("encrypted_files", fileId, {
          id: fileId, spaceId, creatorId: userId, visibility, storageId,
          ...(managed.ownerTrack ? { managed: true, attachUntil: now() + PHOTO_DRAFT_TTL_MS } : {}),
        });
      });
    } else {
      await deps.checkPhotoCapacity?.();
      const storageId = await deps.filePut(path, bytes);
      await repo.put("encrypted_files", fileId, { id: fileId, spaceId, creatorId: userId, visibility, storageId });
    }
    return { id: fileId };
  }
  function photoReferences(input: unknown): string[] | undefined {
    if (!deps.managedPhotos || input === undefined) return undefined;
    ensure(Array.isArray(input) && input.length <= 6, "INVALID_REQUEST", "照片引用必须为最多六个文件");
    const references = input.map(id);
    ensure(new Set(references).size === references.length, "INVALID_REQUEST", "照片引用重复");
    return references;
  }
  async function replacePhotoReferences(tx: Tx, previous: CipherRecord | null, record: CipherRecord, userId: string) {
    for (const fileId of record.photoRefs ?? []) {
      const file: StoredPhoto | null = await tx.get("encrypted_files", fileId);
      ensure(file?.storageId && file.spaceId === record.spaceId && file.visibility === record.visibility &&
        (file.visibility === "shared" || file.creatorId === userId), "PHOTO_UNAVAILABLE", "有照片已失效或不可访问，请移除后重新添加");
      if (!file.managed || file.recordId === record.id) continue;
      ensure(!file.recordId && file.creatorId === userId && (file.attachUntil ?? 0) > now(),
        "PHOTO_UNAVAILABLE", "有照片已过期或已归入另一条记录，请重新添加");
      await tx.put("encrypted_files", fileId, { ...file, recordId: record.id, attachUntil: null });
    }
    for (const fileId of previous?.photoRefs ?? []) {
      if (record.photoRefs?.includes(fileId)) continue;
      const file: StoredPhoto | null = await tx.get("encrypted_files", fileId);
      if (file?.managed && file.recordId === record.id)
        await tx.put("encrypted_files", fileId, { ...file, recordId: null, attachUntil: now() + PHOTO_DRAFT_TTL_MS });
    }
  }
  return async function handle(
    userId: string,
    action: string,
    input: any = {},
  ): Promise<ApiReply> {
    try {
      ensure(userId, "AUTH_REQUIRED", deps.webDeviceChallenges ? "请先登录网站" : "请先使用微信登录");
      ensure(
        input && typeof input === "object" && !Array.isArray(input),
        "INVALID_REQUEST",
        "请求数据必须为对象",
      );
      ensure(
        typeof action === "string" && action.length > 0 && action.length <= 64,
        "INVALID_REQUEST",
        "接口名称不正确",
      );
      let result: any;
      if (
        ["closeSpace", "cancelClose", "aiGenerate", "ackTransfer"].includes(
          action,
        )
      )
        ensure(
          input.apiProtocol === API_PROTOCOL,
          "PROTOCOL_MISMATCH",
          deps.webDeviceChallenges ? "请刷新网站以加载最新版本，再执行此操作" : "请同时更新小程序与云函数，再执行此操作",
        );
      if (action === "health") {
        result = {
          appVersion: APP_VERSION,
          protocol: API_PROTOCOL,
          mode: deps.runtime?.mode || "test",
          serverTime: now(),
          aiConfigured: !!deps.ai,
          sdkVersion: deps.runtime?.sdkVersion || null,
          sdkPrerelease: /-/.test(deps.runtime?.sdkVersion || ""),
        };
      } else if (action === "bootstrap") {
        result = await repo.transaction(async (tx) => {
          const u = await tx.get("users", userId);
          const bound = u?.spaceId ? await tx.get("spaces", u.spaceId) : null;
          if (bound?.status === "active") return {
            userId, space: bound,
            ...(deps.webDeviceChallenges ? { atomicEnrollment: true, initialDevicePending: u.webInitialDevicePending === bound.id } : {}),
          };
          if (u?.spaceId)
            await tx.put("users", userId, {
              ...u,
              spaceId: null,
              closingSpaceId: bound?.id || u.closingSpaceId || null,
            });
          const closing =
            bound ||
            (u?.closingSpaceId
              ? await tx.get("spaces", u.closingSpaceId)
              : null);
          return {
            userId,
            space: readableSpace(closing, now()) ? closing : null,
            ...(deps.webDeviceChallenges ? { atomicEnrollment: true } : {}),
          };
        });
      } else if (action === "inspectInvitation" && deps.webDeviceChallenges) {
        const { space } = await invitationSpace(repo, hash(str(input.token, 128)), userId);
        result = { spaceId: space.id };
      } else if (action === "createSpace") {
        result = await repo.transaction(async (tx) => {
          const enrolling = deps.webDeviceChallenges && input.initialDevice === true;
          const completed = enrolling && await completedEnrollment(tx, userId, input);
          if (completed) return completed;
          const u = await availableBinding(tx, userId);
          const spaceId = enrolling ? id(input.spaceId) : deps.id();
          ensure(!enrolling || !await tx.get("spaces", spaceId), "SPACE_ID_IN_USE", "空间编号已被使用");
          const s: Space = {
            id: spaceId,
            members: [userId],
            status: "active",
            keyVersion: 1,
            createdAt: now(),
          };
          await tx.put("spaces", s.id, s);
          await tx.put("users", userId, {
            ...u, spaceId: s.id, ...(deps.webDeviceChallenges ? { webInitialDevicePending: s.id } : {}),
          });
          if (enrolling) await bindInitialDevice(tx, userId, input);
          return s;
        });
      } else if (action === "joinSpace") {
        const tokenHash = hash(str(input.token, 128));
        result = await repo.transaction(async (tx) => {
          const enrolling = deps.webDeviceChallenges && input.initialDevice === true;
          const completed = enrolling && await completedEnrollment(tx, userId, input);
          if (completed) return completed;
          const { invitation, space: s } = await invitationSpace(tx, tokenHash, userId);
          ensure(!enrolling || s.id === input.spaceId, "INVALID_INVITE", "邀请码对应的空间已改变");
          const u = await availableBinding(tx, userId);
          s.members = [...s.members, userId];
          await tx.put("spaces", s.id, s);
          await tx.put("users", userId, {
            ...u, spaceId: s.id, ...(deps.webDeviceChallenges ? { webInitialDevicePending: s.id } : {}),
          });
          await tx.put("invitations", tokenHash, {
            ...invitation,
            usedBy: userId,
            usedAt: now(),
          });
          if (enrolling) await bindInitialDevice(tx, userId, input);
          return s;
        });
      } else if (action === "registerDevice") {
        result = await repo.transaction(async (tx) => {
          await member(tx, id(input.spaceId), userId, true, now());
          return storeDevice(tx, userId, input);
        });
      } else {
        const spaceId = id(input.spaceId);
        const readOnly = [
          "getSpace",
          "listRecords",
          "syncRecords",
          "listDevices",
          "fileGet",
          "fileUploadStatus",
          "mutationStatus",
          "closeSpace",
          "cancelClose",
        ].includes(action);
        const space = await member(repo, spaceId, userId, true, now());
        const device = await authorizedDevice(repo, input.deviceId, userId, spaceId);
        ensure(
          space.status === "active" || readOnly,
          "SPACE_CLOSING",
          "空间正在关闭冷静期，只能查看、导出或撤销关闭",
        );
        if (action === "getSpace") {
          result = space;
          if (deps.webDeviceChallenges) {
            const profiles: WebProfile[] = [];
            for (const memberId of space.members) {
              const profile = await repo.get(webProfiles, hash(JSON.stringify([spaceId, memberId])));
              if (profile) profiles.push({ userId: memberId, envelope: profile.envelope });
            }
            result = { ...space, profiles, binaryPhotos: true };
          }
        } else if (action === "setSpaceProfile" && deps.webDeviceChallenges) {
          const envelope = validateEnvelope(input.envelope);
          ensure(envelope.ciphertext.length <= 200, "INVALID_ENVELOPE", "昵称密文过长");
          result = await repo.transaction(async (tx) => {
            const current = await member(tx, spaceId, userId);
            await authorizedDevice(tx, input.deviceId, userId, spaceId);
            ensure(envelope.keyVersion === current.keyVersion, "KEY_VERSION_MISMATCH", "空间密钥已更新，请重新同步");
            const profileId = hash(JSON.stringify([spaceId, userId]));
            await tx.put(webProfiles, profileId, { id: profileId, spaceId, userId, envelope });
            return null;
          });
        } else if (action === "createInvitation") {
          ensure(space.members.length < 2, "SPACE_FULL", "空间已经住了两个人");
          const token = deps.id() + deps.id();
          const tokenHash = hash(token);
          await repo.put("invitations", tokenHash, {
            spaceId,
            expiresAt: now() + 3600000,
          });
          result = { token, expiresAt: now() + 3600000 };
        } else if (action === "listDevices") {
          result = await repo.list(
            "devices",
            { spaceId, status: "active" },
            0,
            100,
          );
        } else if (action === "revokeDevice") {
          result = await repo.transaction(async (tx) => {
            await member(tx, spaceId, userId);
            await authorizedDevice(tx, input.deviceId, userId, spaceId);
            const d = await tx.get("devices", id(input.targetDeviceId));
            ensure(
              d && d.spaceId === spaceId && d.userId === userId,
              "FORBIDDEN",
              "只能撤销自己的设备",
            );
            await tx.put("devices", d.id, { ...d, status: "revoked" });
            return { revoked: true };
          });
        } else if (action === "putTransfer") {
          const t = input.transfer;
          ensure(
            t && t.spaceId === spaceId && t.fromDevice === input.deviceId,
            "INVALID_TRANSFER",
            "密钥包来源不正确",
          );
          result = await repo.transaction(async (tx) => {
            const current = await member(tx, spaceId, userId);
            await authorizedDevice(tx, input.deviceId, userId, spaceId);
            const target = await tx.get("devices", id(t.toDevice));
            ensure(
              target &&
                target.spaceId === spaceId &&
                target.status === "active",
              "FORBIDDEN",
              "目标设备无效",
            );
            ensure(
              t.keyVersion === current.keyVersion,
              "KEY_VERSION_MISMATCH",
              "空间密钥版本已更新",
            );
            ensure(
              !(await tx.get("key_envelopes", id(t.id))),
              "TRANSFER_EXISTS",
              "密钥包标识已经存在，请重新发送",
            );
            await tx.put("key_envelopes", id(t.id), {
              id: t.id,
              spaceId,
              fromDevice: t.fromDevice,
              toDevice: t.toDevice,
              keyVersion: t.keyVersion,
              ephemeralPublicKey: str(t.ephemeralPublicKey, 44),
              envelope: validateEnvelope(t.envelope),
              signature: str(t.signature, 88),
              createdAt: now(),
              expiresAt: now() + TRANSFER_TTL_MS,
            });
            return { sent: true };
          });
        } else if (action === "getTransfers") {
          result = [];
          let offset = 0;
          while (result.length < 100) {
            const rows = await repo.list(
              "key_envelopes",
              {
                spaceId,
                toDevice: input.deviceId,
                keyVersion: space.keyVersion,
              },
              offset,
              100,
            );
            result.push(
              ...rows.filter((t) => !t.expiresAt || t.expiresAt > now()),
            );
            if (rows.length < 100) break;
            offset += rows.length;
          }
          result = result
            .slice(0, 100)
            .sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0));
        } else if (action === "ackTransfer") {
          result = await repo.transaction(async (tx) => {
            await member(tx, spaceId, userId);
            await authorizedDevice(tx, input.deviceId, userId, spaceId);
            const transferId = id(input.transferId);
            const transfer = await tx.get("key_envelopes", transferId);
            if (!transfer) return { acknowledged: true };
            ensure(
              transfer.spaceId === spaceId &&
                transfer.toDevice === input.deviceId,
              "FORBIDDEN",
              "只能确认发给本设备的密钥包",
            );
            await tx.remove("key_envelopes", transferId);
            return { acknowledged: true };
          });
        } else if (action === "rotateSpaceKey") {
          ensure(
            Array.isArray(input.transfers) &&
              input.transfers.length <= 100 &&
              /^[a-f0-9]{64}$/.test(input.keyCommitment),
            "INVALID_REQUEST",
            "轮换请求格式不正确",
          );
          result = await repo.transaction(async (tx) => {
            const current = await member(tx, spaceId, userId);
            await authorizedDevice(tx, input.deviceId, userId, spaceId);
            ensure(
              current.keyVersion === input.expectedVersion,
              "REVISION_CONFLICT",
              "密钥版本已经更新，请重新接收最新密钥",
            );
            const version = current.keyVersion + 1;
            for (const t of input.transfers) {
              ensure(
                t.spaceId === spaceId &&
                  t.fromDevice === input.deviceId &&
                  t.keyVersion === version,
                "INVALID_TRANSFER",
                "密钥包版本或来源不正确",
              );
              const target = await tx.get("devices", id(t.toDevice));
              ensure(
                target &&
                  target.spaceId === spaceId &&
                  target.status === "active",
                "DEVICE_REVOKED",
                "目标设备已撤销",
              );
              ensure(
                !(await tx.get("key_envelopes", id(t.id))),
                "TRANSFER_EXISTS",
                "密钥包标识已经存在",
              );
              await tx.put("key_envelopes", id(t.id), {
                id: t.id,
                spaceId,
                fromDevice: t.fromDevice,
                toDevice: t.toDevice,
                keyVersion: version,
                ephemeralPublicKey: str(t.ephemeralPublicKey, 44),
                envelope: validateEnvelope(t.envelope),
                signature: str(t.signature, 88),
                createdAt: now(),
                expiresAt: now() + TRANSFER_TTL_MS,
              });
            }
            const updated = {
              ...current,
              keyVersion: version,
              keyCommitment: input.keyCommitment,
            };
            await tx.put("spaces", spaceId, updated);
            return updated;
          });
        } else if (action === "syncRecords" && deps.webSync) {
          const sync = deps.webSync;
          result = await sync.read(async (tx) => {
            await member(tx, spaceId, userId, true, now());
            const current = await authorizedDevice(tx, input.deviceId, userId, spaceId);
            return syncRecords(tx, sync, current, input.cursor, now());
          });
        } else if (action === "listRecords") {
          const offset = Number(input.offset || 0);
          ensure(
            Number.isInteger(offset) && offset >= 0 && offset < 100000,
            "INVALID_REQUEST",
            "无效分页",
          );
          if (deps.listVisibleRecords) {
            const usesCursor = input.after !== undefined;
            const after = usesCursor && input.after !== "" ? id(input.after) : "";
            ensure(!usesCursor || offset === 0, "INVALID_REQUEST", "不能同时指定游标和偏移量");
            const visible = await deps.listVisibleRecords(spaceId, device.sharedOnly ? null : userId, after, offset);
            const records = visible.slice(0, 100);
            result = usesCursor ? { records, nextAfter: visible.length > 100 ? records.at(-1)!.id : null }
              : { records, nextOffset: visible.length > 100 ? offset + records.length : null };
          } else {
            const rows: CipherRecord[] = await repo.list(
              "encrypted_records",
              { spaceId },
              offset,
              100,
            );
            result = {
              records: rows.filter(
                (r) => r.visibility === "shared" || (!device.sharedOnly && r.creatorId === userId),
              ),
              nextOffset: rows.length === 100 ? offset + rows.length : null,
            };
          }
        } else if (action === "mutationStatus") {
          ensure(deps.recordReceipts, "NOT_CONFIGURED", "写入回执未启用");
          const previous: RecordReceipt | null = await repo.get(RECORD_RECEIPTS, receiptId(spaceId, userId, input.operationId));
          if (previous) requireDeviceVisibility(device, previous.result.visibility);
          result = previous ? { action: previous.action, result: previous.result } : null;
        } else if (action === "putRecord") {
          const incoming = input.record;
          ensure(
            incoming && incoming.spaceId === spaceId,
            "INVALID_REQUEST",
            "空间不匹配",
          );
          const recordId = id(incoming.id);
          const envelope = validateEnvelope(incoming.envelope);
          const refs = photoReferences(input.photoRefs);
          const ownerOnly = incoming.ownerOnly === true;
          const playMediaRoomId = incoming.playMediaRoomId === undefined ? undefined : id(incoming.playMediaRoomId);
          ensure(
            ["shared", "private"].includes(incoming.visibility) && (!ownerOnly || incoming.visibility === "shared"),
            "INVALID_REQUEST",
            "可见范围不正确",
          );
          result = await changeRecord(spaceId, userId, input.deviceId, action, input.operationId,
            [recordId, incoming.creatorId, incoming.visibility, envelope, input.expectedRevision, refs,
              ...(ownerOnly ? [true] : []), ...(playMediaRoomId ? ["play-media", playMediaRoomId] : [])], async (tx, currentSpace, currentDevice) => {
            requireDeviceVisibility(currentDevice, incoming.visibility);
            ensure(
              envelope.keyVersion === currentSpace.keyVersion,
              "KEY_VERSION_MISMATCH",
              "请先刷新空间密钥",
            );
            const current: CipherRecord | null = await tx.get(
              "encrypted_records",
              recordId,
            );
            if (playMediaRoomId) {
              const room = deps.playMediaEnabled && await tx.get("play_rooms", playMediaRoomId);
              ensure(room && room.spaceId === spaceId && room.status === "active" && room.keyVersion === currentSpace.keyVersion &&
                room.memberIds.includes(userId) && (!room.expiresAt || room.expiresAt > now()) &&
                incoming.visibility === "shared" && ownerOnly && refs?.length === 1,
              "ROOM_UNAVAILABLE", "此活动无法接收照片素材");
            }
            if (!current && deps.recordReceipts) {
              const tombstone = await tx.get(RECORD_TOMBSTONES, recordId);
              ensure(!tombstone, "RECORD_PURGED", "这条记录已永久删除，不能重复提交原保存");
            }
            ensure(
              !current ||
                (current.spaceId === spaceId &&
                  ((current.visibility === "shared" && !current.ownerOnly) ||
                    current.creatorId === userId)),
              "FORBIDDEN",
              "无法编辑这条记录",
            );
            ensure(
              !current || (current.visibility === incoming.visibility && !!current.ownerOnly === ownerOnly &&
                current.playMediaRoomId === playMediaRoomId),
              "INVALID_REQUEST",
              "请另存一条记录以改变可见范围",
            );
            ensure(
              (current?.revision || 0) === input.expectedRevision,
              "REVISION_CONFLICT",
              "对方刚刚修改了这条记录，请刷新后重试",
            );
            ensure(
              incoming.creatorId === (current?.creatorId || userId),
              "FORBIDDEN",
              "记录作者不匹配",
            );
            const record: CipherRecord = {
              id: recordId,
              spaceId,
              creatorId: current?.creatorId || userId,
              visibility: incoming.visibility,
              envelope,
              revision: (current?.revision || 0) + 1,
              createdAt: current?.createdAt || now(),
              updatedAt: now(),
              ...(ownerOnly ? { ownerOnly: true } : {}),
              ...(playMediaRoomId ? { playMediaRoomId } : {}),
              ...(current?.deletedAt ? { deletedAt: current.deletedAt } : {}),
              ...(refs !== undefined ? { photoRefs: refs } : current?.photoRefs ? { photoRefs: current.photoRefs } : {}),
            };
            if (refs !== undefined) await replacePhotoReferences(tx, current, record, userId);
            await tx.put("encrypted_records", recordId, record);
            return record;
          });
        } else if (action === "deleteRecord" || action === "restoreRecord") {
          const recordId = id(input.recordId);
          result = await changeRecord(spaceId, userId, input.deviceId, action, input.operationId,
            [recordId, input.expectedRevision], async (tx, _currentSpace, currentDevice) => {
            const record: CipherRecord = await tx.get(
              "encrypted_records",
              recordId,
            );
            ensure(
              record &&
                record.spaceId === spaceId &&
                ((record.visibility === "shared" && !record.ownerOnly) || record.creatorId === userId),
              "FORBIDDEN",
              "无法操作这条记录",
            );
            requireDeviceVisibility(currentDevice, record.visibility);
            ensure(
              record.revision === input.expectedRevision,
              "REVISION_CONFLICT",
              "记录已更新，请刷新",
            );
            const updated = {
              ...record,
              deletedAt: action === "deleteRecord" ? now() : 0,
              revision: record.revision + 1,
              updatedAt: now(),
            };
            await tx.put("encrypted_records", record.id, updated);
            return updated;
          });
        } else if (action === "purgeRecord") {
          const recordId = id(input.recordId);
          result = await changeRecord(spaceId, userId, input.deviceId, action, input.operationId,
            [recordId, input.expectedRevision], async (tx, _currentSpace, currentDevice) => {
            const record: CipherRecord = await tx.get(
              "encrypted_records",
              recordId,
            );
            ensure(
              record &&
                record.spaceId === spaceId &&
                record.creatorId === userId &&
                record.deletedAt,
              "FORBIDDEN",
              "只能永久删除自己已放入回收站的记录",
            );
            requireDeviceVisibility(currentDevice, record.visibility);
            ensure(
              record.revision === input.expectedRevision,
              "REVISION_CONFLICT",
              "记录已更新，请刷新",
            );
            const deletedFileIds: string[] = [];
            if (deps.managedPhotos) {
              ensure(tx.deletePhoto, "NOT_CONFIGURED", "照片事务存储未配置");
              for (const fileId of record.photoRefs ?? []) {
                const file: StoredPhoto | null = await tx.get("encrypted_files", fileId);
                if (!file?.managed || file.recordId !== record.id) continue;
                await tx.deletePhoto(file.storageId);
                await tx.remove("encrypted_files", fileId);
                deletedFileIds.push(fileId);
              }
            }
            await tx.remove("encrypted_records", record.id);
            if (deps.recordReceipts)
              await tx.put(RECORD_TOMBSTONES, record.id, { id: record.id, spaceId, purgedAt: now() });
            return { id: record.id, visibility: record.visibility, deleted: true, deletedFileIds };
          });
        } else if (action === "filePut") {
          requireDeviceVisibility(device, input.visibility);
          const envelope = validateEnvelope(input.envelope, deps.webDeviceChallenges);
          const receipt = input.receipt === undefined ? undefined : photoReceipt(input.receipt);
          result = await storePhoto(spaceId, userId, input.visibility, envelope, receipt,
            deps.managedPhotos ? { deviceId: input.deviceId, ownerTrack: input.managed === true } : undefined);
        } else if (action === "fileUploadPart") {
          const receipt = photoReceipt(input.receipt);
          const index = input.index;
          const chunk = str(input.chunk, PHOTO_UPLOAD_PART_SIZE);
          const offset = index * PHOTO_UPLOAD_PART_SIZE;
          ensure(
            Number.isSafeInteger(index) && index >= 0 &&
              offset + chunk.length <= MAX_PHOTO_CIPHERTEXT &&
              chunk.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(chunk),
            "INVALID_REQUEST", "照片分段格式不正确",
          );
          const stageId = photoStageId(spaceId, userId, input.deviceId, receipt);
          result = await repo.transaction(async (tx) => {
            const stage = await tx.get("encrypted_files", stageId);
            const ciphertext = stage?.receipt === receipt && stage.expiresAt > now()
              ? stage.ciphertext as string
              : "";
            if (offset < ciphertext.length) {
              ensure(ciphertext.slice(offset, offset + PHOTO_UPLOAD_PART_SIZE) === chunk,
                "INVALID_REQUEST", "照片分段内容不一致");
              return { received: true };
            }
            ensure(offset === ciphertext.length, "PHOTO_PART_MISSING", "照片分段缺失，请重新添加");
            await deps.checkPhotoCapacity?.();
            await tx.put("encrypted_files", stageId, {
              id: stageId, spaceId, receipt, staging: true,
              ciphertext: ciphertext + chunk, expiresAt: now() + 3600000,
            });
            return { received: true };
          });
        } else if (action === "fileUploadCommit") {
          requireDeviceVisibility(device, input.visibility);
          const receipt = photoReceipt(input.receipt);
          const stageId = photoStageId(spaceId, userId, input.deviceId, receipt);
          const fileId = photoFileId(spaceId, userId, receipt, hash);
          const stage = await repo.get("encrypted_files", stageId);
          const file = await repo.get("encrypted_files", fileId);
          if (file?.spaceId === spaceId && file.creatorId === userId && file.storageId) {
            requireDeviceVisibility(device, file.visibility);
            result = { id: fileId };
          } else {
            ensure(stage?.receipt === receipt && stage.expiresAt > now(),
              "PHOTO_PART_MISSING", "照片分段缺失，请重新添加");
            const envelope = validateEnvelope({ ...input.header, ciphertext: stage.ciphertext }, deps.webDeviceChallenges);
            result = await storePhoto(spaceId, userId, input.visibility, envelope, receipt,
              deps.managedPhotos ? { deviceId: input.deviceId, ownerTrack: input.managed === true } : undefined);
            await repo.transaction(async (tx) => {
              if ((await tx.get("encrypted_files", stageId))?.receipt === receipt)
                await tx.remove("encrypted_files", stageId);
            }).catch(() => {}); // The staged copy also expires if cleanup is interrupted.
          }
        } else if (action === "fileUploadStatus") {
          const fileId = photoFileId(spaceId, userId, photoReceipt(input.receipt), hash);
          const file = await repo.get("encrypted_files", fileId);
          result = {
            id: file?.spaceId === spaceId && file.creatorId === userId && file.storageId &&
              (!device.sharedOnly || file.visibility === "shared") ? fileId : null,
          };
        } else if (action === "fileGet" || action === "fileDelete") {
          const file = await repo.get("encrypted_files", id(input.fileId));
          ensure(
            file &&
              typeof file.storageId === "string" &&
              file.spaceId === spaceId &&
              (file.visibility === "shared" || file.creatorId === userId),
            "FORBIDDEN",
            "无法访问此文件",
          );
          requireDeviceVisibility(device, file.visibility);
          if (action === "fileGet") {
            ensure(!file.managed || file.recordId || (file.creatorId === userId && file.attachUntil > now()),
              "FORBIDDEN", "照片尚未加入记录或已过期");
            ensure(deps.fileGet, "NOT_CONFIGURED", "文件服务尚未配置");
            if (deps.webDeviceChallenges && input.cached === true)
              return { success: true, data: { unchanged: true } };
            const part = input.part;
            ensure(part === undefined || (Number.isSafeInteger(part) && part >= 0 &&
              part < Math.ceil(1500000 / PHOTO_DOWNLOAD_PART_SIZE)), "INVALID_REQUEST", "照片分段编号不正确");
            if (part !== undefined && deps.fileGetPart) {
              const result = await deps.fileGetPart(file.storageId, part);
              ensure(result, "INVALID_REQUEST", "照片分段编号不正确或照片已失效");
              return { success: true, data: result };
            }
            const envelope = JSON.parse(await deps.fileGet(file.storageId)) as Envelope;
            result = { envelope };
            if (part !== undefined) {
              const parts = Math.ceil(envelope.ciphertext.length / PHOTO_DOWNLOAD_PART_SIZE);
              ensure(part < parts, "INVALID_REQUEST", "照片分段编号不正确");
              const offset = part * PHOTO_DOWNLOAD_PART_SIZE;
              result = { envelope: { ...envelope, ciphertext: envelope.ciphertext.slice(offset, offset + PHOTO_DOWNLOAD_PART_SIZE) }, parts };
            }
          } else {
            ensure(
              file.creatorId === userId,
              "FORBIDDEN",
              "只能删除自己上传的文件",
            );
            if (deps.managedPhotos) {
              await repo.transaction(async (tx) => {
                await member(tx, spaceId, userId);
                await authorizedDevice(tx, input.deviceId, userId, spaceId);
                const current: StoredPhoto | null = await tx.get("encrypted_files", file.id);
                if (!current) return;
                ensure(!current.managed || !current.recordId, "PHOTO_LINKED", "请从记录中移除照片后再删除");
                ensure(tx.deletePhoto, "NOT_CONFIGURED", "照片事务存储未配置");
                await tx.deletePhoto(current.storageId);
                await tx.remove("encrypted_files", file.id);
              });
            } else {
              await deps.fileDelete?.(file.storageId);
              await repo.remove("encrypted_files", file.id);
            }
            result = { deleted: true };
          }
        } else if (action === "aiGenerate") {
          ensure(
            input.consent === true &&
              Number.isFinite(input.consentAt) &&
              now() - input.consentAt >= 0 &&
              now() - input.consentAt < 120000,
            "AI_CONSENT_REQUIRED",
            "请查看发送预览并给予本次授权",
          );
          ensure(
            typeof input.taskId === "string" &&
              Object.prototype.hasOwnProperty.call(AI_TASKS, input.taskId),
            "INVALID_TASK",
            "不支持的回忆整理方式",
          );
          const task = AI_TASKS[input.taskId as keyof typeof AI_TASKS];
          const text = str(input.text, AI_TEXT_LIMIT);
          ensure(
            space.members.length === 2,
            "PAIR_REQUIRED",
            "请先完成双人绑定，再使用回忆整理",
          );
          ensure(
            deps.ai,
            "AI_NOT_CONFIGURED",
            deps.webDeviceChallenges ? "当前网站尚未接入 AI 服务" : "还没有配置 AI 服务，请在云函数环境变量中设置服务地址、模型和密钥",
          );
          await repo.transaction(async (tx) => {
            const current = await member(tx, spaceId, userId);
            await authorizedDevice(tx, input.deviceId, userId, spaceId);
            ensure(
              current.members.length === 2,
              "PAIR_REQUIRED",
              "请先完成双人绑定",
            );
            const rateId = "user-" + hash(userId);
            const rate = await tx.get("ai_limits", rateId);
            ensure(
              !rate || now() - rate.at >= 10000,
              "RATE_LIMITED",
              "请稍后再生成",
            );
            const day = new Date(now() + 8 * 3600000)
              .toISOString()
              .slice(0, 10);
            const spaceRateId = `space-${spaceId}-${day}`;
            const globalRateId = `global-${day}`;
            const spaceRate = await tx.get("ai_limits", spaceRateId);
            const globalRate = await tx.get("ai_limits", globalRateId);
            const perSpace = deps.aiLimits?.spaceDaily ?? AI_SPACE_DAILY_LIMIT;
            const global = deps.aiLimits?.globalDaily ?? AI_GLOBAL_DAILY_LIMIT;
            ensure(
              (spaceRate?.count || 0) < perSpace,
              "AI_SPACE_QUOTA",
              "这个空间今天的整理次数已用完，请明天再来",
            );
            ensure(
              (globalRate?.count || 0) < global,
              "AI_GLOBAL_QUOTA",
              "今天的 AI 整理总额度已用完，请明天再来",
            );
            const expiresAt = now() + 3 * 86400000;
            // Reserve before contacting the provider. Failures with uncertain billing still consume a slot.
            await tx.put("ai_limits", rateId, {
              id: rateId,
              at: now(),
              expiresAt,
            });
            await tx.put("ai_limits", spaceRateId, {
              id: spaceRateId,
              spaceId,
              day,
              count: (spaceRate?.count || 0) + 1,
              expiresAt,
            });
            await tx.put("ai_limits", globalRateId, {
              id: globalRateId,
              day,
              count: (globalRate?.count || 0) + 1,
              expiresAt,
            });
          });
          result = { text: await deps.ai(text, task) };
        } else if (action === "closeSpace") {
          result = await repo.transaction(async (tx) => {
            const current = await member(tx, spaceId, userId, true, now());
            await authorizedDevice(tx, input.deviceId, userId, spaceId);
            if (current.status === "closing") return current;
            const confirmations = [
              ...new Set([...(current.closeConfirmations || []), userId]),
            ].filter((member) => current.members.includes(member));
            if (
              !current.members.every((member) => confirmations.includes(member))
            ) {
              const requested = {
                ...current,
                closeConfirmations: confirmations,
                closeRequestedAt: current.closeRequestedAt || now(),
              };
              await tx.put("spaces", spaceId, requested);
              return requested;
            }
            const closing = {
              ...current,
              status: "closing",
              closeConfirmations: confirmations,
              closedBy: confirmations[0],
              closingAt: now(),
              purgeAfter: now() + CLOSING_GRACE_MS,
            };
            await tx.put("spaces", spaceId, closing);
            for (const memberId of current.members) {
              const user = await tx.get("users", memberId);
              if (user?.spaceId === spaceId)
                await tx.put("users", memberId, {
                  ...user,
                  spaceId: null,
                  closingSpaceId: spaceId,
                });
            }
            return closing;
          });
        } else if (action === "cancelClose") {
          result = await repo.transaction(async (tx) => {
            const current = await member(tx, spaceId, userId, true, now());
            await authorizedDevice(tx, input.deviceId, userId, spaceId);
            if (
              current.status === "active" &&
              current.closeConfirmations?.length
            ) {
              const { closeConfirmations, closeRequestedAt, ...active } =
                current;
              await tx.put("spaces", spaceId, active);
              return active;
            }
            ensure(
              current.status === "closing",
              "INVALID_STATE",
              "空间没有处于关闭冷静期",
            );
            for (const memberId of current.members) {
              const user = await tx.get("users", memberId);
              ensure(
                (!user?.spaceId || user.spaceId === spaceId) &&
                  (user?.closingSpaceId === spaceId ||
                    user?.spaceId === spaceId),
                "CLOSE_NOT_REVERSIBLE",
                "已有成员建立了新空间，不能恢复旧空间；冷静期内仍可导出",
              );
              await tx.put("users", memberId, {
                ...user,
                spaceId,
                closingSpaceId: null,
              });
            }
            const {
              closedBy,
              closingAt,
              purgeAfter,
              closeConfirmations,
              closeRequestedAt,
              ...active
            } = current;
            const restored = { ...active, status: "active" };
            await tx.put("spaces", spaceId, restored);
            return restored;
          });
        } else throw new AppError("UNKNOWN_ACTION", "接口不存在");
      }
      return { success: true, data: result };
    } catch (error) {
      if (error instanceof AppError)
        return {
          success: false,
          error: { code: error.code, message: error.message },
        };
      deps.onInternalError?.(error);
      return {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "服务暂时不可用，请稍后重试",
        },
      };
    }
  };
}
