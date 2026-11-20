import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkWebDatabase, publishWebSnapshot } from "./web-snapshot.mjs";

const [snapshot, reference, output, ...extra] = process.argv.slice(2);
if (!snapshot || !reference || !output || extra.length) {
  console.error("用法：npm run recover:web -- <待恢复快照> <同源较新且已停止写入的参考库> <新数据库路径>");
  process.exitCode = 1;
} else {
  try {
    const authority = new DatabaseSync(resolve(reference), { readOnly: true });
    try {
      authority.exec("BEGIN");
      checkWebDatabase(authority);
      const result = await publishWebSnapshot(resolve(snapshot), resolve(output), (db) => reconcile(db, authority));
      console.log(JSON.stringify(result, null, 2));
    } finally { authority.close(); }
  } catch (error) {
    console.error(error?.code === "EEXIST" ? "输出已存在。" : error.message);
    process.exitCode = 1;
  }
}

function history(db) {
  if (db.prepare("PRAGMA user_version").get()?.user_version !== 2)
    throw new Error("恢复需要包含沿袭标记的 Web v2 数据库。旧快照只能离线核对。");
  const value = db.prepare("SELECT lineage, generation FROM web_history WHERE slot = 1").get();
  if (!value || !/^[a-f0-9]{64}$/.test(value.lineage) || !Number.isSafeInteger(value.generation))
    throw new Error("数据库沿袭标记无效。");
  return value;
}

function reconcile(candidate, authority) {
  const from = history(candidate);
  const to = history(authority);
  if (from.lineage !== to.lineage || from.generation > to.generation)
    throw new Error("参考库需要与快照同源，且版本序号不早于快照。");
  const rows = candidate.prepare("SELECT id, data FROM documents WHERE collection = ?");
  const ref = authority.prepare("SELECT data FROM documents WHERE collection = ? AND id = ?");
  const refRows = authority.prepare("SELECT id, data FROM documents WHERE collection = ?");
  const drop = candidate.prepare("DELETE FROM documents WHERE collection = ? AND id = ?");
  const put = candidate.prepare("INSERT OR REPLACE INTO documents (collection, id, data) VALUES (?, ?, ?)");
  const dropPhoto = candidate.prepare("DELETE FROM photos WHERE path = ?");
  const read = (collection, id) => JSON.parse(ref.get(collection, id)?.data ?? "null");
  const store = (collection, row) => put.run(collection, row.id, JSON.stringify(row));
  const count = { closedSpaces: 0, revokedDevices: 0, removedRecords: 0, removedPhotos: 0, updatedTrash: 0 };
  const surviving = new Map();
  candidate.exec("BEGIN IMMEDIATE");
  for (const row of rows.all("spaces")) {
    const previous = JSON.parse(row.data);
    const current = read("spaces", row.id);
    if (!current) throw new Error("同源参考库缺少空间状态，恢复已停止。");
    if (["closed", "purging"].includes(current.status)) {
      store("spaces", {
        id: row.id, status: "closed", members: [], keyVersion: current.keyVersion,
        createdAt: current.createdAt, purgeAfter: current.purgeAfter, purgedAt: current.purgedAt ?? Date.now(),
      });
      count.closedSpaces++;
      continue;
    }
    if (!["active", "closing"].includes(current.status) || !["active", "closing"].includes(previous.status) ||
      current.keyVersion !== previous.keyVersion || JSON.stringify(current.members) !== JSON.stringify(previous.members))
      throw new Error("快照和参考库的成员或密钥版本不同。需要更新且兼容的备份。");
    surviving.set(row.id, current);
    store("spaces", current);
  }
  for (const row of rows.all("users")) {
    const current = read("users", row.id);
    const binding = (key) => surviving.get(current?.[key])?.members.includes(row.id) ? current[key] : null;
    store("users", {
      ...JSON.parse(row.data), id: row.id, spaceId: binding("spaceId"), closingSpaceId: binding("closingSpaceId"),
      webInitialDevicePending: binding("webInitialDevicePending"),
    });
  }
  for (const row of rows.all("devices")) {
    const previous = JSON.parse(row.data);
    const current = read("devices", row.id);
    if (!surviving.has(previous.spaceId)) drop.run("devices", row.id);
    else if (!current || current.status !== "active") {
      if (previous.status !== "revoked") count.revokedDevices++;
      store("devices", { ...previous, status: "revoked" });
    }
  }
  for (const row of rows.all("encrypted_records")) {
    const previous = JSON.parse(row.data);
    const current = read("encrypted_records", row.id);
    if (!surviving.has(previous.spaceId) || !current) {
      drop.run("encrypted_records", row.id);
      if (surviving.has(previous.spaceId)) store("record_tombstones", { id: row.id, spaceId: previous.spaceId, purgedAt: Date.now() });
      count.removedRecords++;
    } else if (current.revision !== previous.revision || current.deletedAt !== previous.deletedAt) {
      if (current.deletedAt !== previous.deletedAt) count.updatedTrash++;
      store("encrypted_records", { ...previous, deletedAt: current.deletedAt, revision: Math.max(current.revision, previous.revision) + 1 });
    }
  }
  for (const row of refRows.all("record_tombstones")) {
    const data = JSON.parse(row.data);
    if (surviving.has(data.spaceId)) store("record_tombstones", data);
  }
  for (const row of rows.all("encrypted_files")) {
    const previous = JSON.parse(row.data);
    const current = read("encrypted_files", row.id);
    if (!previous.staging && surviving.has(previous.spaceId) && current?.storageId === previous.storageId &&
      previous.recordId === current.recordId && (!previous.recordId || candidate.prepare(
        "SELECT id FROM documents WHERE collection = 'encrypted_records' AND id = ?",
      ).get(previous.recordId))) continue;
    if (previous.storageId) count.removedPhotos += Number(dropPhoto.run(previous.storageId).changes);
    drop.run("encrypted_files", row.id);
  }
  const orphans = candidate.prepare(`DELETE FROM photos WHERE NOT EXISTS (
    SELECT 1 FROM documents WHERE collection = 'encrypted_files' AND json_extract(data, '$.storageId') = photos.path
  )`).run();
  count.removedPhotos += Number(orphans.changes);
  candidate.exec(`DELETE FROM documents WHERE collection IN (
    'key_envelopes', 'invitations', 'maintenance_state', 'web_record_streams', 'web_record_changes'
  )`);
  for (const row of rows.all("web_recovery_keys")) {
    const previous = JSON.parse(row.data);
    const current = read("web_recovery_keys", row.id);
    if (!surviving.has(previous.spaceId)) drop.run("web_recovery_keys", row.id);
    else if (!current || current.publicKey !== previous.publicKey)
      throw new Error("快照和参考库的个人恢复公钥无法核对，恢复已停止。");
  }
  for (const row of refRows.all("web_recovery_keys")) {
    const current = JSON.parse(row.data);
    if (surviving.has(current.spaceId)) store("web_recovery_keys", current);
  }
  candidate.exec("DELETE FROM documents WHERE collection = 'web_profiles'");
  for (const row of refRows.all("web_profiles")) {
    const current = JSON.parse(row.data);
    if (surviving.get(current.spaceId)?.members.includes(current.userId)) store("web_profiles", current);
  }
  for (const collection of ["record_receipts", "record_tombstones", "ai_limits"]) {
    for (const row of rows.all(collection)) {
      const { spaceId } = JSON.parse(row.data);
      if (spaceId && !surviving.has(spaceId)) drop.run(collection, row.id);
    }
  }
  candidate.prepare("UPDATE web_history SET generation = ? WHERE slot = 1").run(to.generation + 1);
  candidate.exec("COMMIT");
  return count;
}
