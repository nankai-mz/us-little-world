import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { promisify } from "node:util";
import { createApi } from "./api";
import { runMaintenance } from "./lifecycle";
import { openWebRepository } from "./web-repository";

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
if (origin.protocol !== "https:" && !(origin.protocol === "http:" && origin.hostname === "127.0.0.1" && Number(origin.port) === port))
  throw new Error("Use HTTPS for the website origin outside localhost.");
const database = resolve(process.env.US_WEB_DB || "artifacts/private-web/us.sqlite");
await mkdir(dirname(database), { recursive: true, mode: 0o700 });
const files = openWebRepository(database);
const deps = { ...files, runtime: { mode: "cloud" } as const, now: Date.now, hash, id: () => randomBytes(16).toString("hex") };
const api = createApi(deps);
const maintenance = setInterval(() => {
  void runMaintenance(deps).catch(() => console.error("Web space maintenance failed."));
}, 3600000);
maintenance.unref();
const html = (await readFile("dist/index.html", "utf8")).replace("<head>", '<head><meta name="us-web-hosted" content="1">');
const sessions = new Map<string, { account: string; expiresAt: number }>();
const cookieName = origin.protocol === "https:" ? "__Host-us_session" : "us_session";
const cookieAttributes = `Path=/; HttpOnly; SameSite=Strict${origin.protocol === "https:" ? "; Secure" : ""}`;
const attemptWindow = 60000;
let attempts = 0;
let windowEnds = Date.now() + attemptWindow;
const mime: Record<string, string> = {
  ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2",
};

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
const server = createServer({ requestTimeout: 30000, headersTimeout: 10000 }, async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const path = (request.url || "").split("?")[0];
  try {
    if ((request.method === "GET" || request.method === "HEAD") && path === "/") {
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
      const expected = credentials.get(name);
      const actual = await derive(password, salt, 32) as Buffer;
      if (!timingSafeEqual(actual, expected ?? unknownAccountHash) || !expected) {
        fail(response, 401, "INVALID_LOGIN", "账号或网站密码不正确");
        return;
      }
      sessions.delete(token);
      for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key);
      if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!);
      const newToken = randomBytes(32).toString("hex");
      sessions.set(hash(newToken), { account: name, expiresAt: now + sessionAge * 1000 });
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
    if (!account || request.headers["x-us-account"] !== account) {
      fail(response, 401, "AUTH_REQUIRED", "请先登录网站");
      return;
    }
    const { action, data } = await readJson(request, 2 * 1024 * 1024);
    if (typeof action !== "string") {
      fail(response, 400, "INVALID_REQUEST", "操作格式不正确");
      return;
    }
    if ((action === "createSpace" && account !== owner) || (action === "joinSpace" && account === owner)) {
      fail(response, 403, "FORBIDDEN", "请由第一个账号创建空间，另一个账号凭邀请码加入");
      return;
    }
    json(response, 200, await api(hash(`Us/web/account/${account}`), action, data));
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
