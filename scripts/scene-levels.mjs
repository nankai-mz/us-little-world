import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const source = fileURLToPath(new URL("../src/features/scene-core/level-campaign.json", import.meta.url));
const schema = fileURLToPath(new URL("../src/features/scene-core/level-schema.ts", import.meta.url));
const activities = ["g11", "g12", "g13"];
const usage = `npm run scene:levels -- list [g11|g12|g13]
npm run scene:levels -- validate [关卡集.json]
npm run scene:levels -- export <活动编号> <关卡序号> <草稿.json>
npm run scene:levels -- check <活动编号> <关卡序号> <草稿.json>
npm run scene:levels -- replace <活动编号> <关卡序号> <草稿.json>`;

const json = (value) => JSON.stringify(value, null, 2) + "\n";
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

async function replaceCampaign(makeCandidate) {
  const lockPath = `${source}.lock`;
  const stagedPath = `${source}.${process.pid}.tmp`;
  const lock = await open(lockPath, "wx");
  try {
    const candidate = await makeCandidate();
    const staged = await open(stagedPath, "wx");
    try {
      try { await staged.writeFile(json(candidate), "utf8"); }
      finally { await staged.close(); }
      await rename(stagedPath, source);
    } finally {
      await rm(stagedPath, { force: true });
    }
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function main(args) {
  const [action, id, number, file] = args;
  if (!action || action === "--help") { console.log(usage); return; }
  if (!(["list", "validate"].includes(action) ? args.length <= 2 :
    ["export", "check", "replace"].includes(action) && args.length === 4 && activities.includes(id) && /^[1-9]\d*$/.test(number)))
    throw new Error(`命令或关卡编号无效\n${usage}`);

  const { outputFiles } = await build({ entryPoints: [schema], write: false, platform: "node", format: "esm", bundle: true });
  const { parseCampaign } = await import("data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64"));
  const readCampaign = async (path = source) => parseCampaign(await readJson(path));

  if (action === "validate") {
    const campaign = await readCampaign(id);
    console.log(`关卡结构已校验，${activities.map((key) => `${key} ${campaign[key].length} 关`).join("，")}`);
    return;
  }
  if (action === "list") {
    if (id && !activities.includes(id)) throw new Error("请选择 g11、g12 或 g13");
    const campaign = await readCampaign();
    for (const key of id ? [id] : activities)
      campaign[key].forEach((level, index) => console.log(`${key}\t${index + 1}\t${level.name}`));
    return;
  }

  const index = Number(number) - 1;
  function currentLevel(campaign) {
    const level = campaign[id][index];
    if (!level) throw new Error(`${id} 没有第 ${number} 关`);
    return level;
  }
  if (action === "export") {
    await writeFile(file, json(currentLevel(await readCampaign())), { encoding: "utf8", flag: "wx" });
    return;
  }
  const draft = await readJson(file);
  async function makeCandidate() {
    const campaign = await readCampaign();
    currentLevel(campaign);
    campaign[id][index] = draft;
    return parseCampaign(campaign);
  }
  if (action === "check") {
    await makeCandidate();
    console.log(`${id} 第 ${number} 关的草稿通过结构校验`);
  } else {
    await replaceCampaign(makeCandidate);
    console.log(`已更新 ${id} 第 ${number} 关`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
