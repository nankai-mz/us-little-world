import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { base64, hex } from "@scure/base";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import {
  AppError,
  type CipherRecord,
  type Envelope,
  type KeyTransfer,
  type RandomSource,
  type RecordMeta,
  type Secrets,
  type Vault,
  type RecoveryVault,
} from "./types";

export const b64 = base64.encode;
export const unb64 = base64.decode;
export const toHex = hex.encode;
export const fromHex = hex.decode;
const utf8 = utf8ToBytes;
export const hashText = (value: string) => toHex(sha256(utf8(value)));
export const browserRandom: RandomSource = async (n) =>
  crypto.getRandomValues(new Uint8Array(n));
export const randomId = async (rng: RandomSource) => toHex(await rng(16));
export function context(
  meta: Pick<RecordMeta, "id" | "spaceId" | "creatorId" | "visibility" | "ownerOnly">,
  keyVersion: number,
) {
  return JSON.stringify([
    "Us",
    1,
    meta.spaceId,
    meta.id,
    "entry",
    meta.creatorId,
    meta.visibility,
    keyVersion,
    ...(meta.ownerOnly ? ["owner-only"] : []),
  ]);
}
function keyFor(master: Uint8Array, aad: string) {
  return hkdf(sha256, master, undefined, utf8(aad), 32);
}
export async function seal(
  value: unknown,
  master: Uint8Array,
  aad: string,
  rng: RandomSource,
  keyVersion = 1,
): Promise<Envelope> {
  return sealBytes(utf8(JSON.stringify(value)), master, aad, rng, keyVersion);
}
export async function sealBytes(
  bytes: Uint8Array, master: Uint8Array, aad: string, rng: RandomSource, keyVersion = 1,
): Promise<Envelope> {
  const nonce = await rng(24);
  const key = keyFor(master, aad);
  try {
    return {
      version: 1,
      algorithm: "XCHACHA20-POLY1305",
      keyVersion,
      nonce: b64(nonce),
      ciphertext: b64(xchacha20poly1305(key, nonce, utf8(aad)).encrypt(bytes)),
    };
  } finally {
    key.fill(0);
  }
}
export function open<T>(
  envelope: Envelope,
  master: Uint8Array,
  aad: string,
): T {
  if (envelope.encoding) throw new AppError("DECRYPT_FAILED", "不支持的密文编码");
  const bytes = openBytes(envelope, master, aad);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new AppError("DECRYPT_FAILED", "密文内容格式不正确");
  }
}
function openBytes(envelope: Envelope, master: Uint8Array, aad: string) {
  if (envelope.version !== 1 || envelope.algorithm !== "XCHACHA20-POLY1305")
    throw new AppError("DECRYPT_FAILED", "不支持的密文版本");
  const key = keyFor(master, aad);
  try {
    return xchacha20poly1305(key, unb64(envelope.nonce), utf8(aad)).decrypt(unb64(envelope.ciphertext));
  } catch {
    throw new AppError(
      "DECRYPT_FAILED",
      "解密失败，请检查恢复密钥或密文完整性",
    );
  } finally {
    key.fill(0);
  }
}
export async function encryptRecord(
  meta: RecordMeta,
  data: unknown,
  secrets: Secrets,
  rng: RandomSource,
  version?: number,
): Promise<CipherRecord> {
  const v =
    version || Math.max(...Object.keys(secrets.spaceKeys).map(Number), 1);
  const key =
    meta.visibility === "private" ? secrets.personalKey : secrets.spaceKeys[v];
  if (!key) throw new AppError("KEY_NOT_FOUND", "请先完成空间密钥交换");
  return {
    ...meta,
    envelope: await seal(data, unb64(key), context(meta, v), rng, v),
  };
}
export function decryptRecord<T>(record: CipherRecord, secrets: Secrets): T {
  const key =
    record.visibility === "private"
      ? secrets.personalKey
      : secrets.spaceKeys[record.envelope.keyVersion];
  if (!key) throw new AppError("KEY_NOT_FOUND", "缺少此版本的空间密钥");
  return open(
    record.envelope,
    unb64(key),
    context(record, record.envelope.keyVersion),
  );
}
export function decryptPhoto(envelope: Envelope, secrets: Secrets, photoId: string, visibility: RecordMeta["visibility"]) {
  return b64(decryptPhotoBytes(envelope, secrets, photoId, visibility));
}
export function decryptPhotoBytes(envelope: Envelope, secrets: Secrets, photoId: string, visibility: RecordMeta["visibility"]) {
  const key = visibility === "private" ? secrets.personalKey : secrets.spaceKeys[envelope.keyVersion];
  if (!key || (visibility === "private" && secrets.sharedOnly))
    throw new AppError("KEY_NOT_FOUND", "缺少此版本的照片密钥");
  const suffix = `${secrets.spaceId}/${photoId}/${visibility}`;
  return envelope.encoding === "bytes" ? openBytes(envelope, unb64(key), `Us/file/2/${suffix}`)
    : unb64(open<{ base64: string }>(envelope, unb64(key), `Us/file/1/${suffix}`).base64);
}
export async function newSecrets(
  rng: RandomSource,
  userId: string,
  spaceId = "",
): Promise<Secrets> {
  return {
    userId,
    spaceId,
    personalKey: b64(await rng(32)),
    encryptionSecret: b64(await rng(32)),
    signingSecret: b64(await rng(32)),
    deviceId: await randomId(rng),
    spaceKeys: {},
  };
}
export interface VaultKey {
  salt: string;
  key: Uint8Array;
}
export async function deriveVaultKey(password: string, salt: string): Promise<VaultKey> {
  if (password.length < 10)
    throw new AppError("WEAK_PASSWORD", "请使用至少 10 位的解锁口令");
  const key = await scryptAsync(utf8(password), unb64(salt), {
    N: 32768,
    r: 8,
    p: 1,
    dkLen: 32,
    maxmem: 40 * 1024 * 1024,
  });
  return { salt, key };
}
export async function lockVault(
  secrets: Secrets,
  password: string,
  rng: RandomSource,
  recoveryKey?: string,
): Promise<{ vault: Vault; recoveryKey: string }> {
  const access = await deriveVaultKey(password, b64(await rng(16)));
  try {
    return await sealVaultWithKey(secrets, access, rng, recoveryKey);
  } finally {
    access.key.fill(0);
  }
}
export async function sealVaultWithKey(
  secrets: Secrets,
  { salt, key }: VaultKey,
  rng: RandomSource,
  recoveryKey?: string,
): Promise<{ vault: Vault; recoveryKey: string }> {
  const previous = recoveryKey || secrets.recoveryKey;
  const recovery = previous
    ? fromHex(previous.replace(/\s/g, ""))
    : await rng(32);
  if (recovery.length !== 32)
    throw new AppError("INVALID_KEY", "恢复密钥必须为 64 位十六进制字符");
  secrets.recoveryKey = toHex(recovery);
  try {
    return {
      recoveryKey: toHex(recovery),
      vault: {
        version: 1,
        salt,
        passwordEnvelope: await seal(secrets, key, "Us/vault/password/1", rng),
        recoveryEnvelope: await seal(
          secrets,
          recovery,
          "Us/vault/recovery/1",
          rng,
        ),
      },
    };
  } finally {
    recovery.fill(0);
  }
}
export async function unlockVault(
  vault: Vault,
  password: string,
): Promise<Secrets> {
  const access = await deriveVaultKey(password, vault.salt);
  try {
    return openVaultWithKey(vault, access);
  } finally {
    access.key.fill(0);
  }
}
export function openVaultWithKey(vault: Vault, access: VaultKey): Secrets {
  if (vault.salt !== access.salt || access.key.length !== 32)
    throw new AppError("DECRYPT_FAILED", "本机密钥已更换，请重新解锁");
  return open(vault.passwordEnvelope, access.key, "Us/vault/password/1");
}
export function recoveryOnlyVault(vault: RecoveryVault): RecoveryVault {
  return { version: 1, recoveryEnvelope: { ...vault.recoveryEnvelope } };
}
export function recoverVault(vault: RecoveryVault, key: string): Secrets {
  return open(
    vault.recoveryEnvelope,
    fromHex(key.replace(/\s/g, "")),
    "Us/vault/recovery/1",
  );
}
export function publicKeys(secrets: Secrets) {
  return {
    encryptionPublicKey: b64(
      x25519.getPublicKey(unb64(secrets.encryptionSecret)),
    ),
    signingPublicKey: b64(ed25519.getPublicKey(unb64(secrets.signingSecret))),
  };
}
export function fingerprint(keys: {
  encryptionPublicKey: string;
  signingPublicKey: string;
}) {
  return toHex(
    sha256(
      utf8(
        JSON.stringify([
          "Us/device/1",
          keys.encryptionPublicKey,
          keys.signingPublicKey,
        ]),
      ),
    ),
  )
    .slice(0, 32)
    .toUpperCase()
    .match(/.{4}/g)!
    .join(" ");
}
function transferContext(
  t: Pick<KeyTransfer, "spaceId" | "fromDevice" | "toDevice" | "keyVersion">,
) {
  return JSON.stringify([
    "Us/key-transfer/1",
    t.spaceId,
    t.fromDevice,
    t.toDevice,
    t.keyVersion,
  ]);
}
function signedTransfer(t: Omit<KeyTransfer, "signature">) {
  return utf8(
    JSON.stringify([
      t.id,
      t.spaceId,
      t.fromDevice,
      t.toDevice,
      t.keyVersion,
      t.ephemeralPublicKey,
      [
        t.envelope.version,
        t.envelope.algorithm,
        t.envelope.keyVersion,
        t.envelope.nonce,
        t.envelope.ciphertext,
      ],
    ]),
  );
}
export async function createTransfer(
  secrets: Secrets,
  toDevice: string,
  recipientKey: string,
  rng: RandomSource,
  version?: number,
): Promise<KeyTransfer> {
  const ephemeral = await rng(32);
  const shared = x25519.getSharedSecret(ephemeral, unb64(recipientKey));
  const keyVersion =
    version || Math.max(...Object.keys(secrets.spaceKeys).map(Number));
  const meta = {
    id: await randomId(rng),
    spaceId: secrets.spaceId,
    fromDevice: secrets.deviceId,
    toDevice,
    keyVersion,
  };
  try {
    const t = {
      ...meta,
      ephemeralPublicKey: b64(x25519.getPublicKey(ephemeral)),
      envelope: await seal(
        {
          key: secrets.spaceKeys[keyVersion],
          keys: Object.fromEntries(
            Object.entries(secrets.spaceKeys).filter(
              ([version]) =>
                /^[1-9]\d*$/.test(version) && Number(version) <= keyVersion,
            ),
          ),
        },
        shared,
        transferContext(meta),
        rng,
        keyVersion,
      ),
    };
    return {
      ...t,
      signature: b64(
        ed25519.sign(signedTransfer(t), unb64(secrets.signingSecret)),
      ),
    };
  } finally {
    ephemeral.fill(0);
    shared.fill(0);
  }
}
export function acceptTransfer(
  t: KeyTransfer,
  secrets: Secrets,
  verifiedSigningKey: string,
): Secrets {
  if (t.spaceId !== secrets.spaceId || t.toDevice !== secrets.deviceId)
    throw new AppError("INVALID_TRANSFER", "密钥包目标不匹配");
  const { signature, ...unsigned } = t;
  if (
    !ed25519.verify(
      unb64(signature),
      signedTransfer(unsigned),
      unb64(verifiedSigningKey),
    )
  )
    throw new AppError("INVALID_SIGNATURE", "密钥包签名验证失败");
  const shared = x25519.getSharedSecret(
    unb64(secrets.encryptionSecret),
    unb64(t.ephemeralPublicKey),
  );
  try {
    const payload = open<{ key: string; keys?: Record<string, string> }>(
      t.envelope,
      shared,
      transferContext(t),
    );
    const keys = payload.keys || { [t.keyVersion]: payload.key };
    const validKey = (key: unknown) => {
      try {
        return (
          typeof key === "string" &&
          unb64(key).length === 32 &&
          b64(unb64(key)) === key
        );
      } catch {
        return false;
      }
    };
    if (
      !validKey(payload.key) ||
      keys[t.keyVersion] !== payload.key ||
      Object.entries(keys).some(
        ([version, key]) =>
          !/^[1-9]\d*$/.test(version) ||
          Number(version) > t.keyVersion ||
          !validKey(key),
      )
    )
      throw new AppError("INVALID_TRANSFER", "密钥历史格式不正确");
    for (const [version, key] of Object.entries(keys))
      if (secrets.spaceKeys[version] && secrets.spaceKeys[version] !== key)
        throw new AppError(
          "KEY_HISTORY_MISMATCH",
          "已保存的历史密钥不匹配，请先刷新并核对安全码",
        );
    return {
      ...secrets,
      spaceKeys: { ...secrets.spaceKeys, ...keys },
    };
  } finally {
    shared.fill(0);
  }
}
