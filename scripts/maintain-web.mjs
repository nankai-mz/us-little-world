import { readdir, stat, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { publishWebSnapshot } from "./web-snapshot.mjs";

const [action, ...extra] = process.argv.slice(2);
const { US_WEB_DB, US_WEB_BACKUP_DIR } = process.env;

try {
  if (!US_WEB_DB || !US_WEB_BACKUP_DIR || extra.length || !["backup", "check"].includes(action))
    throw new Error("请配置 US_WEB_DB 和 US_WEB_BACKUP_DIR，并选用 backup 或 check。");
  const source = resolve(US_WEB_DB);
  const snapshots = resolve(US_WEB_BACKUP_DIR);
  const timestamp = new Date().toISOString();
  if (action === "backup") {
    const filename = `us-web-${timestamp.replace(/[:.]/g, "-")}.sqlite`;
    await publishWebSnapshot(source, join(snapshots, filename));
    console.log(JSON.stringify({ snapshot: filename, createdAt: timestamp }));
  } else {
    const entries = await readdir(snapshots, { withFileTypes: true });
    const backups = entries.filter((entry) => entry.isFile() && /^us-web-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/.test(entry.name));
    const times = await Promise.all(backups.map(async ({ name }) => (await stat(join(snapshots, name))).mtimeMs));
    const newest = times.length ? Math.max(...times) : 0;
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
