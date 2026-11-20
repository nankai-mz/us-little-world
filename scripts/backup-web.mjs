import { resolve } from "node:path";
import { publishWebSnapshot } from "./web-snapshot.mjs";

const [source, output, ...extra] = process.argv.slice(2);
if (!source || !output || extra.length) {
  console.error("用法：npm run backup:web -- <现有 SQLite 数据库> <新快照文件>");
  process.exitCode = 1;
} else {
  try {
    await publishWebSnapshot(resolve(source), resolve(output));
    console.log("SQLite 快照已生成并通过一致性检查。");
  } catch (error) {
    console.error(error?.code === "EEXIST" ? "目标文件已存在，未覆盖。" : "无法创建快照，请检查数据库、目标目录权限及可用空间。");
    process.exitCode = 1;
  }
}

