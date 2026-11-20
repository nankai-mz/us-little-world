import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { readFile, mkdir, readdir, statfs } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { promisify } from "node:util";
import { createApi } from "./api";
import { runMaintenance } from "./lifecycle";
import { openWebRepository } from "./web-repository";
import { parseWebRoute } from "../../web/routes";
import { AppError } from "../core/types";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const derive = promisify(scrypt);
const sessionAge = 7 * 86400;
const accountName = /^[a-z0-9_-]{3,32}$/;
const salt = randomBytes(32);
let accounts: [string, unknown][];
try {
  accounts = Object.entries(JSON.parse(process.env.US_WEB_ACCOUNTS || "{}"));
} catch {
  throw new Error("US_WEB_ACCOUNTS must be a JSON object.");
}
if (accounts.length !== 2 || accounts.some(([name, password]) =>
  !accountName.test(name) || typeof password !== "string" || password.length < 16 || Buffer.byteLength(password) > 256
) || accounts[0][1] === accounts[1][1]) {
  throw new Error("US_WEB_ACCOUNTS must contain two distinct deployment-specific passwords, at least 16 characters each.");
}
const owner = accounts[0][0];
const credentials = new Map(accounts.map(([name, password]) => [name, scryptSync(String(password), salt, 32)]));
accounts.length = 0;
delete process.env.US_WEB_ACCOUNTS;
const unknownAccountHash = randomBytes(32);
const port = Number(process.env.US_WEB_PORT ?? 5180);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid US_WEB_PORT.");
const origin = new URL(process.env.US_WEB_ORIGIN || `http://127.0.0.1:${port}`);
if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
  throw new Error("US_WEB_ORIGIN must be an origin without credentials, path, query or fragment.");
if (origin.protocol !== "https:" && !(origin.protocol === "http:" && origin.hostname === "127.0.0.1" && Number(origin.port) === port))
  throw new Error("Use HTTPS for the website origin outside localhost.");
const database = resolve(process.env.US_WEB_DB || "artifacts/private-web/us.sqlite");
const dataDirectory = dirname(database);
await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
const files = openWebRepository(database);
async function checkPhotoCapacity() {
  const { bavail, blocks } = await statfs(dataDirectory, { bigint: true }).catch(() => {
    throw new AppError("PHOTO_STORAGE_LOW", "暂时无法核对服务器存储空间，请稍后重试上传照片");
  });
  if (blocks <= 0n || bavail * 10n < blocks)
    throw new AppError("PHOTO_STORAGE_LOW", "服务器剩余存储空间不足。可以先保存文字，空间恢复后再添加照片");
}
const deps = { ...files, runtime: { mode: "cloud" } as const, recordReceipts: true, managedPhotos: true, webDeviceChallenges: true,
  now: Date.now, hash, id: () => randomBytes(16).toString("hex"), checkPhotoCapacity };
const api = createApi(deps);
const maintenance = setInterval(() => {
  void runMaintenance(deps).catch(() => console.error("Web space maintenance failed."));
}, 3600000);
maintenance.unref();
const html = (await readFile("dist/index.html", "utf8")).replace("<head>",
  '<head><meta name="us-web-hosted" content="1"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/assets/icon-192.png">');
type DeviceBinding = { spaceId: string; deviceId: string };
type WebSession = {
  account: string;
  expiresAt: number;
  challenges: Map<string, DeviceBinding & { expiresAt: number }>;
  binding?: DeviceBinding;
  authorization?: DeviceBinding & { action: string; expiresAt: number };
};
const sessions = new Map<string, WebSession>();
const unboundActions = new Set(["health", "bootstrap", "createSpace", "joinSpace"]);
const sensitiveActions = new Set(["putTransfer", "revokeDevice", "rotateSpaceKey", "closeSpace", "cancelClose"]);
const deviceIdentifier = /^[a-zA-Z0-9_-]{1,80}$/;
const cookieName = origin.protocol === "https:" ? "__Host-us_session" : "us_session";
const cookieAttributes = `Path=/; HttpOnly; SameSite=Strict${origin.protocol === "https:" ? "; Secure" : ""}`;
const attemptWindow = 60000;
let attempts = 0;
let windowEnds = Date.now() + attemptWindow;
let passwordChecks = 0;
const reauthAttempts = new Map<string, { count: number; expiresAt: number }>();
const mime: Record<string, string> = {
  ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2",
};
const offlineShell = html.replace("<head>", '<head><meta name="us-web-offline" content="1">');
const workerSource = await readFile("dist/sw.js", "utf8").catch(() => null);
const manifest = await readFile("dist/manifest.webmanifest").catch(() => null);
let serviceWorker: string | null = null;
if (workerSource && manifest) {
  const entries = await readdir("dist/assets", { withFileTypes: true });
  const assets = entries.filter((entry) => entry.isFile() && /^[a-zA-Z0-9._-]+$/.test(entry.name) && mime[extname(entry.name)])
    .map(({ name }) => `/assets/${name}`).sort();
  const digest = createHash("sha256").update(offlineShell).update(workerSource).update(manifest);
  for (const file of assets) digest.update(file).update(await readFile(resolve("dist", "." + file)));
  serviceWorker = `self.US_PUBLIC_BUILD = ${JSON.stringify({
    cacheName: "us-public-shell-" + digest.digest("hex").slice(0, 24),
    assets: ["/manifest.webmanifest", ...assets],
  })};\n${workerSource}`;
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}
function fail(response: ServerResponse, status: number, code: string, message: string) {
  json(response, status, { success: false, error: { code, message } });
}
function sessionToken(request: IncomingMessage) {
  const raw = request.headers.cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
  return raw && /^[a-f0-9]{64}$/.test(raw) ? hash(raw) : "";
}
async function readJson(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("BODY_LIMIT");
    chunks.push(chunk);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_JSON");
  return input as Record<string, unknown>;
}
async function passwordMatches(account: string, password: string) {
  const expected = credentials.get(account);
  passwordChecks++;
  try {
    const actual = await derive(password, salt, 32) as Buffer;
    return timingSafeEqual(actual, expected ?? unknownAccountHash) && !!expected;
  } finally {
    passwordChecks--;
  }
}
const server = createServer({ requestTimeout: 30000, headersTimeout: 10000 }, async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (origin.protocol === "https:") response.setHeader("Strict-Transport-Security", "max-age=15552000");
  const path = (request.url || "").split("?")[0];
  try {
    if (request.method === "GET" && serviceWorker && path === "/sw.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(serviceWorker);
      return;
    }
    if (request.method === "GET" && manifest && path === "/manifest.webmanifest") {
      response.writeHead(200, { "Content-Type": "application/manifest+json; charset=utf-8" });
      response.end(manifest);
      return;
    }
    if (request.method === "GET" && serviceWorker && path === "/offline-shell.html" && request.headers["sec-fetch-mode"] !== "navigate") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(offlineShell);
      return;
    }
    if (request.method === "GET" && path === "/healthz") {
      await files.checkReady();
      json(response, 200, { status: "ok" });
      return;
    }
    if ((request.method === "GET" || request.method === "HEAD") && parseWebRoute(path)) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : html);
      return;
    }
    if (request.method === "GET" && /^\/assets\/[a-zA-Z0-9._-]+$/.test(path) && mime[extname(path)]) {
      const asset = await readFile(resolve("dist", "." + path)).catch(() => null);
      if (asset) {
        response.writeHead(200, { "Content-Type": mime[extname(path)] });
        response.end(asset);
        return;
      }
    }
    const token = sessionToken(request);
    const session = sessions.get(token);
    const account = session && session.expiresAt > Date.now() ? session.account : null;
    if (path === "/api/session" && request.method === "GET") {
      json(response, 200, { account, owner: account === owner });
      return;
    }
    if (request.method !== "POST" || !["/api/login", "/api/logout", "/api/space"].includes(path)) {
      fail(response, 404, "NOT_FOUND", "页面不存在");
      return;
    }
    if (request.headers.origin !== origin.origin || !/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) {
      fail(response, 403, "ORIGIN_REQUIRED", "请从网站页面发起请求");
      return;
    }
    if (path === "/api/login") {
      const now = Date.now();
      if (now >= windowEnds) { attempts = 0; windowEnds = now + attemptWindow; }
      if (++attempts > 10) {
        response.setHeader("Retry-After", String(Math.ceil((windowEnds - now) / 1000)));
        fail(response, 429, "RATE_LIMITED", "登录尝试过多，请稍后再试");
        return;
      }
      const { name, password } = await readJson(request, 1024);
      if (typeof name !== "string" || !accountName.test(name) || typeof password !== "string" || Buffer.byteLength(password) > 256) {
        fail(response, 401, "INVALID_LOGIN", "账号或网站密码不正确");
        return;
      }
      if (passwordChecks >= 2) {
        fail(response, 429, "RATE_LIMITED", "当前验证请求较多，请稍后再试");
        return;
      }
      if (!await passwordMatches(name, password)) {
        fail(response, 401, "INVALID_LOGIN", "账号或网站密码不正确");
        return;
      }
      sessions.delete(token);
      for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key);
      if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!);
      const newToken = randomBytes(32).toString("hex");
      sessions.set(hash(newToken), { account: name, expiresAt: now + sessionAge * 1000, challenges: new Map() });
      response.setHeader("Set-Cookie", `${cookieName}=${newToken}; Max-Age=${sessionAge}; ${cookieAttributes}`);
      json(response, 200, { account: name, owner: name === owner });
      return;
    }
    if (path === "/api/logout") {
      sessions.delete(token);
      response.setHeader("Set-Cookie", `${cookieName}=; Max-Age=0; ${cookieAttributes}`);
      json(response, 200, { account: null, owner: false });
      return;
    }
    if (!session || !account || request.headers["x-us-account"] !== account) {
      fail(response, 401, "AUTH_REQUIRED", "请先登录网站");
      return;
    }
    const { action, data = {} } = await readJson(request, 2 * 1024 * 1024);
    if (typeof action !== "string" || !data || typeof data !== "object" || Array.isArray(data)) {
      fail(response, 400, "INVALID_REQUEST", "操作格式不正确");
      return;
    }
    if (sessions.get(token) !== session || session.expiresAt <= Date.now()) {
      fail(response, 401, "AUTH_REQUIRED", "请先登录网站");
      return;
    }
    const input = data as Record<string, unknown>;
    if ((action === "createSpace" && account !== owner) || (action === "joinSpace" && account === owner)) {
      fail(response, 403, "FORBIDDEN", "请由第一个账号创建空间，另一个账号凭邀请码加入");
      return;
    }
    if (action === "deviceChallenge") {
      const { spaceId, id } = input;
      if (typeof spaceId !== "string" || typeof id !== "string" ||
        !deviceIdentifier.test(spaceId) || !deviceIdentifier.test(id)) {
        fail(response, 400, "INVALID_REQUEST", "设备标识格式不正确");
        return;
      }
      const now = Date.now();
      for (const [key, challenge] of session.challenges)
        if (challenge.expiresAt <= now) session.challenges.delete(key);
      if (session.challenges.size >= 8) session.challenges.delete(session.challenges.keys().next().value!);
      const nonce = randomBytes(32).toString("hex");
      session.challenges.set(nonce, { spaceId, deviceId: id, expiresAt: now + 60000 });
      json(response, 200, { success: true, data: { nonce } });
      return;
    }
    const userId = hash(`Us/web/account/${account}`);
    if (action === "registerDevice") {
      const nonce = (input.proof as { nonce?: unknown } | undefined)?.nonce;
      const challenge = typeof nonce === "string" ? session.challenges.get(nonce) : undefined;
      if (challenge) session.challenges.delete(nonce as string);
      if (!challenge || challenge.expiresAt <= Date.now() ||
        challenge.spaceId !== input.spaceId || challenge.deviceId !== input.id) {
        fail(response, 403, "DEVICE_CHALLENGE_REQUIRED", "设备验证已失效，请重新解锁");
        return;
      }
      const result = await api(userId, action, input);
      if (result.success) {
        if (session.binding?.spaceId !== challenge.spaceId || session.binding.deviceId !== challenge.deviceId)
          delete session.authorization;
        session.binding = { spaceId: challenge.spaceId, deviceId: challenge.deviceId };
      }
      json(response, 200, result);
      return;
    }
    const binding = session.binding;
    if (!unboundActions.has(action) &&
      (!binding || binding.spaceId !== input.spaceId || binding.deviceId !== input.deviceId)) {
      fail(response, 403, "DEVICE_UNBOUND", "此会话尚未验证当前设备，请重新解锁");
      return;
    }
    if (action === "authorizeSensitiveAction") {
      const { password, forAction } = input;
      if (!binding || typeof forAction !== "string" || !sensitiveActions.has(forAction) ||
        typeof password !== "string" || Buffer.byteLength(password) > 256) {
        fail(response, 400, "INVALID_REQUEST", "确认请求格式不正确");
        return;
      }
      const now = Date.now();
      const previous = reauthAttempts.get(account);
      const window = previous && previous.expiresAt > now ? previous : { count: 0, expiresAt: now + attemptWindow };
      reauthAttempts.set(account, window);
      if (passwordChecks >= 2 || window.count >= 8) {
        fail(response, 429, "RATE_LIMITED", "验证请求过多，请稍后再试");
        return;
      }
      window.count++;
      if (!await passwordMatches(account, password)) {
        fail(response, 403, "INVALID_PASSWORD", "网站密码不正确");
        return;
      }
      if (sessions.get(token) !== session || session.expiresAt <= Date.now()) {
        fail(response, 401, "AUTH_REQUIRED", "请先登录网站");
        return;
      }
      if (session.binding?.spaceId !== binding.spaceId || session.binding.deviceId !== binding.deviceId) {
        fail(response, 403, "DEVICE_UNBOUND", "当前验证设备已改变，请重新解锁");
        return;
      }
      const device = await api(userId, "getSpace", input);
      if (!device.success) {
        json(response, 200, device);
        return;
      }
      session.authorization = { ...binding, action: forAction, expiresAt: Date.now() + 120000 };
      json(response, 200, { success: true, data: null });
      return;
    }
    if (sensitiveActions.has(action)) {
      const authorization = session.authorization;
      if (!authorization || authorization.action !== action || authorization.expiresAt <= Date.now() ||
        authorization.spaceId !== input.spaceId || authorization.deviceId !== input.deviceId) {
        fail(response, 403, "REAUTH_REQUIRED", "请重新验证网站密码后继续");
        return;
      }
      delete session.authorization;
    }
    json(response, 200, await api(userId, action, input));
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && ["BODY_LIMIT", "INVALID_JSON"].includes(error.message))) {
      if (!response.destroyed) fail(response, 400, "INVALID_REQUEST", "请求格式或大小不正确");
      return;
    }
    console.error("Website request failed.");
    if (!response.headersSent) fail(response, 500, "INTERNAL_ERROR", "服务暂时不可用");
    else response.end();
  }
});
server.listen(port, "127.0.0.1", () => console.log(`网站已启动 http://127.0.0.1:${port}/`));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => { clearInterval(maintenance); files.close(); }));
}
