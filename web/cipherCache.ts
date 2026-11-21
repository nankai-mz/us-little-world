import { cipherSnapshotScope, type CipherCache, type CipherSnapshot } from "../src/core/web-sync";
import type { Envelope, Secrets } from "../src/core/types";

export const offlineAccountKey = "us.web.offlineAccount";
const offlineAge = 24 * 3600000;
export function setOfflineAccount(account: string | null) {
  try {
    if (account) localStorage.setItem(offlineAccountKey, account);
    else localStorage.removeItem(offlineAccountKey);
  } catch { /* The public shell remains usable without browser storage. */ }
}

const maxBytes = 8 * 1024 * 1024;
const maxPhotoBytes = 16 * 1024 * 1024;
const maxAge = 7 * 86400000;
const storeName = "snapshots";
const photoStore = "photos";
// Blobs abort in some WebKit builds, so ciphertext is stored as text. Older builds
// may already hold Blob payloads; both shapes are read for compatibility.
type CachedPayload = string | Blob;
type CachedSnapshot = { account: string; scope: string; updatedAt: number; payload: CachedPayload };
type CachedPhoto = CachedSnapshot & { fileId: string; byteSize: number };
const encoder = new TextEncoder();
const payloadBytes = (payload: CachedPayload) =>
  typeof payload === "string" ? encoder.encode(payload).length : payload.size;
const payloadText = async (payload: CachedPayload) =>
  typeof payload === "string" ? payload : payload.text();

function offlineEnabled(account: string) {
  return localStorage.getItem(offlineAccountKey) === account &&
    localStorage.getItem(`us.web.${account}.cipherCache`) === "true";
}

async function readSnapshot(account: string, scope: string, age: number) {
  const saved: CachedSnapshot | undefined = await useStore("readonly", (store) => store.get([account, scope]));
  const now = Date.now();
  if (!saved || saved.updatedAt > now || now - saved.updatedAt >= age || payloadBytes(saved.payload) > maxBytes) return;
  const snapshot = JSON.parse(await payloadText(saved.payload)) as CipherSnapshot;
  if (Array.isArray(snapshot.records) && typeof snapshot.cursor === "string")
    return { snapshot, updatedAt: saved.updatedAt };
}

export async function readOfflineSnapshot(account: string, secrets: Secrets) {
  if (!offlineEnabled(account)) return;
  const saved = await readSnapshot(account, cipherSnapshotScope(secrets), offlineAge);
  if (saved) {
    const keyVersion = saved.snapshot.writeKeyVersion;
    return {
      records: saved.snapshot.records,
      writeKeyVersion: Number.isSafeInteger(keyVersion) && keyVersion && secrets.spaceKeys[keyVersion] ? keyVersion : undefined,
      binaryPhotos: saved.snapshot.binaryPhotos === true,
      verifiedAt: saved.updatedAt,
      expiresAt: saved.updatedAt + offlineAge,
    };
  }
}

export async function readOfflinePhoto(account: string, secrets: Secrets, fileId: string) {
  if (!offlineEnabled(account)) return;
  const saved = await readPhoto(account, cipherSnapshotScope(secrets), fileId);
  return offlineEnabled(account) ? saved : undefined;
}

async function readPhoto(account: string, scope: string, fileId: string) {
  const saved: CachedPhoto | undefined = await useStore("readonly",
    (store) => store.get([account, scope, fileId]), photoStore);
  const now = Date.now();
  if (!saved || saved.updatedAt > now || now - saved.updatedAt >= offlineAge) return;
  return { envelope: JSON.parse(await payloadText(saved.payload)) as Envelope, expiresAt: saved.updatedAt + offlineAge };
}

let connection: Promise<IDBDatabase> | undefined;
function openCache() {
  if (connection) return connection;
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("us-web-cipher", 3);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) {
        const store = request.result.createObjectStore(storeName, { keyPath: ["account", "scope"] });
        store.createIndex("byAccount", "account");
      }
      if (event.oldVersion < 2) {
        const store = request.result.createObjectStore(photoStore, { keyPath: ["account", "scope", "fileId"] });
        store.createIndex("byAccount", "account");
      }
      const photos = request.transaction!.objectStore(photoStore);
      photos.createIndex("usage", ["account", "updatedAt", "byteSize"]);
      if (event.oldVersion === 2) {
        const cursor = photos.openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          row.update({ ...row.value, byteSize: payloadBytes(row.value.payload) });
          row.continue();
        };
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      db.onclose = () => { connection = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    connection = undefined;
    throw error;
  });
  return connection;
}
async function useStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
  name = storeName,
): Promise<T> {
  const db = await openCache();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(name, mode);
    const request = operation(transaction.objectStore(name));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function createCipherCache(account: string, enabled: () => boolean): CipherCache {
  function replace(snapshot?: CachedSnapshot) {
    return useStore("readwrite", (store) => {
      const cursor = store.index("byAccount").openKeyCursor(account);
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (row) {
          store.delete(row.primaryKey);
          row.continue();
        } else if (snapshot && enabled()) store.put(snapshot);
      };
      return cursor;
    });
  }
  function clearPhotos() {
    return useStore("readwrite", (store) => {
      const cursor = store.index("byAccount").openKeyCursor(account);
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        store.delete(row.primaryKey);
        row.continue();
      };
      return cursor;
    }, photoStore);
  }
  return {
    get enabled() { return enabled(); },
    async read(scope) {
      return (await readSnapshot(account, scope, maxAge))?.snapshot;
    },
    async write(scope, snapshot) {
      const payload = JSON.stringify(snapshot);
      if (payloadBytes(payload) > maxBytes) {
        await replace();
        throw new Error("回忆密文超过本机缓存上限");
      }
      await replace({ account, scope, updatedAt: Date.now(), payload });
    },
    async readPhoto(scope, fileId) {
      return enabled() ? (await readPhoto(account, scope, fileId))?.envelope : undefined;
    },
    async writePhoto(scope, fileId, envelope) {
      const payload = JSON.stringify(envelope);
      const byteSize = payloadBytes(payload);
      if (!enabled() || byteSize > maxPhotoBytes) return;
      await useStore("readwrite", (store) => {
        const now = Date.now();
        let bytes = byteSize;
        const range = IDBKeyRange.bound([account], [account, []], false, true);
        const request = store.index("usage").openKeyCursor(range, "prev");
        request.onsuccess = () => {
          if (!enabled()) return;
          const row = request.result;
          if (!row) {
            store.put({ account, scope, fileId, updatedAt: now, byteSize, payload });
            return;
          }
          const [, oldScope, oldId] = row.primaryKey as string[];
          const [, updatedAt, size] = row.key as [string, number, number];
          if (oldScope !== scope || oldId !== fileId) {
            if (oldScope !== scope || updatedAt > now || now - updatedAt >= offlineAge || bytes + size > maxPhotoBytes)
              store.delete(row.primaryKey);
            else bytes += size;
          }
          row.continue();
        };
        return request;
      }, photoStore);
    },
    async clear() { await Promise.all([replace(), clearPhotos()]); },
  };
}
