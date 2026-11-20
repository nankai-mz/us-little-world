import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function requireCheck(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkOrigin(rawOrigin) {
  const origin = new URL(rawOrigin);
  requireCheck(origin.protocol === "https:" && !origin.username && !origin.password &&
    origin.pathname === "/" && !origin.search && !origin.hash,
    "请输入网站的 HTTPS 源，例如 https://us.example.com");
  requireCheck(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0", "验收必须启用 TLS 证书验证");
  const release = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const checkedAssets = Object.entries(release.files).flatMap(([path, hash]) =>
    /^dist\/assets\/[a-zA-Z0-9._-]+$/.test(path) ? [[path.slice("dist".length), hash]] : []);
  requireCheck(checkedAssets.some(([path]) => path.endsWith(".js")), "发布清单没有构建资源");

  async function load(path) {
    const response = await fetch(new URL(path, origin), { redirect: "manual", signal: AbortSignal.timeout(10000) }).catch((error) => {
      const code = error?.cause?.code ?? error?.code ?? error?.name;
      throw new Error(`${path} 无法通过 HTTPS 读取（${code}）`);
    });
    requireCheck(response.ok, `${path} 返回 HTTP ${response.status}`);
    const hsts = /(?:^|;)\s*max-age\s*=\s*(\d+)/i.exec(response.headers.get("strict-transport-security") ?? "");
    requireCheck(hsts && Number(hsts[1]) > 0, `${path} 缺少生效的 HSTS`);
    return response;
  }

  const health = await load("/healthz");
  requireCheck((await health.json()).status === "ok", "存储健康检查未通过");
  const home = await load("/app/home");
  requireCheck((await home.text()).includes('<meta name="us-web-hosted" content="1">'), "首页未返回 Us 托管版入口");
  const policy = home.headers.get("content-security-policy") ?? "";
  requireCheck(/(?:^|;)\s*frame-ancestors\s+'none'\s*(?:;|$)/.test(policy), "首页缺少禁止嵌入的内容安全策略");
  const session = await load("/api/session");
  requireCheck(/\bno-store\b/i.test(session.headers.get("cache-control") ?? ""), "未禁止缓存会话响应");
  const sessionBody = await session.json();
  requireCheck(sessionBody.account === null && sessionBody.owner === false, "无凭据请求返回了意外的会话状态");
  const manifest = await load("/manifest.webmanifest");
  requireCheck(manifest.headers.get("content-type")?.startsWith("application/manifest+json") &&
    (await manifest.json()).start_url === "/app/home", "网站安装清单或启动路径无效");
  const worker = await load("/sw.js");
  const workerText = await worker.text();
  requireCheck(workerText.startsWith("self.US_PUBLIC_BUILD = ") && checkedAssets.every(([path]) => workerText.includes(JSON.stringify(path))),
    "Service Worker 的预缓存资源与本包不一致");

  for (const [path, hash] of checkedAssets) {
    const response = await load(path);
    const actual = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
    requireCheck(actual === hash, `${path} 内容与发布清单不一致`);
  }
  return { origin: origin.origin, release: release.version, packagedAt: release.createdAt, assetCount: checkedAssets.length,
    checked: ["tls", "hsts", "health", "hosted-entry", "frame-policy", "anonymous-session", "pwa-manifest", "worker-assets", "asset-hashes"], at: new Date().toISOString() };
}

const [origin, ...other] = process.argv.slice(2);
try {
  requireCheck(origin && other.length === 0, "用法：node scripts/check-web-origin.mjs https://us.example.com");
  console.log(JSON.stringify(await checkOrigin(origin), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
