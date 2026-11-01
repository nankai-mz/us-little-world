import {
  AppError,
  type CipherRecord,
  type Device,
  type Envelope,
  type Space,
  type ApiReply,
} from "../core/types";
import { API_PROTOCOL, APP_VERSION } from "../core/protocol";
export interface Tx {
  get(collection: string, id: string): Promise<any>;
  put(collection: string, id: string, value: any): Promise<void>;
  remove(collection: string, id: string): Promise<void>;
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
  repo: Repository;
  now: () => number;
  id: () => string;
  hash: (s: string) => string;
  ai?: (text: string, task: string) => Promise<string>;
  filePut?: (path: string, bytes: string) => Promise<string>;
  fileGet?: (fileId: string) => Promise<string>;
  fileDelete?: (fileId: string) => Promise<void>;
  runtime?: { mode: "cloud" | "local"; sdkVersion?: string };
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
export function validateEnvelope(v: any): Envelope {
  ensure(
    v &&
      v.version === 1 &&
      v.algorithm === "XCHACHA20-POLY1305" &&
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
  return {
    version: 1,
    algorithm: "XCHACHA20-POLY1305",
    keyVersion: v.keyVersion,
    nonce,
    ciphertext,
  };
}
async function member(tx: Tx, spaceId: string, userId: string): Promise<Space> {
  const s = await tx.get("spaces", id(spaceId));
  ensure(
    s && s.status === "active" && s.members.includes(userId),
    "MEMBER_REQUIRED",
    "当前账号不能访问这个空间",
  );
  return s;
}
async function authorizedDevice(
  tx: Tx,
  deviceId: unknown,
  userId: string,
  spaceId: string,
) {
  const d = await tx.get("devices", id(deviceId));
  ensure(
    d && d.userId === userId && d.spaceId === spaceId && d.status === "active",
    "DEVICE_REVOKED",
    "设备未授权或已移除",
  );
  return d;
}
export function createApi(deps: ServerDeps) {
  const { repo, now, hash } = deps;
  return async function handle(
    userId: string,
    action: string,
    input: any = {},
  ): Promise<ApiReply> {
    try {
      ensure(userId, "AUTH_REQUIRED", "请先使用微信登录");
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
        const u = await repo.get("users", userId);
        result = {
          userId,
          space: u?.spaceId ? await repo.get("spaces", u.spaceId) : null,
        };
      } else if (action === "createSpace") {
        result = await repo.transaction(async (tx) => {
          const u = await tx.get("users", userId);
          ensure(!u?.spaceId, "ALREADY_BOUND", "当前账号已有空间");
          const s: Space = {
            id: deps.id(),
            members: [userId],
            status: "active",
            keyVersion: 1,
            createdAt: now(),
          };
          await tx.put("spaces", s.id, s);
          await tx.put("users", userId, { spaceId: s.id });
          return s;
        });
      } else if (action === "joinSpace") {
        const tokenHash = hash(str(input.token, 128));
        result = await repo.transaction(async (tx) => {
          const invitation = await tx.get("invitations", tokenHash);
          ensure(
            invitation && !invitation.usedBy && invitation.expiresAt > now(),
            "INVITE_EXPIRED",
            "邀请已过期或已经使用",
          );
          const u = await tx.get("users", userId);
          ensure(!u?.spaceId, "ALREADY_BOUND", "当前账号已有空间");
          const s = await tx.get("spaces", invitation.spaceId);
          ensure(
            s && s.status === "active" && !s.members.includes(userId),
            "INVALID_INVITE",
            "此邀请不可使用",
          );
          ensure(s.members.length < 2, "SPACE_FULL", "这个空间已经住了两个人");
          s.members = [...s.members, userId];
          await tx.put("spaces", s.id, s);
          await tx.put("users", userId, { spaceId: s.id });
          await tx.put("invitations", tokenHash, {
            ...invitation,
            usedBy: userId,
            usedAt: now(),
          });
          return s;
        });
      } else if (action === "registerDevice") {
        result = await repo.transaction(async (tx) => {
          await member(tx, input.spaceId, userId);
          const dId = id(input.id);
          const previous = await tx.get("devices", dId);
          ensure(
            !previous ||
              (previous.userId === userId &&
                previous.status === "active" &&
                previous.spaceId === input.spaceId),
            "DEVICE_REVOKED",
            "设备标识已被撤销或占用",
          );
          const encryptionPublicKey = str(input.encryptionPublicKey, 44);
          const signingPublicKey = str(input.signingPublicKey, 44);
          ensure(
            /^[A-Za-z0-9+/]{43}=$/.test(encryptionPublicKey) &&
              /^[A-Za-z0-9+/]{43}=$/.test(signingPublicKey),
            "INVALID_KEY",
            "公钥格式不正确",
          );
          ensure(
            !previous ||
              (previous.encryptionPublicKey === encryptionPublicKey &&
                previous.signingPublicKey === signingPublicKey),
            "KEY_CHANGED",
            "禁止替换已有设备公钥",
          );
          const d: Device = {
            id: dId,
            spaceId: input.spaceId,
            userId,
            encryptionPublicKey,
            signingPublicKey,
            label: str(input.label, 50),
            status: "active",
            createdAt: previous?.createdAt || now(),
          };
          await tx.put("devices", dId, d);
          return d;
        });
      } else {
        const spaceId = id(input.spaceId);
        const space = await member(repo, spaceId, userId);
        await authorizedDevice(repo, input.deviceId, userId, spaceId);
        if (action === "getSpace") result = space;
        else if (action === "createInvitation") {
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
          const target = await repo.get("devices", id(t.toDevice));
          ensure(
            target && target.spaceId === spaceId && target.status === "active",
            "FORBIDDEN",
            "目标设备无效",
          );
          ensure(
            t.keyVersion === space.keyVersion,
            "KEY_VERSION_MISMATCH",
            "空间密钥版本已更新",
          );
          await repo.put("key_envelopes", id(t.id), {
            id: t.id,
            spaceId,
            fromDevice: t.fromDevice,
            toDevice: t.toDevice,
            keyVersion: t.keyVersion,
            ephemeralPublicKey: str(t.ephemeralPublicKey, 44),
            envelope: validateEnvelope(t.envelope),
            signature: str(t.signature, 88),
          });
          result = { sent: true };
        } else if (action === "getTransfers") {
          result = await repo.list(
            "key_envelopes",
            { spaceId, toDevice: input.deviceId },
            0,
            100,
          );
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
              await tx.put("key_envelopes", id(t.id), {
                id: t.id,
                spaceId,
                fromDevice: t.fromDevice,
                toDevice: t.toDevice,
                keyVersion: version,
                ephemeralPublicKey: str(t.ephemeralPublicKey, 44),
                envelope: validateEnvelope(t.envelope),
                signature: str(t.signature, 88),
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
        } else if (action === "listRecords") {
          const offset = Number(input.offset || 0);
          ensure(
            Number.isInteger(offset) && offset >= 0 && offset < 100000,
            "INVALID_REQUEST",
            "无效分页",
          );
          const rows: CipherRecord[] = await repo.list(
            "encrypted_records",
            { spaceId },
            offset,
            100,
          );
          result = {
            records: rows.filter(
              (r) => r.visibility === "shared" || r.creatorId === userId,
            ),
            nextOffset: rows.length === 100 ? offset + rows.length : null,
          };
        } else if (action === "putRecord") {
          const incoming = input.record;
          ensure(
            incoming && incoming.spaceId === spaceId,
            "INVALID_REQUEST",
            "空间不匹配",
          );
          const recordId = id(incoming.id);
          const envelope = validateEnvelope(incoming.envelope);
          ensure(
            envelope.keyVersion === space.keyVersion,
            "KEY_VERSION_MISMATCH",
            "请先刷新空间密钥",
          );
          ensure(
            ["shared", "private"].includes(incoming.visibility),
            "INVALID_REQUEST",
            "可见范围不正确",
          );
          result = await repo.transaction(async (tx) => {
            const currentSpace = await member(tx, spaceId, userId);
            await authorizedDevice(tx, input.deviceId, userId, spaceId);
            ensure(
              envelope.keyVersion === currentSpace.keyVersion,
              "KEY_VERSION_MISMATCH",
              "请先刷新空间密钥",
            );
            const current: CipherRecord | null = await tx.get(
              "encrypted_records",
              recordId,
            );
            ensure(
              !current ||
                (current.spaceId === spaceId &&
                  (current.visibility === "shared" ||
                    current.creatorId === userId)),
              "FORBIDDEN",
              "无法编辑这条记录",
            );
            ensure(
              !current || current.visibility === incoming.visibility,
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
              ...(current?.deletedAt ? { deletedAt: current.deletedAt } : {}),
            };
            await tx.put("encrypted_records", recordId, record);
            return record;
          });
        } else if (action === "deleteRecord" || action === "restoreRecord") {
          result = await repo.transaction(async (tx) => {
            await member(tx, spaceId, userId);
            await authorizedDevice(tx, input.deviceId, userId, spaceId);
            const record: CipherRecord = await tx.get(
              "encrypted_records",
              id(input.recordId),
            );
            ensure(
              record &&
                record.spaceId === spaceId &&
                (record.visibility === "shared" || record.creatorId === userId),
              "FORBIDDEN",
              "无法操作这条记录",
            );
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
          result = await repo.transaction(async (tx) => {
            await member(tx, spaceId, userId);
            await authorizedDevice(tx, input.deviceId, userId, spaceId);
            const record: CipherRecord = await tx.get(
              "encrypted_records",
              id(input.recordId),
            );
            ensure(
              record &&
                record.spaceId === spaceId &&
                record.creatorId === userId &&
                record.deletedAt,
              "FORBIDDEN",
              "只能永久删除自己已放入回收站的记录",
            );
            ensure(
              record.revision === input.expectedRevision,
              "REVISION_CONFLICT",
              "记录已更新，请刷新",
            );
            await tx.remove("encrypted_records", record.id);
            return { deleted: true };
          });
        } else if (action === "filePut") {
          const envelope = validateEnvelope(input.envelope);
          ensure(
            ["shared", "private"].includes(input.visibility),
            "INVALID_REQUEST",
            "可见范围不正确",
          );
          ensure(deps.filePut, "NOT_CONFIGURED", "文件服务尚未配置");
          const fileId = deps.id();
          const storageId = await deps.filePut(
            `encrypted/${spaceId}/${fileId}.enc`,
            JSON.stringify(envelope),
          );
          await repo.put("encrypted_files", fileId, {
            id: fileId,
            spaceId,
            creatorId: userId,
            visibility: input.visibility,
            storageId,
          });
          result = { id: fileId };
        } else if (action === "fileGet" || action === "fileDelete") {
          const file = await repo.get("encrypted_files", id(input.fileId));
          ensure(
            file &&
              file.spaceId === spaceId &&
              (file.visibility === "shared" || file.creatorId === userId),
            "FORBIDDEN",
            "无法访问此文件",
          );
          if (action === "fileGet") {
            ensure(deps.fileGet, "NOT_CONFIGURED", "文件服务尚未配置");
            result = {
              envelope: JSON.parse(await deps.fileGet(file.storageId)),
            };
          } else {
            ensure(
              file.creatorId === userId,
              "FORBIDDEN",
              "只能删除自己上传的文件",
            );
            await deps.fileDelete?.(file.storageId);
            await repo.remove("encrypted_files", file.id);
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
          const text = str(input.text, 16000);
          const task = str(input.task, 100);
          ensure(
            deps.ai,
            "AI_NOT_CONFIGURED",
            "还没有配置 AI 服务，请在云函数环境变量中设置服务地址、模型和密钥",
          );
          await repo.transaction(async (tx) => {
            const rateId = hash(userId);
            const rate = await tx.get("ai_limits", rateId);
            ensure(
              !rate || now() - rate.at >= 10000,
              "RATE_LIMITED",
              "请稍后再生成",
            );
            await tx.put("ai_limits", rateId, { at: now() });
          });
          result = { text: await deps.ai(text, task) };
        } else if (action === "closeSpace") {
          result = await repo.transaction(async (tx) => {
            const current = await member(tx, spaceId, userId);
            await authorizedDevice(tx, input.deviceId, userId, spaceId);
            await tx.put("spaces", spaceId, { ...current, status: "closed" });
            return { closed: true };
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
