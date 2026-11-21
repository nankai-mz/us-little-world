import { readdir, rm, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { publishWebSnapshot } from "./web-snapshot.mjs";

const [action, ...extra] = process.argv.slice(2);
const { US_WEB_DB, US_WEB_BACKUP_DIR } = process.env;
const dayMs = 86400000;
const weekMs = 7 * dayMs;
const snapshotName = /^us-web-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.sqlite$/;

async function listSnapshots(directory) {
  const snapshots = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const parts = entry.isFile() && snapshotName.exec(entry.name);
    if (!parts) continue;
    const [, day, hour, minute, second, ms] = parts;
    const time = Date.parse(`${day}T${hour}:${minute}:${second}.${ms}Z`);
    if (Number.isFinite(time)) snapshots.push({ name: entry.name, time });
  }
  return snapshots.sort((a, b) => b.time - a.time);
}

async function rotateSnapshots(directory, now) {
  const today = Math.floor(now / dayMs);
  const thisWeek = Math.floor((now - 4 * dayMs) / weekMs);
  const retainedDays = new Set();
  const retainedWeeks = new Set();
  let removed = 0;
  const eligible = (await listSnapshots(directory)).filter(({ time }) => time <= now);
  for (const snapshot of eligible) {
    const day = Math.floor(snapshot.time / dayMs);
    const week = Math.floor((snapshot.time - 4 * dayMs) / weekMs);
    if (day > today - 7 && !retainedDays.has(day)) {
      retainedDays.add(day);
      continue;
    }
    if (day <= today - 7 && week >= thisWeek - 4 && !retainedWeeks.has(week)) {
      retainedWeeks.add(week);
      continue;
    }
    if (snapshot === eligible[0]) continue;
    await rm(join(directory, snapshot.name), { force: true });
    removed++;
  }
  return removed;
}

try {
  if (!US_WEB_DB || !US_WEB_BACKUP_DIR || extra.length || !["backup", "check"].includes(action))
    throw new Error("请配置 US_WEB_DB 和 US_WEB_BACKUP_DIR，并选用 backup 或 check。");
  const source = resolve(US_WEB_DB);
  const snapshots = resolve(US_WEB_BACKUP_DIR);
  const timestamp = new Date().toISOString();
  if (action === "backup") {
    const filename = `us-web-${timestamp.replace(/[:.]/g, "-")}.sqlite`;
    let removed = await rotateSnapshots(snapshots, Date.parse(timestamp));
    await publishWebSnapshot(source, join(snapshots, filename));
    removed += await rotateSnapshots(snapshots, Date.parse(timestamp));
    console.log(JSON.stringify({ snapshot: filename, createdAt: timestamp, removed }));
  } else {
    const newest = (await listSnapshots(snapshots))[0]?.time;
    const ageHours = newest ? (Date.now() - newest) / 3600000 : null;
    const volumes = await Promise.all([statfs(dirname(source)), statfs(snapshots)]);
    const [dataFreePercent, backupFreePercent] = volumes.map(({ bavail, blocks }) => blocks > 0 ? 100 * bavail / blocks : 0);
    const status = ageHours === null || ageHours < 0 || ageHours > 24 || Math.min(dataFreePercent, backupFreePercent) < 25
      ? "attention" : "ok";
    console.log(JSON.stringify({ status, ageHours, dataFreePercent, backupFreePercent }));
    if (status !== "ok") process.exitCode = 1;
  }
} catch (error) {
  console.error(error?.code ? `Web 运维任务失败（${error.code}）` : "Web 运维任务失败，请核对参数、目录和数据库一致性。");
  process.exitCode = 1;
}
