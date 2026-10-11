// 驾校培训报名管理服务入口。nginx 把 /driving/ 转发到这里(只监听本机 3200)。
//   学员手机端  /driving/                扫码报名 → 填信息选课程 → 手写签名 → 付款 → 电子合同
//   电子合同    /driving/contract/<token> 付款成功后生成
//   管理后台    /driving/admin           密码见 /etc/driving-school.env 的 DS_ADMIN_PASSWORD
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./lib/db.mjs";
import { buildRoutes } from "./lib/api.mjs";
import { makeAuth } from "./lib/auth.mjs";
import { HttpError } from "./lib/util.mjs";
import { renderContractPage, renderMessagePage } from "./lib/contract.mjs";

const PORT = Number(process.env.DS_PORT || 3200);
const HOST = process.env.DS_HOST || "127.0.0.1";
const DB_FILE = process.env.DS_DB_FILE || "/var/lib/driving-school/ds.db";
const PREFIX = "/driving";
const MAX_BODY = 1024 * 1024;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8", "no-cache"],
  "/admin": ["admin.html", "text/html; charset=utf-8", "no-cache"],
  "/static/qrcode.js": ["vendor/qrcode.js", "application/javascript; charset=utf-8", "public, max-age=604800"],
};

const db = openDb(DB_FILE);
const auth = makeAuth({ password: process.env.DS_ADMIN_PASSWORD, secret: process.env.DS_SESSION_SECRET });
const routes = buildRoutes(db, auth);

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
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", ...headers });
  res.end(body);
}
const sendJson = (res, status, data, headers) =>
  send(res, status, JSON.stringify(data), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === PREFIX) return send(res, 301, "", { Location: PREFIX + "/" });
  if (!url.pathname.startsWith(PREFIX + "/")) return send(res, 404, "Not Found");
  const p = url.pathname.slice(PREFIX.length);

  const file = STATIC[p] || STATIC[p.replace(/\/$/, "")];
  if (file && req.method === "GET") {
    return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file[0])), { "Content-Type": file[1], "Cache-Control": file[2] });
  }

  const contract = p.match(/^\/contract\/([0-9a-f]{32})$/);
  if (contract && req.method === "GET") {
    const r = db.prepare("SELECT name, status, contract_no, contract_html FROM registrations WHERE token = ?").get(contract[1]);
    const html = !r ? renderMessagePage("合同不存在", "请检查链接是否完整。")
      : r.status !== "paid" ? renderMessagePage("合同尚未生成", "电子合同在付款成功后自动生成。")
      : renderContractPage(r.contract_html, `培训合同 ${r.contract_no} - ${r.name}`);
    return send(res, r?.status === "paid" ? 200 : 404, html, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  }

  for (const route of routes) {
    if (route.method !== req.method) continue;
    const m = p.match(route.re);
    if (!m) continue;
    if (route.admin && !auth.verify(req.headers.cookie)) throw new HttpError(401, "请先登录");
    let body = {};
    if (req.method === "POST" || req.method === "PUT") {
      if (!String(req.headers["content-type"] || "").includes("application/json")) throw new HttpError(415, "请求格式不正确");
      const buf = await readBody(req);
      try {
        body = buf.length ? JSON.parse(buf.toString("utf8")) : {};
      } catch {
        throw new HttpError(400, "请求格式不正确");
      }
    }
    const extra = {};
    const out = await route.handler({
      req, body, params: m.groups || {}, query: url.searchParams,
      ip: String(req.headers["x-real-ip"] || req.socket.remoteAddress || ""),
      setHeader: (k, v) => (extra[k] = v),
    });
    if (out?.raw !== undefined) return send(res, 200, out.raw, { ...out.headers, ...extra });
    return sendJson(res, 200, out, extra);
  }
  throw new HttpError(404, "接口不存在");
}

http
  .createServer((req, res) => {
    handle(req, res).catch(err => {
      if (!(err instanceof HttpError)) console.error(new Date().toISOString(), req.method, req.url, err);
      if (res.headersSent) return res.end();
      sendJson(res, err instanceof HttpError ? err.status : 500, { error: err instanceof HttpError ? err.message : "服务器开小差了,请稍后再试" });
    });
  })
  .listen(PORT, HOST, () => console.log(`[driving-school] listening on ${HOST}:${PORT}, db ${DB_FILE}`));
