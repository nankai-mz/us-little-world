import { DatabaseSync } from "node:sqlite";
import { chmod, link, mkdtemp, open, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export function checkWebDatabase(db) {
  if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
    throw new Error("数据库一致性检查失败");
  db.prepare("SELECT collection, id, data FROM documents LIMIT 0").all();
  db.prepare("SELECT path, data FROM photos LIMIT 0").all();
}

export async function publishWebSnapshot(source, output, transform) {
  if (!(await stat(source)).isFile()) throw new Error("数据库路径无效");
  const staging = await mkdtemp(join(dirname(output), ".us-backup-"));
  const candidate = join(staging, "backup.sqlite");
  try {
    const sourceDb = new DatabaseSync(source, { readOnly: true });
    try {
      sourceDb.exec("PRAGMA busy_timeout = 5000");
      sourceDb.prepare("VACUUM INTO ?").run(candidate);
    } finally {
      sourceDb.close();
    }
    const prepared = new DatabaseSync(candidate, { readOnly: !transform });
    let result;
    try {
      result = transform?.(prepared);
      checkWebDatabase(prepared);
    } finally {
      prepared.close();
    }
    await chmod(candidate, 0o600);
    const file = await open(candidate, "r+");
    try { await file.sync(); } finally { await file.close(); }
    // Publish a complete candidate without overwriting an existing backup.
    await link(candidate, output);
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
