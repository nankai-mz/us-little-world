import type { VaultKey } from "../src/core/crypto";

export const unlockDuration = 24 * 60 * 60 * 1000;

interface SavedUnlock {
  salt: string;
  expiresAt: number;
  generation: string;
  wrappingKey: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

export const unlockGenerationKey = (account: string) => `us.web.${account}.unlockGeneration`;
export const unlockGeneration = (account: string) =>
  localStorage.getItem(unlockGenerationKey(account)) ?? "";
const preferenceKey = (account: string) => `us.web.${account}.skipUnlockMemory`;

export function allowsUnlockMemory(account: string) {
  try { return localStorage.getItem(preferenceKey(account)) !== "true"; }
  catch { return false; }
}

export async function setUnlockMemory(account: string, remember: boolean) {
  localStorage.setItem(preferenceKey(account), String(!remember));
  if (!remember) await forgetUnlock(account);
}

function unlockContext(account: string, { salt, expiresAt, generation }: SavedUnlock) {
  return new TextEncoder().encode(JSON.stringify([account, salt, expiresAt, generation]));
}

async function unlockStore<T>(
  mode: IDBTransactionMode,
  request: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("us-web-unlock", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("accounts");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction("accounts", mode);
      const result = request(transaction.objectStore("accounts"));
      transaction.oncomplete = () => resolve(result.result);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function rememberUnlock(
  account: string,
  access: VaultKey,
  generation: string,
  expiresAt: number,
) {
  const wrappingKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const saved: SavedUnlock = {
    salt: access.salt,
    expiresAt,
    generation,
    wrappingKey,
    iv: crypto.getRandomValues(new Uint8Array(12)),
    ciphertext: new ArrayBuffer(0),
  };
  const key = Uint8Array.from(access.key);
  try {
    saved.ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: saved.iv, additionalData: unlockContext(account, saved) },
      wrappingKey,
      key,
    );
    if (allowsUnlockMemory(account) && generation === unlockGeneration(account))
      await unlockStore("readwrite", (store) => store.put(saved, account));
  } finally {
    key.fill(0);
  }
}

export async function deleteExpiredUnlock(account: string, now = Date.now()) {
  await unlockStore("readwrite", (store) => {
    const request = store.openCursor(account);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor && (cursor.value as SavedUnlock).expiresAt <= now) cursor.delete();
    };
    return request;
  });
}

export async function restoreUnlock(account: string) {
  if (!allowsUnlockMemory(account)) return null;
  const saved: SavedUnlock | undefined = await unlockStore("readonly", (store) => store.get(account));
  if (!saved || saved.generation !== unlockGeneration(account)) return null;
  if (saved.expiresAt <= Date.now()) {
    await deleteExpiredUnlock(account);
    return null;
  }
  const key = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: saved.iv, additionalData: unlockContext(account, saved) },
    saved.wrappingKey,
    saved.ciphertext,
  );
  return { access: { salt: saved.salt, key: new Uint8Array(key) }, expiresAt: saved.expiresAt, generation: saved.generation };
}

export async function forgetUnlock(account: string) {
  try {
    localStorage.setItem(unlockGenerationKey(account), crypto.randomUUID());
  } finally {
    await unlockStore("readwrite", (store) => store.delete(account));
  }
}
