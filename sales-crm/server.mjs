// 销售/实施管理服务入口。nginx 把 /sales-api/ 转发到这里;登录态复用平台后台的 app_session_id,
// 每个请求带着浏览器 Cookie 去平台 auth.me 核验身份(结果缓存 60 秒)。
// /agent/* 只读接口给「实施管理数字总监」AI 员工用,凭内部令牌 CRM_INTERNAL_TOKEN 访问。
import fs from "node:fs";
import http from "node:http";
import { openDb } from "./lib/db.mjs";
import { buildRoutes, HttpError } from "./lib/api.mjs";
import { LookupError } from "./lib/lookup.mjs";
import { DIRECTOR_NAME, startScheduler } from "./lib/director.mjs";
import { startSalesScheduler } from "./lib/sales-director.mjs";

const PORT = Number(process.env.CRM_PORT || 3100);
const HOST = process.env.CRM_HOST || "127.0.0.1";
const DB_FILE = process.env.CRM_DB_FILE || "/var/lib/sales-crm/crm.db";
const PLATFORM_URL = process.env.CRM_PLATFORM_URL || "http://127.0.0.1:3000";
const INTERNAL_TOKEN = process.env.CRM_INTERNAL_TOKEN || "";
const PREFIX = "/sales-api";
const MAX_JSON_BODY = 2 * 1024 * 1024;

const db = openDb(DB_FILE);
const routes = buildRoutes(db);

const authCache = new Map();
async function currentUser(req, path) {
  if (path.startsWith("/agent/")) {
    return INTERNAL_TOKEN && req.headers["x-crm-internal"] === INTERNAL_TOKEN ? { id: 0, name: DIRECTOR_NAME, role: "agent" } : null;
  }
  const cookie = req.headers.cookie || "";
  if (!cookie.includes("app_session_id=")) return null;
  const hit = authCache.get(cookie);
  if (hit && hit.expires > Date.now()) return hit.user;
  const res = await fetch(`${PLATFORM_URL}/api/trpc/auth.me`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  const user = res.ok ? ((await res.json())?.result?.data?.json ?? null) : null;
  if (authCache.size > 500) authCache.clear();
  authCache.set(cookie, { user, expires: Date.now() + 60_000 });
  return user;
}

function readBody(req, maxBody) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > maxBody) {
        reject(new HttpError(413, `提交的内容太大(上限 ${Math.round(maxBody / 1024 / 1024)}MB)`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(buf) {
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "请求格式不正确");
  }
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function sendFile(res, { path, filename }) {
  if (!fs.existsSync(path)) throw new HttpError(404, "文件已丢失");
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": fs.statSync(path).size,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "no-store",
  });
  fs.createReadStream(path).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || "/" : url.pathname;
  try {
    if (path === "/health") return send(res, 200, { ok: true });
    const route = routes.find(r => r.method === req.method && r.re.test(path));
    if (!route) throw new HttpError(404, "接口不存在");
    const user = await currentUser(req, path);
    if (!user) throw new HttpError(401, "登录已失效,请重新登录后台");
    const m = path.match(route.re);
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    let body = {};
    let rawBody = null;
    if (["POST", "PUT"].includes(req.method)) {
      const buf = await readBody(req, route.maxBody ?? MAX_JSON_BODY);
      if (route.raw) rawBody = buf;
      else body = parseJson(buf);
    }
    const result = await route.handler({ req, user, params, query: Object.fromEntries(url.searchParams), body, rawBody });
    if (result?.__file) return sendFile(res, result.__file);
    send(res, 200, result);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    if (err instanceof LookupError) return send(res, 502, { error: err.message });
    if (String(err?.code) === "ERR_SQLITE_ERROR" && /UNIQUE/.test(err.message)) {
      return send(res, 409, { error: "数据重复:该记录已存在" });
    }
    console.error(`[sales-crm] ${req.method} ${path}`, err);
    send(res, 500, { error: "服务器内部错误,请稍后再试" });
  }
});

server.listen(PORT, HOST, () => console.log(`[sales-crm] listening on ${HOST}:${PORT}, db=${DB_FILE}`));
startScheduler(db);
startSalesScheduler(db);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
