// 进出口贸易管理系统服务入口。nginx 把 /trade/ 转发到这里(只监听本机 3300)。
//   内部后台 + 客户/供应商门户 共用 /trade/,按登录账号角色显示不同菜单
//   配置见 /etc/trade-erp.env(管理员初始密码、会话密钥、企查查/天眼查密钥)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDb, ensureAdmin, getSettings, saveSettings, DEFAULT_SETTINGS } from "./lib/db.mjs";
import { ENTITIES, ROLES, REPORTS, STATUS, PARTNER_TYPES, PORTAL_ACCESS } from "./lib/meta.mjs";
import { createEngine, hasRole, isPortal } from "./lib/engine.mjs";
import { createCalc } from "./lib/calc.mjs";
import { buildHooks, pushdown, PUSHDOWN_TARGETS } from "./lib/hooks.mjs";
import { buildReports } from "./lib/reports.mjs";
import { searchCompanies, companyDetail, lookupProvider, LookupError } from "./lib/lookup.mjs";
import { HttpError, bad, nowBJ, todayBJ, addDays, num, hashPassword, verifyPassword, rateLimiter, makeZip } from "./lib/util.mjs";

const PORT = Number(process.env.TE_PORT || 3300);
const HOST = process.env.TE_HOST || "127.0.0.1";
const DATA_DIR = process.env.TE_DATA_DIR || "/var/lib/trade-erp";
const FILES_DIR = path.join(DATA_DIR, "files");
const PREFIX = "/trade";
const SECRET = process.env.TE_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const MAX_JSON = 2 * 1024 * 1024, MAX_FILE = 30 * 1024 * 1024;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

fs.mkdirSync(FILES_DIR, { recursive: true });
const db = openDb(path.join(DATA_DIR, "trade.db"));
ensureAdmin(db, process.env.TE_ADMIN_PASSWORD);

const hooksRef = { current: {} };
const E = createEngine(db, hooksRef);
const C = createCalc(E);
const HK = buildHooks(E, C);
hooksRef.current = HK.hooks;
const runReport = buildReports(E, C, HK);

// ---------------- 登录会话 ----------------
const sign = v => crypto.createHmac("sha256", SECRET).update(v).digest("base64url");
const COOKIE = "te_session", TTL = 12 * 3600e3;
function issue(u) {
  const v = `${u.id}.${u.token_ver}.${Date.now() + TTL}`;
  return `${COOKIE}=${v}.${sign(v)}; Path=${PREFIX}; HttpOnly; SameSite=Lax; Max-Age=${TTL / 1000}`;
}
function currentUser(req) {
  const m = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.(\\d+)\\.(\\d+)\\.([\\w-]+)`));
  if (!m || Number(m[3]) < Date.now()) return null;
  const a = Buffer.from(m[4]), b = Buffer.from(sign(`${m[1]}.${m[2]}.${m[3]}`));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const row = db.prepare("SELECT * FROM users WHERE id = ? AND enabled = 1").get(Number(m[1]));
  if (!row || row.token_ver !== Number(m[2])) return null;
  return userObj(row);
}
function userObj(row) {
  const u = { id: row.id, username: row.username, name: row.name, roles: JSON.parse(row.roles), dept: row.dept, partner_id: row.partner_id, ptypes: [] };
  if (u.partner_id) {
    const p = E.load(u.partner_id);
    u.partner_name = p?.data.name;
    u.partner_status = p?.status;
    // 准入通过后才开放业务菜单,之前只能维护本企业资料
    u.ptypes = p && p.status === "approved" && !p.data.locked ? p.data.ptype || [] : [];
  }
  return u;
}
const needInternal = u => {
  if (isPortal(u)) throw new HttpError(403, "无权访问");
};
const needRole = (u, r) => {
  if (!hasRole(u, r)) throw new HttpError(403, "无权访问");
};

// ---------------- 工具 ----------------
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, `内容太大(上限 ${Math.round(max / 1024 / 1024)}MB)`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function json(req) {
  if (!String(req.headers["content-type"] || "").includes("application/json")) throw new HttpError(415, "请求格式不正确");
  const buf = await readBody(req, MAX_JSON);
  try {
    return buf.length ? JSON.parse(buf.toString("utf8")) : {};
  } catch {
    throw bad("请求格式不正确");
  }
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", ...headers });
  res.end(body);
}
const sendJson = (res, data, status = 200, headers = {}) => send(res, status, JSON.stringify(data), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
const loginLimit = rateLimiter(10, 900e3), registerLimit = rateLimiter(5, 3600e3);

function resolvedMeta() {
  const s = getSettings(db);
  const fix = fd => (typeof fd.options === "string" && fd.options.startsWith("@") ? { ...fd, options: s[fd.options.slice(1)] || [] } : fd);
  const out = {};
  for (const [k, m] of Object.entries(ENTITIES)) {
    out[k] = { ...m, fields: m.fields.map(fix), lines: (m.lines || []).map(l => ({ ...l, fields: l.fields.map(fix) })) };
  }
  return out;
}

function listRecords(user, type, q) {
  if (!ENTITIES[type]) throw new HttpError(404, "单据类型不存在");
  const where = ["type = ?"], args = [type];
  if (q.get("status")) where.push("status = ?") && args.push(q.get("status"));
  else if (!q.get("all")) where.push("status != 'cancelled'");
  if (q.get("partner")) where.push("partner_id = ?") && args.push(Number(q.get("partner")));
  if (q.get("contract")) where.push("contract_id = ?") && args.push(Number(q.get("contract")));
  if (q.get("mine")) where.push("created_by = ?") && args.push(user.id);
  const kw = String(q.get("q") || "").trim().slice(0, 50);
  if (kw) where.push("(no LIKE ? OR title LIKE ? OR data LIKE ?)") && args.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
  const field = q.get("field"), value = q.get("value");
  if (field && /^\w+$/.test(field) && value !== null) where.push(`json_extract(data, '$.${field}') = ?`) && args.push(/^\d+$/.test(value) ? Number(value) : value);
  const page = Math.max(1, Number(q.get("page")) || 1), size = Math.min(100, Number(q.get("size")) || 20);
  let rows;
  let total;
  if (isPortal(user)) {
    const all = db.prepare(`SELECT * FROM records WHERE ${where.join(" AND ")} ORDER BY id DESC`).all(...args).map(r => ({ ...r, data: JSON.parse(r.data), steps: JSON.parse(r.steps) })).filter(r => E.canSee(user, r));
    total = all.length;
    rows = all.slice((page - 1) * size, page * size);
  } else {
    total = db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${where.join(" AND ")}`).get(...args).n;
    rows = db.prepare(`SELECT * FROM records WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size)
      .map(r => ({ ...r, data: JSON.parse(r.data), steps: JSON.parse(r.steps) }));
  }
  const refIds = new Set();
  for (const r of rows) for (const fd of ENTITIES[type].fields) if (fd.list && fd.type === "ref" && r.data[fd.key]) refIds.add(r.data[fd.key]);
  const refs = {};
  for (const id of refIds) {
    const r = E.load(id);
    if (r) refs[id] = { label: r.type === "partner" ? r.data.name : E.label(r) };
  }
  return { total, page, size, refs, items: rows.map(r => ({ id: r.id, no: r.no, title: r.title, status: r.status, step: r.step, steps: r.steps, version: r.version, data: r.data, created_at: r.created_at, updated_at: r.updated_at })) };
}

function detail(user, rec) {
  if (!E.canSee(user, rec)) throw new HttpError(404, "单据不存在");
  const meta = ENTITIES[rec.type];
  const portal = isPortal(user);
  const related = portal ? [] : (meta.related || []).map(rl => {
    const items = E.list(rl.type, `status != 'cancelled' AND json_extract(data, '$.${rl.field}') = ?`, rec.id);
    return { type: rl.type, field: rl.field, label: rl.label, count: items.length, items: items.slice(-30).reverse().map(r => ({ id: r.id, no: r.no, title: r.title, status: r.status })) };
  });
  const logs = db.prepare("SELECT user_name, action, comment, diff, created_at FROM record_logs WHERE record_id = ? ORDER BY id DESC LIMIT 200").all(rec.id)
    .map(l => ({ ...l, diff: l.diff ? JSON.parse(l.diff) : null }));
  const attachments = db.prepare("SELECT id, category, filename, size, uploader_name, created_at FROM attachments WHERE record_id = ? ORDER BY id").all(rec.id);
  const versions = db.prepare("SELECT version, created_at FROM record_versions WHERE record_id = ? ORDER BY version").all(rec.id);
  const extra = {};
  if (rec.type === "partner" && !portal) {
    extra.portalUser = db.prepare("SELECT username FROM users WHERE partner_id = ?").get(rec.id)?.username || null;
  }
  if (rec.type === "contract" && !portal) {
    extra.executed = C.executed(rec);
    extra.credit = C.contractOccupied(rec.id).map(o => ({ ...o, label: E.label(E.load(o.creditId)) }));
  }
  return {
    record: { id: rec.id, type: rec.type, no: rec.no, title: rec.title, status: rec.status, step: rec.step, steps: rec.steps, version: rec.version, data: rec.data,
      created_at: rec.created_at, updated_at: rec.updated_at, created_by: rec.created_by },
    refs: E.refsOf(rec), editable: E.editable(user, rec), actions: E.availableActions(user, rec), logs: portal ? logs.filter(l => !l.diff).map(l => ({ ...l, comment: l.action === "驳回" ? l.comment : "" })) : logs,
    attachments, versions, related, pushdown: portal || rec.status !== "approved" ? [] : PUSHDOWN_TARGETS[rec.type] || [], extra,
  };
}

// 合同卷宗:合同及其下游全部单据
function dossier(contractId) {
  const c = E.must(contractId, "contract");
  const ids = new Set();
  for (const r of db.prepare("SELECT id FROM records WHERE status != 'cancelled' AND (contract_id = ? OR data LIKE ?)").all(c.id, `%"contract":${c.id}%`)) ids.add(r.id);
  for (const r of db.prepare("SELECT id FROM records WHERE type = 'match' AND status != 'cancelled' AND (json_extract(data, '$.purchase') = ? OR json_extract(data, '$.sale') = ?)").all(c.id, c.id)) ids.add(r.id);
  ids.delete(c.id);
  const docs = [...ids].map(id => E.load(id)).filter(r => {
    if (r.contract_id === c.id || r.data.contract === c.id || r.data.purchase === c.id || r.data.sale === c.id) return true;
    return Object.values(r.data).some(v => Array.isArray(v) && v.some(x => x && x.contract === c.id));
  });
  const groups = {};
  for (const r of docs) (groups[r.type] ||= []).push({ id: r.id, no: r.no, title: r.title, status: r.status, updated_at: r.updated_at });
  const att = db.prepare(`SELECT a.id, a.record_id, a.category, a.filename, a.size, a.created_at, r.no, r.type FROM attachments a JOIN records r ON r.id = a.record_id
    WHERE a.record_id IN (${[c.id, ...docs.map(d => d.id)].join(",")}) ORDER BY a.id`).all();
  return { contract: { id: c.id, no: c.no, title: c.title, status: c.status, data: c.data }, executed: C.executed(c), groups, attachments: att };
}

function notificationsFor(user, all) {
  const where = isPortal(user) ? "partner_id = ?" : `partner_id IS NULL AND (role IS NULL OR role IN (${user.roles.includes("admin") ? Object.keys(ROLES).map(r => `'${r}'`).join(",") : user.roles.map(r => `'${r.replace(/'/g, "")}'`).join(",") || "''"}))`;
  const args = isPortal(user) ? [user.partner_id] : [];
  const rows = db.prepare(`SELECT * FROM notifications WHERE ${where} ${all ? "" : "AND read_at IS NULL"} ORDER BY id DESC LIMIT 100`).all(...args);
  return { items: rows, unread: db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${where} AND read_at IS NULL`).get(...args).n };
}

// ---------------- 定时提醒:应收提醒、授信到期 ----------------
function dailyJobs() {
  const today = todayBJ(), soon = addDays(today, 3);
  const exists = (title, pid) => db.prepare("SELECT 1 FROM notifications WHERE title = ? AND COALESCE(partner_id, 0) = ? AND created_at >= ?").get(title, pid || 0, today);
  E.tx(() => {
    for (const c of E.list("contract", "status = 'approved' AND json_extract(data, '$.direction') = '销售'")) {
      if (c.data.closed) continue;
      const due = (c.data.pay_plan || []).filter(p => p.date <= soon).reduce((s, p) => s + num(p.amount) * C.rateOf(c), 0);
      const got = C.claimsFor(c.id, "收款").reduce((s, x) => s + x.amount, 0);
      const gap = Math.round((due - got) * 100) / 100;
      if (gap > 0.01) {
        const title = `应收提醒:合同 ${c.no} 应付款 ${gap.toLocaleString("zh-CN")} 元`;
        if (!exists(title, c.partner_id)) E.notify({ partner_id: c.partner_id, title, body: "请按合同约定及时付款,付款后可在门户上传付款回单", record_id: c.id });
        const t2 = `应收待收:${c.data.partner_name} ${c.no} ${gap.toLocaleString("zh-CN")} 元`;
        if (!exists(t2, 0)) E.notify({ role: "biz", title: t2, record_id: c.id });
      }
    }
    for (const cl of E.list("credit_line", "status = 'approved'")) {
      if (cl.data.valid_to && cl.data.valid_to >= today && cl.data.valid_to <= addDays(today, 30)) {
        const title = `授信即将到期:${cl.data.partner_name} ${cl.data.credit_type}(${cl.data.valid_to})`;
        if (!db.prepare("SELECT 1 FROM notifications WHERE title = ?").get(title)) E.notify({ role: "risk", title, record_id: cl.id });
      }
    }
  });
}
let lastJobDay = "";
setInterval(() => {
  if (lastJobDay === todayBJ()) return;
  lastJobDay = todayBJ();
  try {
    dailyJobs();
  } catch (e) {
    console.error("[daily jobs]", e);
  }
}, 3600e3).unref();
setTimeout(() => {
  lastJobDay = todayBJ();
  try {
    dailyJobs();
  } catch (e) {
    console.error("[daily jobs]", e);
  }
}, 5000).unref();

// ---------------- 企查查/天眼查风险扫描 ----------------
async function riskScan(user, partnerId) {
  const p = E.must(partnerId, "partner");
  const info = await companyDetail(p.data.credit_code || p.data.name);
  if (!info) throw bad("工商接口未查到该企业");
  return E.tx(() => {
    const events = [];
    if (info.regStatus && !/存续|在业|在营|开业/.test(info.regStatus)) events.push(["高", `登记状态异常:${info.regStatus}`]);
    if (info.legalPerson && p.data.legal_person && info.legalPerson !== p.data.legal_person) events.push(["中", `法定代表人变更:${p.data.legal_person} → ${info.legalPerson}`]);
    if (info.name && info.name !== p.data.name) events.push(["中", `企业名称变更:${p.data.name} → ${info.name}`]);
    if (info.regCapital && p.data.reg_capital && info.regCapital !== p.data.reg_capital) events.push(["低", `注册资本变化:${p.data.reg_capital} → ${info.regCapital}`]);
    if (info.businessScope && p.data.business_scope && info.businessScope !== p.data.business_scope) events.push(["低", "经营范围发生变化"]);
    for (const [level, title] of events) {
      E.insertRaw("risk_event", { partner: p.id, partner_name: p.data.name, level, title, detail: JSON.stringify(info, null, 1), source: "企查查/天眼查", state: "待处理" }, { user, status: "approved" });
      if (level === "高") E.notify({ role: "risk", title: `高风险预警:${p.data.name} ${title}`, record_id: p.id });
    }
    p.data.reg_status = info.regStatus;
    E.write(p);
    E.log(p.id, user, "工商风险扫描", events.length ? events.map(e => e[1]).join(";") : "未发现异常");
    return { events: events.map(([level, title]) => ({ level, title })), info };
  });
}

// ---------------- 路由 ----------------
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8", "no-cache"],
  "/static/app.js": ["app.js", "application/javascript; charset=utf-8", "no-cache"],
  "/static/app.css": ["app.css", "text/css; charset=utf-8", "no-cache"],
};

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === PREFIX) return send(res, 301, "", { Location: PREFIX + "/" });
  if (!url.pathname.startsWith(PREFIX + "/")) return send(res, 404, "Not Found");
  const p = url.pathname.slice(PREFIX.length), q = url.searchParams, M = req.method;

  const st = STATIC[p];
  if (st && M === "GET") return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, st[0])), { "Content-Type": st[1], "Cache-Control": st[2] });
  if (p === "/api/health") return sendJson(res, { ok: true });
  const ip = String(req.headers["x-real-ip"] || req.socket.remoteAddress || "");

  // ----- 无需登录 -----
  if (p === "/api/login" && M === "POST") {
    if (!loginLimit(ip)) throw new HttpError(429, "尝试次数过多,请 15 分钟后再试");
    const b = await json(req);
    const row = db.prepare("SELECT * FROM users WHERE username = ? AND enabled = 1").get(String(b.username || "").trim());
    if (!row || !verifyPassword(String(b.password || ""), row.password)) throw new HttpError(401, "用户名或密码错误");
    return sendJson(res, { user: userObj(row) }, 200, { "Set-Cookie": issue(row) });
  }
  if (p === "/api/logout" && M === "POST") return sendJson(res, { ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=${PREFIX}; HttpOnly; SameSite=Lax; Max-Age=0` });
  if (p === "/api/portal/register" && M === "POST") {
    if (!registerLimit(ip)) throw new HttpError(429, "注册过于频繁,请稍后再试");
    const b = await json(req);
    const username = String(b.username || "").trim(), password = String(b.password || "");
    const ptype = (Array.isArray(b.ptype) ? b.ptype : []).filter(t => PARTNER_TYPES.includes(t) && t !== "内部组织");
    if (!/^[\w@.-]{4,40}$/.test(username)) throw bad("登录名为 4-40 位字母、数字或 @ . - _");
    if (password.length < 8) throw bad("密码至少 8 位");
    if (!ptype.length) throw bad("请选择客商类型");
    const out = E.tx(() => {
      if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) throw bad("登录名已被占用");
      const data = { name: String(b.company || "").trim().slice(0, 100), credit_code: String(b.credit_code || "").trim(), ptype, region: b.region === "国外" ? "国外" : "国内",
        contact: String(b.contact || "").trim().slice(0, 40), phone: String(b.phone || "").trim().slice(0, 40), locked: false };
      if (!data.contact || !data.phone) throw bad("请填写联系人和联系电话");
      HK.hooks.partner.beforeSave({ db, user: null }, data, null);
      const now = nowBJ();
      const uid = db.prepare("INSERT INTO users (username, name, password, roles, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(username, data.contact, hashPassword(password), JSON.stringify(["portal"]), now, now).lastInsertRowid;
      const pr = E.insertRaw("partner", data, { user: { id: Number(uid), dept: "" } });
      db.prepare("UPDATE users SET partner_id = ? WHERE id = ?").run(pr.id, uid);
      E.log(pr.id, { id: Number(uid), name: data.contact }, "门户注册", "客商自助申请建档");
      E.notify({ role: "risk", title: `新客商注册待准入:${data.name}`, record_id: pr.id });
      return db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
    });
    return sendJson(res, { user: userObj(out) }, 200, { "Set-Cookie": issue(out) });
  }
  if (p === "/api/public-meta" && M === "GET") return sendJson(res, { company: getSettings(db).companyName, partnerTypes: PARTNER_TYPES.filter(t => t !== "内部组织") });

  // ----- 需登录 -----
  const user = currentUser(req);
  if (!user) throw new HttpError(401, "请先登录");

  if (p === "/api/me" && M === "GET") return sendJson(res, { user });
  if (p === "/api/password" && M === "POST") {
    const b = await json(req);
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
    if (!verifyPassword(String(b.old || ""), row.password)) throw bad("原密码错误");
    if (String(b.new || "").length < 8) throw bad("新密码至少 8 位");
    db.prepare("UPDATE users SET password = ?, token_ver = token_ver + 1, updated_at = ? WHERE id = ?").run(hashPassword(b.new), nowBJ(), user.id);
    const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
    return sendJson(res, { ok: true }, 200, { "Set-Cookie": issue(fresh) });
  }
  if (p === "/api/meta" && M === "GET") {
    const s = getSettings(db);
    const portalTypes = isPortal(user) ? [...E.portalTypes(user)] : null;
    return sendJson(res, {
      entities: resolvedMeta(), roles: ROLES, reports: isPortal(user) ? {} : REPORTS, status: STATUS, partnerTypes: PARTNER_TYPES, portalAccess: PORTAL_ACCESS,
      portalTypes, pushdown: PUSHDOWN_TARGETS, settings: { companyName: s.companyName, orgs: s.orgs, depts: s.depts }, lookup: lookupProvider(),
    });
  }
  if (p === "/api/dashboard" && M === "GET") {
    const todo = isPortal(user) ? [] : db.prepare("SELECT * FROM records WHERE status = 'pending' ORDER BY id DESC").all()
      .map(r => ({ ...r, steps: JSON.parse(r.steps) })).filter(r => hasRole(user, r.steps[r.step]))
      .map(r => ({ id: r.id, type: r.type, no: r.no, title: r.title, role: r.steps[r.step], updated_at: r.updated_at }));
    const mine = db.prepare("SELECT id, type, no, title, status, updated_at FROM records WHERE created_by = ? AND status IN ('draft', 'rejected', 'pending') ORDER BY id DESC LIMIT 20").all(user.id);
    let stats = null;
    if (!isPortal(user)) {
      const one = sql => db.prepare(sql).get().n;
      stats = {
        partners: one("SELECT COUNT(*) AS n FROM records WHERE type = 'partner' AND status = 'approved'"),
        locked: one("SELECT COUNT(*) AS n FROM records WHERE type = 'partner' AND json_extract(data, '$.locked') = 1"),
        contracts: one("SELECT COUNT(*) AS n FROM records WHERE type = 'contract' AND status = 'approved' AND json_extract(data, '$.closed') IS NOT 1"),
        risk: one("SELECT COUNT(*) AS n FROM records WHERE type = 'risk_event' AND json_extract(data, '$.state') = '待处理'"),
        unclaimed: one("SELECT COUNT(*) AS n FROM records WHERE type = 'payment' AND status = 'approved' AND json_extract(data, '$.kind') = '收款' AND json_extract(data, '$.claimed') + 0.01 < json_extract(data, '$.amount_cny')"),
      };
    }
    return sendJson(res, { todo, mine, stats, notifications: notificationsFor(user, false) });
  }
  if (p === "/api/notifications" && M === "GET") return sendJson(res, notificationsFor(user, q.get("all") === "1"));
  if (p === "/api/notifications/read" && M === "POST") {
    const b = await json(req);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean);
    const mine = new Set(notificationsFor(user, true).items.map(n => n.id));
    const upd = db.prepare("UPDATE notifications SET read_at = ? WHERE id = ?");
    for (const id of b.all ? [...mine] : ids) if (mine.has(id)) upd.run(nowBJ(), id);
    return sendJson(res, { ok: true });
  }

  // 单据
  let m = p.match(/^\/api\/goto\/(\d+)$/);
  if (m && M === "GET") {
    const rec = E.must(m[1]);
    if (!E.canSee(user, rec)) throw new HttpError(404, "单据不存在");
    return sendJson(res, { type: rec.type, id: rec.id });
  }
  m = p.match(/^\/api\/records\/(\w+)$/);
  if (m && M === "GET") return sendJson(res, listRecords(user, m[1], q));
  if (m && M === "POST") {
    const b = await json(req);
    const rec = E.save(user, m[1], null, b.data || {});
    return sendJson(res, detail(user, E.load(rec.id)));
  }
  m = p.match(/^\/api\/records\/(\w+)\/(\d+)$/);
  if (m) {
    const rec = E.must(m[2], m[1]);
    if (M === "GET") return sendJson(res, detail(user, rec));
    if (M === "PUT") {
      const b = await json(req);
      E.save(user, m[1], rec.id, b.data || {});
      return sendJson(res, detail(user, E.load(rec.id)));
    }
    if (M === "DELETE") {
      if (!E.canSee(user, rec)) throw new HttpError(404, "单据不存在");
      if (!["draft", "rejected"].includes(rec.status) && !(ENTITIES[rec.type].noApproval && false)) throw bad("只能删除草稿,已生效单据请作废");
      if (rec.created_by !== user.id && !hasRole(user, "admin")) throw new HttpError(403, "只能删除自己创建的草稿");
      if (rec.version > 1) throw bad("变更中的单据不能删除");
      E.tx(() => {
        for (const a of db.prepare("SELECT stored FROM attachments WHERE record_id = ?").all(rec.id)) fs.rmSync(path.join(FILES_DIR, a.stored), { force: true });
        db.prepare("DELETE FROM attachments WHERE record_id = ?").run(rec.id);
        db.prepare("DELETE FROM records WHERE id = ?").run(rec.id);
        db.prepare("DELETE FROM record_logs WHERE record_id = ?").run(rec.id);
      });
      return sendJson(res, { ok: true });
    }
  }
  m = p.match(/^\/api\/records\/(\w+)\/(\d+)\/actions\/(\w+)$/);
  if (m && M === "POST") {
    const rec = E.must(m[2], m[1]);
    const b = await json(req);
    const { message } = E.runAction(user, rec, m[3], b);
    const fresh = E.load(rec.id);
    return sendJson(res, { ...(E.canSee(user, fresh) ? detail(user, fresh) : {}), message: message || "" });
  }
  m = p.match(/^\/api\/records\/(\w+)\/(\d+)\/versions$/);
  if (m && M === "GET") {
    const rec = E.must(m[2], m[1]);
    if (!E.canSee(user, rec)) throw new HttpError(404, "单据不存在");
    needInternal(user);
    return sendJson(res, { versions: db.prepare("SELECT version, data, created_at FROM record_versions WHERE record_id = ? ORDER BY version").all(rec.id).map(v => ({ ...v, data: JSON.parse(v.data) })), current: rec.data });
  }
  m = p.match(/^\/api\/records\/(\w+)\/(\d+)\/attachments$/);
  if (m && M === "POST") {
    const rec = E.must(m[2], m[1]);
    if (!E.canSee(user, rec)) throw new HttpError(404, "单据不存在");
    if (rec.status === "cancelled") throw bad("已作废的单据不能上传附件");
    const cats = ENTITIES[rec.type].attachments?.categories || ["其他"];
    const category = String(q.get("category") || "");
    if (!cats.includes(category)) throw bad("附件类别不正确");
    const filename = String(q.get("name") || "file").replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 120);
    const buf = await readBody(req, MAX_FILE);
    if (!buf.length) throw bad("文件为空");
    const ext = path.extname(filename).toLowerCase().replace(/[^.\w]/g, "").slice(0, 10);
    const stored = `${rec.id}/${crypto.randomBytes(12).toString("hex")}${ext}`;
    fs.mkdirSync(path.join(FILES_DIR, String(rec.id)), { recursive: true });
    fs.writeFileSync(path.join(FILES_DIR, stored), buf);
    E.tx(() => {
      db.prepare("INSERT INTO attachments (record_id, category, filename, stored, size, uploaded_by, uploader_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(rec.id, category, filename, stored, buf.length, user.id, user.partner_name ? `${user.name}(${user.partner_name})` : user.name, nowBJ());
      E.log(rec.id, user, "上传附件", `${category}:${filename}`);
      HK.hooks[rec.type]?.onAttachment?.({ db, user, engine: E }, E.load(rec.id));
    });
    return sendJson(res, detail(user, E.load(rec.id)));
  }
  m = p.match(/^\/api\/attachments\/(\d+)$/);
  if (m) {
    const a = db.prepare("SELECT * FROM attachments WHERE id = ?").get(Number(m[1]));
    if (!a) throw new HttpError(404, "附件不存在");
    const rec = E.load(a.record_id);
    if (!rec || !E.canSee(user, rec)) throw new HttpError(404, "附件不存在");
    if (M === "GET") {
      const file = path.join(FILES_DIR, a.stored);
      if (!fs.existsSync(file)) throw new HttpError(404, "文件已丢失");
      const inline = /\.(pdf|png|jpe?g|gif|webp)$/i.test(a.filename) && q.get("download") !== "1";
      const type = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[path.extname(a.filename).toLowerCase()] || "application/octet-stream";
      return send(res, 200, fs.readFileSync(file), { "Content-Type": inline ? type : "application/octet-stream", "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.filename)}`, "Cache-Control": "private, no-store" });
    }
    if (M === "DELETE") {
      if (a.uploaded_by !== user.id && !hasRole(user, "admin")) throw new HttpError(403, "只能删除自己上传的附件");
      if (ENTITIES[rec.type].approval && ["pending", "approved"].includes(rec.status)) throw bad("审批中或已生效的单据不能删除附件");
      E.tx(() => {
        db.prepare("DELETE FROM attachments WHERE id = ?").run(a.id);
        E.log(rec.id, user, "删除附件", `${a.category}:${a.filename}`);
        HK.hooks[rec.type]?.onAttachment?.({ db, user, engine: E }, E.load(rec.id));
      });
      fs.rmSync(path.join(FILES_DIR, a.stored), { force: true });
      return sendJson(res, { ok: true });
    }
  }

  m = p.match(/^\/api\/options\/(\w+)$/);
  if (m && M === "GET") {
    const type = m[1];
    if (!ENTITIES[type]) throw new HttpError(404, "单据类型不存在");
    const kw = String(q.get("q") || "").trim().slice(0, 50);
    let filter = {};
    try {
      filter = JSON.parse(q.get("filter") || "{}") || {};
    } catch {}
    const args = [type];
    let where = "type = ? AND status != 'cancelled'";
    if (q.get("approved") === "1") where += " AND status = 'approved'";
    if (kw) where += " AND (no LIKE ? OR title LIKE ?)", args.push(`%${kw}%`, `%${kw}%`);
    const rows = db.prepare(`SELECT * FROM records WHERE ${where} ORDER BY id DESC LIMIT 300`).all(...args).map(r => ({ ...r, data: JSON.parse(r.data), steps: [] }))
      .filter(r => E.canSee(user, r))
      .filter(r => Object.entries(filter).every(([k, v]) => {
        const val = r.data[k];
        return Array.isArray(v) ? (Array.isArray(val) ? val.some(x => v.includes(x)) : v.includes(val)) : val === v;
      }))
      .slice(0, 50);
    return sendJson(res, { items: rows.map(r => ({ id: r.id, label: r.type === "partner" ? r.data.name : E.label(r), status: r.status, locked: !!r.data.locked })) });
  }

  if (p === "/api/pushdown" && M === "GET") {
    needInternal(user);
    const from = E.must(q.get("from"));
    const to = String(q.get("to") || "");
    if (!(PUSHDOWN_TARGETS[from.type] || []).includes(to)) throw bad("不支持该下推");
    return sendJson(res, { data: pushdown(E, C, from, to, user) });
  }

  m = p.match(/^\/api\/reports\/(\w+)$/);
  if (m && M === "GET") {
    needInternal(user);
    return sendJson(res, runReport(m[1], Object.fromEntries(q)));
  }
  m = p.match(/^\/api\/dossier\/(\d+)$/);
  if (m && M === "GET") {
    needInternal(user);
    return sendJson(res, dossier(m[1]));
  }
  m = p.match(/^\/api\/archive\/(\d+)$/);
  if (m && M === "GET") {
    needInternal(user);
    const d = dossier(m[1]);
    const files = [], seen = new Set();
    for (const a of d.attachments) {
      const row = db.prepare("SELECT stored FROM attachments WHERE id = ?").get(a.id);
      const file = path.join(FILES_DIR, row.stored);
      if (!fs.existsSync(file)) continue;
      let name = `${ENTITIES[a.type]?.label || a.type}/${a.no}_${a.category}_${a.filename}`;
      while (seen.has(name)) name = name.replace(/(\.\w+)?$/, "_1$1");
      seen.add(name);
      files.push({ name, data: fs.readFileSync(file) });
    }
    if (!files.length) throw bad("该合同及下游单据还没有附件");
    return send(res, 200, makeZip(files), { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`合同归档_${d.contract.no}.zip`)}` });
  }

  if (p === "/api/import" && M === "POST") {
    needInternal(user);
    const b = await json(req);
    const type = String(b.type || "");
    if (!["blacklist", "market_price"].includes(type)) throw bad("只支持导入黑名单、市场行情");
    const lines = String(b.text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 2000);
    let ok = 0;
    const errors = [];
    for (const [i, l] of lines.entries()) {
      const c = l.split(/[,\t,]/).map(x => x.trim());
      const data = type === "blacklist"
        ? { name: c[0], credit_code: c[1] || "", source: ["集团下发", "外部数据", "内部认定"].includes(c[3]) ? c[3] : "集团下发", reason: c[2] || "", active: true }
        : { product: c[0], date: c[1], kind: ["期货", "现货", "指数"].includes(c[2]) ? c[2] : "现货", price: Number(c[3]), contract_month: c[4] || "", source: c[5] || "导入" };
      try {
        E.save(user, type, null, data);
        ok++;
      } catch (e) {
        errors.push(`第 ${i + 1} 行:${e.message}`);
      }
    }
    return sendJson(res, { ok, errors: errors.slice(0, 50) });
  }

  // 工商信息
  if (p === "/api/lookup/search" && M === "GET") {
    needInternal(user);
    return sendJson(res, { items: await searchCompanies(String(q.get("q") || "").slice(0, 60)) });
  }
  m = p.match(/^\/api\/lookup\/scan\/(\d+)$/);
  if (m && M === "POST") {
    needInternal(user);
    return sendJson(res, await riskScan(user, m[1]));
  }

  // 用户与设置
  if (p === "/api/users" && M === "GET") {
    needRole(user, "admin");
    return sendJson(res, { items: db.prepare("SELECT id, username, name, roles, dept, partner_id, enabled, created_at FROM users ORDER BY id").all().map(u => ({ ...u, roles: JSON.parse(u.roles), partner_name: u.partner_id ? E.load(u.partner_id)?.data.name : null })) });
  }
  if (p === "/api/users" && M === "POST") {
    needRole(user, "admin");
    const b = await json(req);
    const roles = (b.roles || []).filter(r => ROLES[r] && r !== "portal");
    if (!/^[\w@.-]{3,40}$/.test(String(b.username || ""))) throw bad("登录名为 3-40 位字母、数字或 @ . - _");
    if (!b.name) throw bad("请填写姓名");
    if (!roles.length) throw bad("请至少选择一个角色");
    if (String(b.password || "").length < 8) throw bad("初始密码至少 8 位");
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(b.username)) throw bad("登录名已存在");
    db.prepare("INSERT INTO users (username, name, password, roles, dept, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(b.username, String(b.name).slice(0, 40), hashPassword(b.password), JSON.stringify(roles), String(b.dept || ""), nowBJ(), nowBJ());
    return sendJson(res, { ok: true });
  }
  m = p.match(/^\/api\/users\/(\d+)$/);
  if (m && M === "PUT") {
    needRole(user, "admin");
    const b = await json(req);
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(m[1]));
    if (!u) throw new HttpError(404, "用户不存在");
    const isP = JSON.parse(u.roles).includes("portal");
    const roles = isP ? ["portal"] : (b.roles || []).filter(r => ROLES[r] && r !== "portal");
    if (!roles.length) throw bad("请至少选择一个角色");
    if (u.id === user.id && (!roles.includes("admin") || b.enabled === false)) throw bad("不能取消自己的管理员权限或停用自己");
    db.prepare("UPDATE users SET name = ?, roles = ?, dept = ?, enabled = ?, token_ver = token_ver + ?, updated_at = ? WHERE id = ?")
      .run(String(b.name || u.name).slice(0, 40), JSON.stringify(roles), String(b.dept ?? u.dept), b.enabled === false ? 0 : 1, b.enabled === false ? 1 : 0, nowBJ(), u.id);
    if (b.password) {
      if (String(b.password).length < 8) throw bad("密码至少 8 位");
      db.prepare("UPDATE users SET password = ?, token_ver = token_ver + 1 WHERE id = ?").run(hashPassword(b.password), u.id);
    }
    return sendJson(res, { ok: true });
  }
  if (p === "/api/settings" && M === "GET") {
    needInternal(user);
    return sendJson(res, { settings: getSettings(db), defaults: DEFAULT_SETTINGS });
  }
  if (p === "/api/settings" && M === "PUT") {
    needRole(user, "admin");
    const b = await json(req);
    const s = b.settings || {};
    const arr = v => (Array.isArray(v) ? v : String(v || "").split(/[,,\n]/)).map(x => String(x).trim()).filter(Boolean).slice(0, 50);
    const patch = {};
    if ("companyName" in s) patch.companyName = String(s.companyName).trim().slice(0, 60) || DEFAULT_SETTINGS.companyName;
    if ("orgs" in s) patch.orgs = arr(s.orgs);
    if ("depts" in s) patch.depts = arr(s.depts);
    if ("dedupRules" in s) patch.dedupRules = arr(s.dedupRules).filter(r => ["creditCode", "name", "bankAccount", "phone"].includes(r));
    if ("defaultDailyRate" in s) {
      const r = Number(s.defaultDailyRate);
      if (!(r >= 0 && r < 0.01)) throw bad("日利率需在 0 ~ 0.01 之间");
      patch.defaultDailyRate = r;
    }
    if ("marginCallThreshold" in s) patch.marginCallThreshold = Math.max(0, Number(s.marginCallThreshold) || 0);
    if ("requiredAttachments" in s) {
      const ra = {};
      for (const [t, cats] of Object.entries(s.requiredAttachments || {})) {
        const all = ENTITIES[t]?.attachments?.categories;
        if (all) ra[t] = arr(cats).filter(c => all.includes(c));
      }
      patch.requiredAttachments = ra;
    }
    if (patch.orgs && !patch.orgs.length) throw bad("至少保留一个签约主体");
    saveSettings(db, patch);
    return sendJson(res, { settings: getSettings(db) });
  }

  throw new HttpError(404, "接口不存在");
}

http.createServer((req, res) => {
  handle(req, res).catch(err => {
    const known = err instanceof HttpError || err instanceof LookupError;
    if (!known) console.error(new Date().toISOString(), req.method, req.url, err);
    if (res.headersSent) return res.end();
    sendJson(res, { error: known ? err.message : "服务器开小差了,请稍后再试" }, err instanceof HttpError ? err.status : err instanceof LookupError ? 400 : 500);
  });
}).listen(PORT, HOST, () => console.log(`[trade-erp] listening on ${HOST}:${PORT}, data ${DATA_DIR}`));
