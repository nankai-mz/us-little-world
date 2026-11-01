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
  meta: Pick<RecordMeta, "id" | "spaceId" | "creatorId" | "visibility">,
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
  const nonce = await rng(24);
  const key = keyFor(master, aad);
  try {
    return {
      version: 1,
      algorithm: "XCHACHA20-POLY1305",
      keyVersion,
      nonce: b64(nonce),
      ciphertext: b64(
        xchacha20poly1305(key, nonce, utf8(aad)).encrypt(
          utf8(JSON.stringify(value)),
        ),
      ),
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
  if (envelope.version !== 1 || envelope.algorithm !== "XCHACHA20-POLY1305")
    throw new AppError("DECRYPT_FAILED", "不支持的密文版本");
  const key = keyFor(master, aad);
  try {
    return JSON.parse(
      new TextDecoder().decode(
        xchacha20poly1305(key, unb64(envelope.nonce), utf8(aad)).decrypt(
          unb64(envelope.ciphertext),
        ),
      ),
    ) as T;
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
async function passwordKey(password: string, salt: string) {
  if (password.length < 10)
    throw new AppError("WEAK_PASSWORD", "请使用至少 10 位的解锁口令");
  return scryptAsync(utf8(password), unb64(salt), {
    N: 32768,
    r: 8,
    p: 1,
    dkLen: 32,
    maxmem: 40 * 1024 * 1024,
  });
}
export async function lockVault(
  secrets: Secrets,
  password: string,
  rng: RandomSource,
  recoveryKey?: string,
): Promise<{ vault: Vault; recoveryKey: string }> {
  const salt = b64(await rng(16));
  const previous = recoveryKey || secrets.recoveryKey;
  const recovery = previous
    ? fromHex(previous.replace(/\s/g, ""))
    : await rng(32);
  if (recovery.length !== 32)
    throw new AppError("INVALID_KEY", "恢复密钥必须为 64 位十六进制字符");
  secrets.recoveryKey = toHex(recovery);
  const pk = await passwordKey(password, salt);
  try {
    return {
      recoveryKey: toHex(recovery),
      vault: {
        version: 1,
        salt,
        passwordEnvelope: await seal(secrets, pk, "Us/vault/password/1", rng),
        recoveryEnvelope: await seal(
          secrets,
          recovery,
          "Us/vault/recovery/1",
          rng,
        ),
      },
    };
  } finally {
    pk.fill(0);
    recovery.fill(0);
  }
}
export async function unlockVault(
  vault: Vault,
  password: string,
): Promise<Secrets> {
  const key = await passwordKey(password, vault.salt);
  try {
    return open(vault.passwordEnvelope, key, "Us/vault/password/1");
  } finally {
    key.fill(0);
  }
}
export function recoverVault(vault: Vault, key: string): Secrets {
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
        { key: secrets.spaceKeys[keyVersion] },
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
    const { key } = open<{ key: string }>(
      t.envelope,
      shared,
      transferContext(t),
    );
    return {
      ...secrets,
      spaceKeys: { ...secrets.spaceKeys, [t.keyVersion]: key },
    };
  } finally {
    shared.fill(0);
  }
}
