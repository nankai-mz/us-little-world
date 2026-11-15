import { DatabaseSync } from "node:sqlite";
import type { Repository, Tx } from "./api";

export function openWebRepository(filename: string) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS documents (
      collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    );
    CREATE TABLE IF NOT EXISTS photos (path TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  const get = db.prepare("SELECT data FROM documents WHERE collection = ? AND id = ?");
  const put = db.prepare("INSERT OR REPLACE INTO documents VALUES (?, ?, ?)");
  const remove = db.prepare("DELETE FROM documents WHERE collection = ? AND id = ?");
  const readPhoto = db.prepare("SELECT data FROM photos WHERE path = ?");
  const writePhoto = db.prepare("INSERT OR REPLACE INTO photos VALUES (?, ?)");
  const deletePhoto = db.prepare("DELETE FROM photos WHERE path = ?");
  const tx: Tx = {
    async get(collection, id) {
      const row = get.get(collection, id);
      return row ? JSON.parse(String(row.data)) : null;
    },
    async put(collection, id, data) { put.run(collection, id, JSON.stringify(data)); },
    async remove(collection, id) { remove.run(collection, id); },
  };
  let previous: Promise<unknown> = Promise.resolve();
  function serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = previous.then(operation);
    previous = next.catch(() => {});
    return next;
  }
  const repo: Repository = {
    get: (collection, id) => serial(() => tx.get(collection, id)),
    put: (collection, id, data) => serial(() => tx.put(collection, id, data)),
    remove: (collection, id) => serial(() => tx.remove(collection, id)),
    list: (collection, where, offset, limit) => serial(() => {
      const filters = Object.entries(where);
      const conditions = filters.map(() => " AND json_extract(data, ?) IS ?").join("");
      const bindings = filters.flatMap(([key, value]) => [
        `$.${key}`, typeof value === "boolean" ? Number(value) : value as string | number | null,
      ]);
      const rows = db.prepare(
        "SELECT data FROM documents WHERE collection = ?" + conditions + " ORDER BY id LIMIT ? OFFSET ?",
      ).all(collection, ...bindings, limit, offset);
      return rows.map((row) => JSON.parse(String(row.data)));
    }),
    transaction: (operation) => serial(async () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = await operation(tx);
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }),
  };
  return {
    repo,
    filePut: (path: string, data: string) => serial(() => {
      writePhoto.run(path, data);
      return path;
    }),
    fileGet: (path: string) => serial(() => {
      const row = readPhoto.get(path);
      if (!row) throw new Error("Encrypted photo missing");
      return String(row.data);
    }),
    fileDelete: (path: string) => serial(() => { deletePhoto.run(path); }),
    close: () => db.close(),
  };
}
