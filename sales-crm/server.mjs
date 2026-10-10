// 销售管理服务入口。nginx 把 /sales-api/ 转发到这里;登录态复用平台后台的 app_session_id,
// 每个请求带着浏览器 Cookie 去平台 auth.me 核验身份(结果缓存 60 秒)。
import http from "node:http";
import { openDb } from "./lib/db.mjs";
import { buildRoutes, HttpError } from "./lib/api.mjs";
import { LookupError } from "./lib/lookup.mjs";

const PORT = Number(process.env.CRM_PORT || 3100);
const HOST = process.env.CRM_HOST || "127.0.0.1";
const DB_FILE = process.env.CRM_DB_FILE || "/var/lib/sales-crm/crm.db";
const PLATFORM_URL = process.env.CRM_PLATFORM_URL || "http://127.0.0.1:3000";
const PREFIX = "/sales-api";
const MAX_BODY = 2 * 1024 * 1024;

const db = openDb(DB_FILE);
const routes = buildRoutes(db);

const authCache = new Map();
async function currentUser(req) {
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "提交的内容太大"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "请求格式不正确"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || "/" : url.pathname;
  try {
    if (path === "/health") return send(res, 200, { ok: true });
    const route = routes.find(r => r.method === req.method && r.re.test(path));
    if (!route) throw new HttpError(404, "接口不存在");
    const user = await currentUser(req);
    if (!user) throw new HttpError(401, "登录已失效,请重新登录后台");
    const m = path.match(route.re);
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : {};
    const result = await route.handler({ req, user, params, query: Object.fromEntries(url.searchParams), body });
    send(res, 200, result);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    if (err instanceof LookupError) return send(res, 502, { error: err.message });
    if (String(err?.code) === "ERR_SQLITE_ERROR" && /UNIQUE/.test(err.message)) {
      return send(res, 409, { error: "数据重复:该企业或单号已存在" });
    }
    console.error(`[sales-crm] ${req.method} ${path}`, err);
    send(res, 500, { error: "服务器内部错误,请稍后再试" });
  }
});

server.listen(PORT, HOST, () => console.log(`[sales-crm] listening on ${HOST}:${PORT}, db=${DB_FILE}`));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
