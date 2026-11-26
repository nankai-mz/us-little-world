import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Repository, Tx } from "./api";
import type { CipherRecord } from "../core/types";
import { PHOTO_DOWNLOAD_PART_SIZE } from "../core/photos";
import type { WebSync } from "./web-sync";
import { migratePlayground } from "./migrations/playground";
import { sequenceKey, type PlayRepository, type PlayTransaction } from "./activities/store";

export function openWebRepository(filename: string) {
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (![0, 1, 2, 3].includes(version)) throw new Error("Unsupported Web database version");
    if (version < 2) {
      db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS documents (
        collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      );
      CREATE TABLE IF NOT EXISTS photos (path TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS web_history (
        slot INTEGER PRIMARY KEY CHECK (slot = 1), lineage TEXT NOT NULL, generation INTEGER NOT NULL
      );
    `);
      db.prepare("INSERT OR IGNORE INTO web_history VALUES (1, ?, 0)").run(randomBytes(32).toString("hex"));
      db.exec("PRAGMA user_version = 2; COMMIT");
    }
    migratePlayground(db, version);
    db.exec(`CREATE INDEX IF NOT EXISTS web_record_space ON documents(json_extract(data, '$.spaceId'), id)
      WHERE collection = 'encrypted_records';
      CREATE INDEX IF NOT EXISTS web_record_change_stream
      ON documents(json_extract(data, '$.stream'), json_extract(data, '$.seq')) WHERE collection = 'web_record_changes'`);
  } catch (error) {
    db.close();
    throw error;
  }
  const get = db.prepare("SELECT data FROM documents WHERE collection = ? AND id = ?");
  const put = db.prepare("INSERT OR REPLACE INTO documents VALUES (?, ?, ?)");
  const remove = db.prepare("DELETE FROM documents WHERE collection = ? AND id = ?");
  const readPhoto = db.prepare("SELECT data FROM photos WHERE path = ?");
  const readPhotoPart = db.prepare(`
    SELECT json_extract(data, '$.version') AS version,
           json_extract(data, '$.algorithm') AS algorithm,
           json_extract(data, '$.keyVersion') AS keyVersion,
           json_extract(data, '$.nonce') AS nonce,
           json_extract(data, '$.encoding') AS encoding,
           substr(json_extract(data, '$.ciphertext'), ?, ?) AS ciphertext,
           length(json_extract(data, '$.ciphertext')) AS total
    FROM photos WHERE path = ?
  `);
  const writePhoto = db.prepare("INSERT OR REPLACE INTO photos VALUES (?, ?)");
  const deletePhoto = db.prepare("DELETE FROM photos WHERE path = ?");
  const advanceHistory = db.prepare("UPDATE web_history SET generation = generation + 1 WHERE slot = 1");
  const getHistory = db.prepare("SELECT generation FROM web_history WHERE slot = 1");
  const listVisibleRecords = db.prepare(`
    SELECT data FROM documents
    WHERE collection = 'encrypted_records' AND json_extract(data, '$.spaceId') = ?
      AND id > ? AND (
        json_extract(data, '$.visibility') = 'shared' OR
        (json_extract(data, '$.visibility') = 'private' AND json_extract(data, '$.creatorId') = ?)
      )
    ORDER BY id LIMIT 101 OFFSET ?
  `);
  const listChanges = db.prepare(`
    SELECT json_extract(data, '$.seq') AS seq, id AS recordId FROM documents
    WHERE collection = 'web_record_changes' AND json_extract(data, '$.stream') = ?
      AND json_extract(data, '$.seq') > ?
    ORDER BY json_extract(data, '$.seq') LIMIT ?
  `);
  const listRooms = db.prepare(`
    SELECT data FROM documents WHERE collection = 'play_rooms'
    AND json_extract(data, '$.spaceId') = ? AND id > ?
    AND (json_extract(data, '$.expiresAt') IS NULL OR json_extract(data, '$.expiresAt') > ?)
    ORDER BY id LIMIT ?
  `);
  const listWorks = db.prepare(`
    SELECT data FROM documents WHERE collection = 'play_works'
    AND json_extract(data, '$.spaceId') = ? AND id > ?
    AND (json_extract(data, '$.visibility') = 'shared' OR json_extract(data, '$.authorId') = ?)
    ORDER BY id LIMIT ?
  `);
  const byResource = db.prepare(`
    SELECT data FROM documents WHERE collection = ? AND id > ? AND id < ? ORDER BY id LIMIT ?
  `);
  const removeResource = db.prepare("DELETE FROM documents WHERE collection = ? AND id > ? AND id < ?");
  const compactedBytes = db.prepare(`
    SELECT coalesce(sum(length(json_extract(data, '$.envelope.ciphertext'))), 0) AS bytes
    FROM documents WHERE collection = 'play_ops' AND id > ? AND id <= ?
  `);
  const compact = db.prepare("DELETE FROM documents WHERE collection = 'play_ops' AND id > ? AND id <= ?");
  const expiredRooms = db.prepare(`
    SELECT data FROM documents WHERE collection = 'play_rooms'
    AND json_extract(data, '$.expiresAt') <= ? ORDER BY json_extract(data, '$.expiresAt'), id LIMIT ?
  `);
  const clearWorkMedia = db.prepare(`
    DELETE FROM documents WHERE collection = 'play_work_media' AND json_extract(data, '$.workId') = ?
  `);
  const playMediaGarbage = db.prepare(`
    SELECT record.data FROM documents AS record
    WHERE record.collection = 'encrypted_records' AND json_extract(record.data, '$.playMediaRoomId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM documents AS room WHERE room.collection = 'play_rooms' AND room.id = json_extract(record.data, '$.playMediaRoomId')
    ) AND NOT EXISTS (
      SELECT 1 FROM documents AS ref JOIN documents AS work
        ON work.collection = 'play_works' AND work.id = json_extract(ref.data, '$.workId')
      WHERE ref.collection = 'play_work_media' AND ref.id > record.id || ':' AND ref.id < record.id || ';'
    )
    ORDER BY record.id LIMIT ?
  `);
  const visibleRecords = async (spaceId: string, privateOwner: string | null, after: string, offset: number) =>
    listVisibleRecords.all(spaceId, after, privateOwner, offset).map((row) => JSON.parse(String(row.data)) as CipherRecord);
  const tx = {
    async get(collection, id) {
      const row = get.get(collection, id);
      return row ? JSON.parse(String(row.data)) : null;
    },
    async put(collection, id, data) { put.run(collection, id, JSON.stringify(data)); },
    async remove(collection, id) { remove.run(collection, id); },
    async putPhoto(path, data) { writePhoto.run(path, data); return path; },
    async deletePhoto(path) { deletePhoto.run(path); },
  } satisfies Tx;
  const parse = (rows: { data?: unknown }[]) => rows.map((row) => JSON.parse(String(row.data)));
  const playTx: PlayTransaction = {
    ...tx,
    rooms: (space, after, at, limit) => parse(listRooms.all(space, after, at, limit)),
    works: (space, after, owner, limit) => parse(listWorks.all(space, after, owner, limit)),
    page: (collection, resource, after, limit) =>
      parse(byResource.all(collection, resource + ":" + after, resource + ";", limit)),
    clear: (collection, resource) => { removeResource.run(collection, resource + ":", resource + ";"); },
    clearWorkMedia: (workId) => { clearWorkMedia.run(workId); },
    trimOperations: (resource, through) => {
      const from = resource + ":", to = from + sequenceKey(through);
      const bytes = Number(compactedBytes.get(from, to)?.bytes ?? 0);
      compact.run(from, to);
      return bytes;
    },
    expired: (at, limit) => parse(expiredRooms.all(at, limit)),
    mediaGarbage: (limit) => parse(playMediaGarbage.all(limit)),
  };
  let previous: Promise<unknown> = Promise.resolve();
  function serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = previous.then(operation);
    previous = next.catch(() => {});
    return next;
  }
  function transaction<T>(operation: (dbTx: Tx) => Promise<T>) {
    return serial(async () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = await operation(tx);
        advanceHistory.run();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  const repo: Repository = {
    get: (collection, id) => serial(() => tx.get(collection, id)),
    put: (collection, id, data) => transaction(() => tx.put(collection, id, data)),
    remove: (collection, id) => transaction(() => tx.remove(collection, id)),
    list: (collection, where, offset, limit) => serial(() => {
      const filters = Object.entries(where);
      const conditions = filters.map(() => " AND json_extract(data, ?) IS ?").join("");
      const bindings = filters.flatMap(([key, value]) => [
        `$.${key}`, typeof value === "boolean" ? Number(value) : value as string | number | null,
      ]);
      const rows = db.prepare(
        "SELECT id, data FROM documents WHERE collection = ?" + conditions + " ORDER BY id LIMIT ? OFFSET ?",
      ).all(collection, ...bindings, limit, offset);
      return rows.map((row) => ({ ...JSON.parse(String(row.data)), id: String(row.id) }));
    }),
    transaction,
  };
  const playRepository: PlayRepository = {
    read: (query) => serial(() => query(playTx)),
    write: (query) => transaction(() => query(playTx)),
  };
  const cursorKey = randomBytes(32);
  const webSync: WebSync = {
    read: (query) => serial(async () => {
      db.exec("BEGIN");
      try {
        const result = await query({ ...tx, visibleRecords,
          changes: async (streamId, after, limit) =>
            listChanges.all(streamId, after, limit).map(({ seq, recordId }) => ({ seq: Number(seq), recordId: String(recordId) })),
        });
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }),
    encode: (state) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", cursorKey, iv);
      const bytes = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
    },
    decode: (token) => {
      if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
      try {
        const bytes = Buffer.from(token, "base64url");
        const decipher = createDecipheriv("aes-256-gcm", cursorKey, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
      } catch { return null; }
    },
  };
  return {
    repo,
    webSync,
    playRepository,
    listVisibleRecords: (spaceId: string, privateOwner: string | null, after: string, offset: number) =>
      serial(() => visibleRecords(spaceId, privateOwner, after, offset)),
    checkReady: () => serial(() => {
      if (!getHistory.get()) throw new Error("Missing Web database history");
    }),
    filePut: (path: string, data: string) => transaction(() => tx.putPhoto(path, data)),
    fileGet: (path: string) => serial(() => {
      const row = readPhoto.get(path);
      if (!row) throw new Error("Encrypted photo missing");
      return String(row.data);
    }),
    fileGetPart: (path: string, part: number) => serial(() => {
      const row = readPhotoPart.get(part * PHOTO_DOWNLOAD_PART_SIZE + 1, PHOTO_DOWNLOAD_PART_SIZE, path);
      if (!row?.ciphertext || row.version !== 1 || row.algorithm !== "XCHACHA20-POLY1305") return;
      const envelope = { version: row.version, algorithm: row.algorithm, keyVersion: Number(row.keyVersion),
        nonce: String(row.nonce), ciphertext: String(row.ciphertext),
        ...(row.encoding === "bytes" ? { encoding: "bytes" as const } : {}) } as const;
      return { envelope, parts: Math.ceil(Number(row.total) / PHOTO_DOWNLOAD_PART_SIZE) };
    }),
    fileDelete: (path: string) => transaction(() => tx.deletePhoto(path)),
    close: () => db.close(),
  };
}
