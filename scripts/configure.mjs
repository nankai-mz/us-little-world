import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function validatePublicConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("配置必须是 JSON 对象");
  if (
    Object.keys(value).some(
      (key) => !["appid", "cloudEnv", "cloudFunction"].includes(key),
    )
  )
    throw new Error("这里只接受 AppID、环境 ID 和函数名，不接受密钥或其他字段");
  if (
    typeof value.appid !== "string" ||
    !/^wx[a-fA-F0-9]{16}$/.test(value.appid)
  )
    throw new Error("AppID 格式应为 wx 加 16 位十六进制字符");
  if (
    typeof value.cloudEnv !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/.test(value.cloudEnv)
  )
    throw new Error("CloudBase 环境 ID 格式不正确");
  const cloudFunction = value.cloudFunction || "usApi";
  if (
    typeof cloudFunction !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(cloudFunction)
  )
    throw new Error("云函数名称格式不正确");
  return { appid: value.appid, cloudEnv: value.cloudEnv, cloudFunction };
}
export async function configureProject(root, value) {
  const config = validatePublicConfig(value);
  const projectPath = join(root, "project.config.json");
  const clientPath = join(root, "miniprogram", "config.ts");
  const previousProject = await readFile(projectPath, "utf8");
  const previousClient = await readFile(clientPath, "utf8");
  const project = JSON.parse(previousProject);
  project.appid = config.appid;
  const projectTemp = `${projectPath}.${randomUUID()}.tmp`;
  const clientTemp = `${clientPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(projectTemp, JSON.stringify(project, null, 2) + "\n");
    await writeFile(
      clientTemp,
      "// Public deployment identifiers only. Never store secrets here.\nexport const config = " +
        JSON.stringify(
          { cloudEnv: config.cloudEnv, cloudFunction: config.cloudFunction },
          null,
          2,
        ) +
        ";\n",
    );
    await rename(projectTemp, projectPath);
    await rename(clientTemp, clientPath);
  } catch (error) {
    await writeFile(projectPath, previousProject);
    await writeFile(clientPath, previousClient);
    throw error;
  } finally {
    await Promise.all([
      rm(projectTemp, { force: true }),
      rm(clientTemp, { force: true }),
    ]);
  }
  return { configured: true };
}
async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(["--appid", "--env", "--function", "--file"]);
  const options = {};
  if (!args.length || args.includes("--help")) {
    console.log(
      "用法：npm run configure -- --appid wx0123456789abcdef --env 你的环境ID\n或：npm run configure -- --file config/deployment.local.json\n仅接收公开配置；不会登录、创建云资源或部署。",
    );
    return;
  }
  if (args.length % 2)
    throw new Error("每个参数都需要一个值，请使用 --help 查看用法");
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]))
      throw new Error("不支持的参数；请勿在此传入任何密钥");
    if (Object.hasOwn(options, args[i])) throw new Error("参数不能重复");
    options[args[i]] = args[i + 1];
  }
  if (options["--file"] && args.length !== 2)
    throw new Error("--file 不能与其他参数混用");
  let value;
  if (options["--file"]) {
    const content = await readFile(resolve(options["--file"]), "utf8");
    try {
      value = JSON.parse(content);
    } catch {
      throw new Error("配置文件不是有效 JSON，请检查格式；不会回显文件内容");
    }
  } else
    value = {
      appid: options["--appid"],
      cloudEnv: options["--env"],
      cloudFunction: options["--function"] || "usApi",
    };
  await configureProject(
    resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    value,
  );
  console.log("公开部署配置已写入。请重新构建；尚未登录或部署任何云资源。");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
