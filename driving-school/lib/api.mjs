// 接口路由。/api/public/* 给学员手机端(无需登录,凭报名 token 访问自己的单据);
// /api/admin/* 给管理后台(需登录 Cookie)。
import crypto from "node:crypto";
import { HttpError, nowBJ, parseIdCard, ageOn, rateLimiter, maskIdCard, maskPhone } from "./util.mjs";
import { getSettings, saveSettings, PAY_MODES } from "./db.mjs";
import { renderContract, renderTerms, termVars } from "./contract.mjs";

export const STATUS = { pending: "待付款", paid: "已付款", cancelled: "已取消" };
const PAY_METHOD = { mock: "在线支付(演示)", offline: "线下收款" };

const text = (v, max) => String(v ?? "").trim().slice(0, max);

export function buildRoutes(db, auth) {
  const routes = [];
  const add = (method, pattern, handler, admin = false) =>
    routes.push({ method, admin, handler, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$") });

  const registerLimit = rateLimiter(20, 3600e3);
  const lookupLimit = rateLimiter(20, 3600e3);
  const loginLimit = rateLimiter(10, 900e3);

  const courseById = id => db.prepare("SELECT * FROM courses WHERE id = ?").get(Number(id) || 0);
  const regById = id => db.prepare("SELECT * FROM registrations WHERE id = ?").get(Number(id) || 0);
  const regByToken = t => (/^[0-9a-f]{32}$/.test(t) ? db.prepare("SELECT * FROM registrations WHERE token = ?").get(t) : undefined);

  const courseView = c => ({
    id: c.id, name: c.name, licenseClass: c.license_class, description: c.description,
    priceFen: c.price_fen, minAge: c.min_age, enabled: !!c.enabled, sort: c.sort,
  });
  const orderView = r => ({
    token: r.token, name: r.name, phone: maskPhone(r.phone), idCard: maskIdCard(r.id_card),
    courseName: r.course_name, licenseClass: r.license_class, priceFen: r.price_fen,
    status: r.status, statusText: STATUS[r.status], cancelReason: r.cancel_reason,
    payMethod: r.pay_method, payMethodText: PAY_METHOD[r.pay_method] || "", paidAt: r.paid_at,
    contractNo: r.contract_no, createdAt: r.created_at,
  });
  const adminView = r => ({
    id: r.id, token: r.token, name: r.name, gender: r.gender, idCard: r.id_card, birthDate: r.birth_date,
    phone: r.phone, address: r.address, courseId: r.course_id, courseName: r.course_name, licenseClass: r.license_class,
    priceFen: r.price_fen, status: r.status, statusText: STATUS[r.status], cancelReason: r.cancel_reason,
    payMethod: r.pay_method, payMethodText: PAY_METHOD[r.pay_method] || "", payNo: r.pay_no, paidAt: r.paid_at,
    contractNo: r.contract_no, createdAt: r.created_at,
  });

  // 付款成功:写入付款信息并生成合同快照(只对待付款单据生效,防止重复付款)
  function markPaid(r, method, payNo) {
    const paidAt = nowBJ();
    const contractNo = `DS${paidAt.slice(0, 10).replace(/-/g, "")}${String(r.id).padStart(6, "0")}`;
    const html = renderContract({ ...r, pay_method: method, pay_no: payNo, paid_at: paidAt, contract_no: contractNo }, getSettings(db));
    const res = db.prepare(`UPDATE registrations SET status = 'paid', pay_method = ?, pay_no = ?, paid_at = ?, contract_no = ?,
      contract_html = ?, updated_at = ? WHERE id = ? AND status = 'pending'`).run(method, payNo, paidAt, contractNo, html, paidAt, r.id);
    if (!res.changes) throw new HttpError(409, "该报名状态已变化,请刷新后重试");
  }

  // ---------------- 学员手机端 ----------------
  add("GET", "/api/health", () => ({ ok: true }));

  add("GET", "/api/public/info", () => {
    const s = getSettings(db);
    const courses = db.prepare("SELECT * FROM courses WHERE enabled = 1 ORDER BY sort DESC, id").all().map(courseView);
    return {
      school: { name: s.schoolName, address: s.schoolAddress, phone: s.schoolPhone, notice: s.notice },
      payMode: s.payMode, payModeText: PAY_MODES[s.payMode], courses,
    };
  });

  add("GET", "/api/public/contract-preview", ({ query }) => {
    const c = courseById(query.get("courseId"));
    if (!c || !c.enabled) throw new HttpError(400, "请选择报名课程");
    const s = getSettings(db);
    const r = { name: text(query.get("name"), 30) || "(学员)", course_name: c.name, license_class: c.license_class, price_fen: c.price_fen };
    return { schoolName: s.schoolName, html: renderTerms(s.contractTerms, termVars(r, s)) };
  });

  add("POST", "/api/public/register", ({ body, ip }) => {
    if (!registerLimit(ip)) throw new HttpError(429, "提交过于频繁,请稍后再试");
    const name = text(body.name, 30);
    if (!/^[一-龥·A-Za-z ]{2,30}$/.test(name)) throw new HttpError(400, "请填写身份证上的真实姓名");
    const idc = parseIdCard(body.idCard);
    if (!idc) throw new HttpError(400, "身份证号码不正确,请核对");
    const phone = text(body.phone, 11);
    if (!/^1\d{10}$/.test(phone)) throw new HttpError(400, "手机号码不正确");
    const address = text(body.address, 100);
    if (address.length < 4) throw new HttpError(400, "请填写详细住址");
    const course = courseById(body.courseId);
    if (!course || !course.enabled) throw new HttpError(400, "请选择报名课程");
    const age = ageOn(idc.birth, nowBJ().slice(0, 10));
    if (age < course.min_age) throw new HttpError(400, `报名${course.name}需年满 ${course.min_age} 周岁(您现在 ${age} 周岁)`);
    const signature = String(body.signature ?? "");
    if (signature.length > 400_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(signature)) throw new HttpError(400, "请完成手写签名");
    if (body.agree !== true) throw new HttpError(400, "请阅读并同意培训合同条款");
    if (db.prepare("SELECT 1 FROM registrations WHERE id_card = ? AND course_id = ? AND status = 'paid'").get(idc.id, course.id)) {
      throw new HttpError(409, `该身份证已报名并缴费「${course.name}」,如需帮助请联系驾校`);
    }

    const now = nowBJ();
    const token = crypto.randomBytes(16).toString("hex");
    // 同一人同一课程只保留最新一张待付款单
    db.prepare(`UPDATE registrations SET status = 'cancelled', cancel_reason = '重复报名,已由新的报名替代', updated_at = ?
      WHERE id_card = ? AND course_id = ? AND status = 'pending'`).run(now, idc.id, course.id);
    db.prepare(`INSERT INTO registrations (token, name, gender, id_card, birth_date, phone, address, course_id, course_name,
      license_class, price_fen, signature, client_ip, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(token, name, idc.gender, idc.id, idc.birth, phone, address, course.id, course.name, course.license_class,
        course.price_fen, signature, ip, now, now);
    return { token };
  });

  add("GET", "/api/public/orders/:token", ({ params }) => {
    const r = regByToken(params.token);
    if (!r) throw new HttpError(404, "报名记录不存在");
    const s = getSettings(db);
    return { order: orderView(r), payMode: s.payMode, school: { name: s.schoolName, phone: s.schoolPhone, address: s.schoolAddress } };
  });

  add("POST", "/api/public/orders/:token/pay", ({ params }) => {
    const r = regByToken(params.token);
    if (!r) throw new HttpError(404, "报名记录不存在");
    if (r.status === "paid") return { order: orderView(r) };
    if (r.status !== "pending") throw new HttpError(400, "该报名已取消,请重新报名");
    if (getSettings(db).payMode !== "mock") throw new HttpError(400, "当前不支持在线支付,请到驾校前台缴费");
    markPaid(r, "mock", "MOCK" + nowBJ().replace(/\D/g, "") + crypto.randomBytes(3).toString("hex").toUpperCase());
    return { order: orderView(regById(r.id)) };
  });

  add("POST", "/api/public/lookup", ({ body, ip }) => {
    if (!lookupLimit(ip)) throw new HttpError(429, "查询过于频繁,请稍后再试");
    const phone = text(body.phone, 11), tail = text(body.idTail, 6).toUpperCase();
    if (!/^1\d{10}$/.test(phone) || !/^\d{5}[\dX]$/.test(tail)) throw new HttpError(400, "请填写报名手机号和身份证后 6 位");
    const rows = db.prepare(`SELECT * FROM registrations WHERE phone = ? AND substr(id_card, -6) = ? AND status != 'cancelled'
      ORDER BY id DESC LIMIT 20`).all(phone, tail);
    return { orders: rows.map(orderView) };
  });

  // ---------------- 管理后台 ----------------
  add("POST", "/api/admin/login", ({ body, ip, setHeader }) => {
    if (!auth.enabled) throw new HttpError(503, "未配置管理员密码,请在服务器 /etc/driving-school.env 设置 DS_ADMIN_PASSWORD");
    if (!loginLimit(ip)) throw new HttpError(429, "密码错误次数过多,请 15 分钟后再试");
    if (!auth.checkPassword(String(body.password ?? ""))) throw new HttpError(401, "密码错误");
    setHeader("Set-Cookie", auth.issueCookie());
    return { ok: true };
  });
  add("POST", "/api/admin/logout", ({ setHeader }) => {
    setHeader("Set-Cookie", auth.clearCookie());
    return { ok: true };
  });
  add("GET", "/api/admin/me", () => ({ ok: true }), true);

  add("GET", "/api/admin/stats", () => {
    const today = nowBJ().slice(0, 10);
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    return {
      total: one("SELECT COUNT(*) AS n FROM registrations WHERE status != 'cancelled'").n,
      pending: one("SELECT COUNT(*) AS n FROM registrations WHERE status = 'pending'").n,
      paid: one("SELECT COUNT(*) AS n FROM registrations WHERE status = 'paid'").n,
      today: one("SELECT COUNT(*) AS n FROM registrations WHERE status != 'cancelled' AND created_at >= ?", today).n,
      todayPaidFen: one("SELECT COALESCE(SUM(price_fen), 0) AS s FROM registrations WHERE status = 'paid' AND paid_at >= ?", today).s,
      revenueFen: one("SELECT COALESCE(SUM(price_fen), 0) AS s FROM registrations WHERE status = 'paid'").s,
      byCourse: db.prepare(`SELECT course_name AS name, COUNT(*) AS total, SUM(status = 'paid') AS paid,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN price_fen END), 0) AS revenueFen
        FROM registrations WHERE status != 'cancelled' GROUP BY course_name ORDER BY total DESC`).all(),
    };
  }, true);

  function listWhere(query) {
    const where = [], args = [];
    const status = query.get("status");
    if (status && STATUS[status]) where.push("status = ?") && args.push(status);
    const courseId = Number(query.get("courseId"));
    if (courseId) where.push("course_id = ?") && args.push(courseId);
    const q = text(query.get("q"), 30);
    if (q) {
      where.push("(name LIKE ? OR phone LIKE ? OR id_card LIKE ? OR contract_no LIKE ?)");
      args.push(...Array(4).fill(`%${q}%`));
    }
    return { sql: where.length ? "WHERE " + where.join(" AND ") : "", args };
  }

  add("GET", "/api/admin/registrations", ({ query }) => {
    const { sql, args } = listWhere(query);
    const page = Math.max(1, Number(query.get("page")) || 1), size = 20;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM registrations ${sql}`).get(...args).n;
    const rows = db.prepare(`SELECT * FROM registrations ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
    return { total, page, size, items: rows.map(adminView) };
  }, true);

  add("GET", "/api/admin/registrations/:id", ({ params }) => {
    const r = regById(params.id);
    if (!r) throw new HttpError(404, "报名记录不存在");
    return { item: { ...adminView(r), signature: r.signature } };
  }, true);

  add("POST", "/api/admin/registrations/:id/confirm-payment", ({ params, body }) => {
    const r = regById(params.id);
    if (!r) throw new HttpError(404, "报名记录不存在");
    if (r.status !== "pending") throw new HttpError(400, `该报名${STATUS[r.status]},不能确认收款`);
    markPaid(r, "offline", text(body.payNo, 40) || "OFFLINE" + nowBJ().replace(/\D/g, ""));
    return { item: adminView(regById(r.id)) };
  }, true);

  add("POST", "/api/admin/registrations/:id/cancel", ({ params, body }) => {
    const r = regById(params.id);
    if (!r) throw new HttpError(404, "报名记录不存在");
    if (r.status !== "pending") throw new HttpError(400, "只有待付款的报名可以取消");
    db.prepare("UPDATE registrations SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(text(body.reason, 100) || "后台取消", nowBJ(), r.id);
    return { item: adminView(regById(r.id)) };
  }, true);

  add("GET", "/api/admin/export.csv", ({ query }) => {
    const { sql, args } = listWhere(query);
    const rows = db.prepare(`SELECT * FROM registrations ${sql} ORDER BY id DESC`).all(...args);
    const head = ["报名时间", "姓名", "性别", "身份证号", "出生日期", "手机号", "住址", "课程", "准驾车型", "金额(元)", "状态", "付款方式", "流水号", "付款时间", "合同编号"];
    const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = rows.map(r => [r.created_at, r.name, r.gender, "\t" + r.id_card, r.birth_date, "\t" + r.phone, r.address, r.course_name,
      r.license_class, (r.price_fen / 100).toFixed(2), STATUS[r.status], PAY_METHOD[r.pay_method] || "", r.pay_no, r.paid_at, r.contract_no].map(cell).join(","));
    return {
      raw: "﻿" + [head.map(cell).join(","), ...lines].join("\r\n"),
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`报名学员-${nowBJ().slice(0, 10)}.csv`)}` },
    };
  }, true);

  add("GET", "/api/admin/courses", () => ({
    items: db.prepare("SELECT * FROM courses ORDER BY sort DESC, id").all().map(courseView),
  }), true);

  function courseInput(body) {
    const name = text(body.name, 20), licenseClass = text(body.licenseClass, 60), description = text(body.description, 300);
    const price = Number(body.price), minAge = Number(body.minAge), sort = Number(body.sort) || 0;
    if (!name) throw new HttpError(400, "请填写课程名称");
    if (!licenseClass) throw new HttpError(400, "请填写准驾车型");
    if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) throw new HttpError(400, "价格需在 0.01 ~ 1,000,000 元之间");
    if (!Number.isInteger(minAge) || minAge < 16 || minAge > 70) throw new HttpError(400, "最低年龄需是 16 ~ 70 的整数");
    return { name, licenseClass, description, priceFen: Math.round(price * 100), minAge, sort, enabled: body.enabled === false ? 0 : 1 };
  }

  add("POST", "/api/admin/courses", ({ body }) => {
    const c = courseInput(body), now = nowBJ();
    const { lastInsertRowid } = db.prepare(`INSERT INTO courses (name, license_class, description, price_fen, min_age, enabled, sort, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.name, c.licenseClass, c.description, c.priceFen, c.minAge, c.enabled, c.sort, now, now);
    return { item: courseView(courseById(lastInsertRowid)) };
  }, true);

  add("PUT", "/api/admin/courses/:id", ({ params, body }) => {
    if (!courseById(params.id)) throw new HttpError(404, "课程不存在");
    const c = courseInput(body);
    db.prepare(`UPDATE courses SET name = ?, license_class = ?, description = ?, price_fen = ?, min_age = ?, enabled = ?, sort = ?, updated_at = ?
      WHERE id = ?`).run(c.name, c.licenseClass, c.description, c.priceFen, c.minAge, c.enabled, c.sort, nowBJ(), Number(params.id));
    return { item: courseView(courseById(params.id)) };
  }, true);

  add("GET", "/api/admin/settings", () => ({ settings: getSettings(db), payModes: PAY_MODES }), true);

  add("PUT", "/api/admin/settings", ({ body }) => {
    const patch = {
      schoolName: text(body.schoolName, 40), schoolAddress: text(body.schoolAddress, 100), schoolPhone: text(body.schoolPhone, 40),
      notice: text(body.notice, 500), payMode: String(body.payMode ?? ""), contractTerms: String(body.contractTerms ?? "").trim().slice(0, 20000),
    };
    if (!patch.schoolName) throw new HttpError(400, "请填写驾校名称");
    if (!PAY_MODES[patch.payMode]) throw new HttpError(400, "付款方式不正确");
    if (patch.contractTerms.length < 20) throw new HttpError(400, "合同条款不能为空");
    saveSettings(db, patch);
    return { settings: getSettings(db) };
  }, true);

  return routes;
}
