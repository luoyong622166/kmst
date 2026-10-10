// 实施管理接口:项目接收与分配、阶段汇报与文档、延期方案、数字总监、问题清单
import { HttpError } from "./errors.mjs";
import { nextSerialNo, tx } from "./db.mjs";
import { extractText, filePath, MAX_UPLOAD, removeFile, saveFile } from "./files.mjs";
import {
  applyReviewOutcome,
  askDirector,
  buildIssueList,
  daysBetween,
  DIRECTOR_NAME,
  getSetting,
  IMPL_STAGES,
  notify,
  queueReview,
  runPatrol,
  setSetting,
  stageLabel,
} from "./director.mjs";
import { nowISO, todayCN } from "./util.mjs";

const PLATFORM_URL = process.env.CRM_PLATFORM_URL || "http://127.0.0.1:3000";
export const ROLES = { director: "实施总监", consultant: "实施顾问", gm: "总经理", sales_manager: "销售经理" };
const STAGE_KEYS = IMPL_STAGES.map(s => s.key);

// ---------- 小工具 ----------
const str = v => (v == null ? null : String(v).trim() || null);
function required(body, field, label) {
  const v = str(body[field]);
  if (!v) throw new HttpError(400, `请填写${label}`);
  return v;
}
function date(v, label) {
  const s = str(v);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, `请填写正确的${label}(YYYY-MM-DD)`);
  return s;
}

// 角色以「团队成员」里设置的为准;平台子账号(openId 以 sub_ 开头)在平台上也是 role=admin,
// 所以只有平台主管理员账号(非子账号)且未被设为成员时,才拥有全部角色
export function rolesOf(db, user) {
  if (user.role === "agent") return new Set(["agent", "director", "gm", "sales_manager"]);
  const m = db.prepare("SELECT role FROM impl_members WHERE user_id = ?").get(user.id);
  if (m) return new Set([m.role]);
  const isOwner = user.role === "admin" && !String(user.openId ?? "").startsWith("sub_");
  return new Set(isOwner ? ["admin", "director", "consultant", "gm", "sales_manager"] : []);
}
export function requireRole(db, user, ...roles) {
  const mine = rolesOf(db, user);
  if (!roles.some(r => mine.has(r))) throw new HttpError(403, `没有权限:需要${roles.map(r => ROLES[r] ?? r).join("或")}角色`);
}
function getProject(db, id) {
  const p = db.prepare("SELECT * FROM impl_projects WHERE id = ?").get(Number(id));
  if (!p) throw new HttpError(404, "项目不存在");
  return p;
}
function requireProjectAccess(db, user, p, { write = false } = {}) {
  const r = rolesOf(db, user);
  if (r.has("director") || p.consultant_id === user.id) return;
  if (!write && r.has("gm")) return;
  throw new HttpError(403, "这不是分配给你的项目");
}

// 调平台 tRPC(带当前用户 Cookie,权限由平台判断)
async function platformTrpc(req, name, input, method = "GET") {
  const headers = { cookie: req.headers.cookie || "" };
  let url = `${PLATFORM_URL}/api/trpc/${name}`;
  let body;
  if (method === "GET") url += `?input=${encodeURIComponent(JSON.stringify({ json: input ?? null }))}`;
  else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ json: input });
  }
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(10_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error?.json?.message || data.error?.message || `HTTP ${res.status}`;
    throw new HttpError(400, `平台账号操作失败:${msg}`);
  }
  return data.result?.data?.json;
}

/** 项目列表/详情共用的进度与超期计算 */
function summarize(db, p, today = todayCN()) {
  const stages = db.prepare("SELECT * FROM impl_stages WHERE project_id = ? ORDER BY seq").all(p.id);
  const done = stages.filter(s => s.status === "done").length;
  const current = stages.find(s => s.status !== "done") ?? null;
  const progress = Math.round((done * 100 + (current?.progress ?? 0)) / STAGE_KEYS.length);
  const finished = p.status === "completed";
  const lastReport = db.prepare("SELECT review_status, report_date FROM impl_reports WHERE project_id = ? ORDER BY id DESC LIMIT 1").get(p.id);
  return {
    ...p,
    stages,
    progress: finished ? 100 : progress,
    current_stage: finished ? null : current?.stage_key ?? null,
    current_stage_due: finished ? null : current?.planned_end ?? null,
    days_left: finished ? null : daysBetween(today, p.planned_end),
    overdue_days: !finished && p.planned_end < today ? daysBetween(p.planned_end, today) : 0,
    stage_overdue_days: !finished && current && current.planned_end < today ? daysBetween(current.planned_end, today) : 0,
    open_delays: db.prepare("SELECT COUNT(*) AS n FROM impl_delays WHERE project_id = ? AND status IN ('awaiting_plan','submitted','rejected')").get(p.id).n,
    open_issues: db.prepare("SELECT COUNT(*) AS n FROM impl_issues WHERE project_id = ? AND status = 'open'").get(p.id).n,
    last_report_date: lastReport?.report_date ?? null,
    last_review_status: lastReport?.review_status ?? null,
  };
}

function parseStageDue(body, start, end) {
  const due = {};
  let prev = start;
  for (const s of IMPL_STAGES) {
    const d = date(body.stage_due?.[s.key], `「${s.label}」要求完成日期`);
    if (d < prev) throw new HttpError(400, `「${s.label}」的完成日期不能早于上一阶段(或项目开始日期)`);
    if (d > end) throw new HttpError(400, `「${s.label}」的完成日期不能晚于项目要求完成日期`);
    due[s.key] = prev = d;
  }
  return due;
}

function delayView(db, d) {
  const p = db.prepare("SELECT name, customer_name, consultant_name, consultant_id FROM impl_projects WHERE id = ?").get(d.project_id);
  return { ...d, stage_label: stageLabel(d.stage_key), overdue_days: daysBetween(d.due_date, todayCN()), project: p };
}

export function registerImplRoutes(db, add) {
  // ===== 基础 =====
  add("GET", "/impl/meta", ({ user }) => ({
    me: { id: user.id, name: user.name },
    roles: [...rolesOf(db, user)],
    stages: IMPL_STAGES,
    directorName: DIRECTOR_NAME,
    agentReady: !!process.env.PLATFORM_INTERNAL_SECRET,
    lastPatrol: getSetting(db, "impl.last_patrol"),
  }));

  // ===== 团队成员与账号 =====
  add("GET", "/impl/members", ({ user }) => {
    requireRole(db, user, "director", "gm");
    return { items: db.prepare("SELECT * FROM impl_members ORDER BY role, name").all() };
  });
  add("GET", "/impl/platform-users", async ({ user, req }) => {
    requireRole(db, user, "director");
    const r = await platformTrpc(req, "permission.userList", { page: 1, pageSize: 100 });
    return { items: (r?.users ?? []).map(u => ({ id: u.id, name: u.name, openId: u.openId, role: u.role })) };
  });
  add("POST", "/impl/members", ({ user, body }) => {
    requireRole(db, user, "director");
    const role = body.role;
    if (!ROLES[role]) throw new HttpError(400, "请选择角色");
    const userId = Number(body.user_id);
    if (!userId) throw new HttpError(400, "请选择平台账号");
    db.prepare(
      "INSERT INTO impl_members (user_id, name, role, created_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, role = excluded.role"
    ).run(userId, required(body, "name", "姓名"), role, nowISO());
    return { ok: true };
  });
  add("POST", "/impl/accounts", async ({ user, body, req }) => {
    requireRole(db, user, "director");
    const role = body.role;
    if (!ROLES[role]) throw new HttpError(400, "请选择角色");
    const username = required(body, "username", "登录账号");
    const password = required(body, "password", "初始密码");
    const name = required(body, "name", "姓名");
    if (password.length < 6) throw new HttpError(400, "初始密码至少 6 位");
    await platformTrpc(req, "permission.createSubAccount", { username, password, name }, "POST");
    const list = await platformTrpc(req, "permission.userList", { page: 1, pageSize: 100 });
    const created = (list?.users ?? []).filter(u => u.name === name).sort((a, b) => b.id - a.id)[0];
    if (!created) throw new HttpError(500, "账号已创建,但没找到它的编号,请在成员列表中手动添加");
    db.prepare(
      "INSERT INTO impl_members (user_id, name, role, created_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, role = excluded.role"
    ).run(created.id, name, role, nowISO());
    return { ok: true, user_id: created.id };
  });
  add("DELETE", "/impl/members/:userId", ({ user, params }) => {
    requireRole(db, user, "director");
    const id = Number(params.userId);
    if (db.prepare("SELECT 1 FROM impl_projects WHERE consultant_id = ? AND status != 'completed'").get(id)) {
      throw new HttpError(400, "该成员还有未完成的项目,请先把项目改派给其他顾问");
    }
    db.prepare("DELETE FROM impl_members WHERE user_id = ?").run(id);
    return { ok: true };
  });

  // ===== 项目分配(实施总监) =====
  add("GET", "/impl/handovers-to-assign", ({ user }) => {
    requireRole(db, user, "director");
    return {
      items: db
        .prepare(
          `SELECT h.id, h.handover_no, h.status, h.handover_date, h.impl_owner, h.modules, c.contract_no, c.project_name, c.amount,
                  c.start_date, c.end_date, o.name AS customer_name
           FROM handovers h JOIN contracts c ON c.id = h.contract_id JOIN opportunities o ON o.id = c.opportunity_id
           LEFT JOIN impl_projects p ON p.handover_id = h.id
           WHERE p.id IS NULL ORDER BY h.id DESC`
        )
        .all()
        .map(r => ({ ...r, modules: JSON.parse(r.modules || "[]") })),
    };
  });
  add("POST", "/impl/projects", ({ user, body }) => {
    requireRole(db, user, "director");
    const h = db
      .prepare(
        `SELECT h.*, c.project_name, o.name AS customer_name FROM handovers h
         JOIN contracts c ON c.id = h.contract_id JOIN opportunities o ON o.id = c.opportunity_id WHERE h.id = ?`
      )
      .get(Number(body.handover_id));
    if (!h) throw new HttpError(404, "交接单不存在");
    if (db.prepare("SELECT 1 FROM impl_projects WHERE handover_id = ?").get(h.id)) throw new HttpError(409, "该交接单已分配过项目");
    const consultant = db.prepare("SELECT * FROM impl_members WHERE user_id = ? AND role = 'consultant'").get(Number(body.consultant_id));
    if (!consultant) throw new HttpError(400, "请选择实施顾问(先在「团队成员」中添加)");
    const start = date(body.planned_start, "计划开始日期");
    const end = date(body.planned_end, "要求完成日期");
    if (end < start) throw new HttpError(400, "要求完成日期不能早于开始日期");
    const due = parseStageDue(body, start, end);
    return tx(db, () => {
      const now = nowISO();
      const no = nextSerialNo(db, "impl_projects", "project_no", "XM", todayCN());
      const r = db
        .prepare(
          `INSERT INTO impl_projects (project_no, handover_id, name, customer_name, consultant_id, consultant_name, assigned_by,
             planned_start, planned_end, status, remark, assigned_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?, 'assigned', ?,?,?)`
        )
        .run(no, h.id, str(body.name) ?? h.project_name, h.customer_name, consultant.user_id, consultant.name, user.name, start, end, str(body.remark), now, now);
      const pid = Number(r.lastInsertRowid);
      const ins = db.prepare("INSERT INTO impl_stages (project_id, stage_key, seq, planned_end) VALUES (?,?,?,?)");
      IMPL_STAGES.forEach((s, i) => ins.run(pid, s.key, i + 1, due[s.key]));
      if (h.status === "pending") {
        db.prepare("UPDATE handovers SET status = 'received', received_by = ?, received_at = ?, received_note = ?, updated_at = ? WHERE id = ?").run(
          user.name, now, `已分配给实施顾问 ${consultant.name}`, now, h.id
        );
      }
      notify(db, {
        recipientId: consultant.user_id,
        type: "assigned",
        title: `新项目待接收:${h.customer_name} · ${str(body.name) ?? h.project_name}`,
        content: `${user.name} 把项目分配给你,要求 ${end} 前完成实施。请进入项目确认接收。`,
        link: `/impl/projects/${pid}`,
      });
      return summarize(db, db.prepare("SELECT * FROM impl_projects WHERE id = ?").get(pid));
    });
  });
  add("PUT", "/impl/projects/:id", ({ user, params, body }) => {
    requireRole(db, user, "director");
    const p = getProject(db, params.id);
    if (p.status === "completed") throw new HttpError(400, "已完成的项目不能修改");
    const consultant = db.prepare("SELECT * FROM impl_members WHERE user_id = ? AND role = 'consultant'").get(Number(body.consultant_id));
    if (!consultant) throw new HttpError(400, "请选择实施顾问");
    const start = date(body.planned_start, "计划开始日期");
    const end = date(body.planned_end, "要求完成日期");
    const due = parseStageDue(body, start, end);
    tx(db, () => {
      const now = nowISO();
      db.prepare(
        "UPDATE impl_projects SET name = ?, consultant_id = ?, consultant_name = ?, planned_start = ?, planned_end = ?, remark = ?, updated_at = ? WHERE id = ?"
      ).run(str(body.name) ?? p.name, consultant.user_id, consultant.name, start, end, str(body.remark), now, p.id);
      const upd = db.prepare("UPDATE impl_stages SET planned_end = ? WHERE project_id = ? AND stage_key = ?");
      for (const k of STAGE_KEYS) upd.run(due[k], p.id, k);
      if (consultant.user_id !== p.consultant_id) {
        notify(db, { recipientId: consultant.user_id, type: "assigned", title: `项目改派给你:${p.customer_name} · ${p.name}`, content: `要求 ${end} 前完成实施。`, link: `/impl/projects/${p.id}` });
      }
    });
    return summarize(db, getProject(db, p.id));
  });

  // ===== 项目列表与详情 =====
  add("GET", "/impl/projects", ({ user, query }) => {
    const roles = rolesOf(db, user);
    const all = query.scope === "all" && (roles.has("director") || roles.has("gm"));
    const where = [];
    const args = [];
    if (!all) {
      where.push("consultant_id = ?");
      args.push(user.id);
    }
    if (query.status) {
      where.push("status = ?");
      args.push(query.status);
    }
    if (query.keyword) {
      where.push("(name LIKE ? OR customer_name LIKE ? OR project_no LIKE ? OR consultant_name LIKE ?)");
      const k = `%${query.keyword}%`;
      args.push(k, k, k, k);
    }
    const today = todayCN();
    const items = db
      .prepare(`SELECT * FROM impl_projects ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY CASE status WHEN 'completed' THEN 1 ELSE 0 END, planned_end`)
      .all(...args)
      .map(p => summarize(db, p, today));
    return { items: query.overdue === "1" ? items.filter(p => p.overdue_days > 0 || p.stage_overdue_days > 0) : items };
  });
  add("GET", "/impl/projects/:id", ({ user, params }) => {
    const p = getProject(db, params.id);
    requireProjectAccess(db, user, p);
    const handover = db
      .prepare(
        `SELECT h.handover_no, h.modules, h.main_requirements, h.value_points, h.risk_points, h.remark, h.created_by AS sales_name,
                c.contract_no, c.amount, c.start_date, c.end_date, o.contact_name, o.contact_phone
         FROM handovers h JOIN contracts c ON c.id = h.contract_id JOIN opportunities o ON o.id = c.opportunity_id WHERE h.id = ?`
      )
      .get(p.handover_id);
    return {
      ...summarize(db, p),
      handover: handover && { ...handover, modules: JSON.parse(handover.modules || "[]") },
      reports: db
        .prepare("SELECT * FROM impl_reports WHERE project_id = ? ORDER BY id DESC")
        .all(p.id)
        .map(r => ({ ...r, review_issues: JSON.parse(r.review_issues || "[]") })),
      files: db.prepare("SELECT id, stage_key, filename, size, uploaded_by, created_at FROM impl_files WHERE project_id = ? ORDER BY id DESC").all(p.id),
      delays: db.prepare("SELECT * FROM impl_delays WHERE project_id = ? ORDER BY id DESC").all(p.id).map(d => delayView(db, d)),
      issues: db.prepare("SELECT * FROM impl_issues WHERE project_id = ? ORDER BY status, id DESC").all(p.id),
      canWrite: rolesOf(db, user).has("director") || p.consultant_id === user.id,
    };
  });
  add("POST", "/impl/projects/:id/accept", ({ user, params }) => {
    const p = getProject(db, params.id);
    if (p.consultant_id !== user.id && !rolesOf(db, user).has("director")) throw new HttpError(403, "只有被分配的实施顾问可以接收项目");
    if (p.status !== "assigned") throw new HttpError(400, "项目已接收");
    const now = nowISO();
    tx(db, () => {
      db.prepare("UPDATE impl_projects SET status = 'in_progress', accepted_at = ?, updated_at = ? WHERE id = ?").run(now, now, p.id);
      db.prepare("UPDATE impl_stages SET status = 'in_progress', started_at = ? WHERE project_id = ? AND seq = 1").run(now, p.id);
    });
    return summarize(db, getProject(db, p.id));
  });

  // ===== 阶段汇报 =====
  add("POST", "/impl/projects/:id/reports", ({ user, params, body }) => {
    const p = getProject(db, params.id);
    requireProjectAccess(db, user, p, { write: true });
    if (p.status !== "in_progress") throw new HttpError(400, p.status === "assigned" ? "请先接收项目" : "项目已完成");
    const stage = db.prepare("SELECT * FROM impl_stages WHERE project_id = ? AND stage_key = ?").get(p.id, body.stage_key);
    if (!stage) throw new HttpError(400, "请选择阶段");
    if (stage.status === "done") throw new HttpError(400, `「${stageLabel(stage.stage_key)}」阶段已完成`);
    if (stage.status !== "in_progress") throw new HttpError(400, `请先完成前面的阶段,再汇报「${stageLabel(stage.stage_key)}」`);
    if (db.prepare("SELECT 1 FROM impl_reports WHERE project_id = ? AND stage_key = ? AND review_status = 'pending'").get(p.id, stage.stage_key)) {
      throw new HttpError(400, "上一份汇报还在等数字总监审核,请稍后再提交");
    }
    const progress = Math.round(Number(body.progress));
    if (!(progress >= 0 && progress <= 100)) throw new HttpError(400, "阶段进度应为 0-100");
    const requestComplete = body.request_complete ? 1 : 0;
    const r = tx(db, () => {
      const now = nowISO();
      const res = db
        .prepare(
          `INSERT INTO impl_reports (project_id, stage_key, report_date, progress, work_content, completed_items, problems, next_plan,
             request_complete, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(p.id, stage.stage_key, date(body.report_date, "汇报日期"), requestComplete ? 100 : progress, required(body, "work_content", "本阶段工作内容"),
          str(body.completed_items), str(body.problems), str(body.next_plan), requestComplete, user.name, now);
      db.prepare("UPDATE impl_stages SET progress = ? WHERE id = ?").run(requestComplete ? Math.max(progress, 90) : Math.min(progress, 99), stage.id);
      db.prepare("UPDATE impl_projects SET updated_at = ? WHERE id = ?").run(now, p.id);
      return Number(res.lastInsertRowid);
    });
    queueReview(db, r);
    return { id: r, review_status: "pending" };
  });
  add("POST", "/impl/reports/:id/retry-review", ({ user, params }) => {
    const report = db.prepare("SELECT * FROM impl_reports WHERE id = ?").get(Number(params.id));
    if (!report) throw new HttpError(404, "汇报不存在");
    requireProjectAccess(db, user, getProject(db, report.project_id), { write: true });
    if (report.review_status !== "error") throw new HttpError(400, "只有审核出错的汇报可以重新审核");
    db.prepare("UPDATE impl_reports SET review_status = 'pending', review_summary = NULL WHERE id = ?").run(report.id);
    queueReview(db, report.id);
    return { ok: true };
  });
  // 实施总监人工审核(数字总监出错或需要改判时)
  add("POST", "/impl/reports/:id/manual-review", ({ user, params, body }) => {
    requireRole(db, user, "director");
    const report = db.prepare("SELECT * FROM impl_reports WHERE id = ?").get(Number(params.id));
    if (!report) throw new HttpError(404, "汇报不存在");
    if (report.review_status === "passed") throw new HttpError(400, "该汇报已审核通过");
    const passed = !!body.passed;
    const summary = required(body, "summary", "审核意见");
    const issues = passed ? [] : [{ problem: summary, norm: "", suggestion: str(body.suggestion) ?? "", severity: "中" }];
    tx(db, () => {
      db.prepare(
        "UPDATE impl_reports SET review_status = ?, review_summary = ?, review_issues = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?"
      ).run(passed ? "passed" : "failed", summary, JSON.stringify(issues), user.name, nowISO(), report.id);
      applyReviewOutcome(db, report, getProject(db, report.project_id), { passed, summary, issues });
    });
    return { ok: true };
  });

  // ===== 文档 =====
  add(
    "POST",
    "/impl/projects/:id/files",
    ({ user, params, query, rawBody }) => {
      const p = getProject(db, params.id);
      requireProjectAccess(db, user, p, { write: true });
      if (!STAGE_KEYS.includes(query.stage)) throw new HttpError(400, "请选择文档所属阶段");
      const filename = str(query.name);
      if (!filename) throw new HttpError(400, "缺少文件名");
      if (!rawBody?.length) throw new HttpError(400, "文件为空");
      const stored = saveFile(rawBody, filename);
      const text = extractText(rawBody, filename);
      const r = db
        .prepare("INSERT INTO impl_files (project_id, stage_key, filename, stored_name, size, text_excerpt, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(p.id, query.stage, filename, stored, rawBody.length, text ? text.slice(0, 4000) : null, user.name, nowISO());
      return { id: Number(r.lastInsertRowid), filename, size: rawBody.length };
    },
    { raw: true, maxBody: MAX_UPLOAD }
  );
  add("GET", "/impl/files/:id", ({ user, params }) => {
    const f = db.prepare("SELECT * FROM impl_files WHERE id = ?").get(Number(params.id));
    if (!f) throw new HttpError(404, "文件不存在");
    if (f.project_id) requireProjectAccess(db, user, getProject(db, f.project_id));
    else if (!rolesOf(db, user).size) throw new HttpError(403, "没有权限");
    return { __file: { path: filePath(f.stored_name), filename: f.filename } };
  });
  add("DELETE", "/impl/files/:id", ({ user, params }) => {
    const f = db.prepare("SELECT * FROM impl_files WHERE id = ?").get(Number(params.id));
    if (!f) throw new HttpError(404, "文件不存在");
    if (f.project_id) requireProjectAccess(db, user, getProject(db, f.project_id), { write: true });
    else requireRole(db, user, "director");
    db.prepare("DELETE FROM impl_files WHERE id = ?").run(f.id);
    removeFile(f.stored_name);
    return { ok: true };
  });

  // ===== 延期 =====
  add("GET", "/impl/delays", ({ user, query }) => {
    requireRole(db, user, "director", "gm");
    const statuses = query.status ? [query.status] : ["awaiting_plan", "submitted", "rejected"];
    return {
      items: db
        .prepare(`SELECT * FROM impl_delays WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY CASE status WHEN 'submitted' THEN 0 ELSE 1 END, due_date`)
        .all(...statuses)
        .map(d => delayView(db, d)),
    };
  });
  add("POST", "/impl/delays/:id/plan", ({ user, params, body }) => {
    const d = db.prepare("SELECT * FROM impl_delays WHERE id = ?").get(Number(params.id));
    if (!d) throw new HttpError(404, "延期记录不存在");
    const p = getProject(db, d.project_id);
    requireProjectAccess(db, user, p, { write: true });
    if (!["awaiting_plan", "rejected"].includes(d.status)) throw new HttpError(400, "该延期已提交方案");
    const newDate = date(body.plan_new_date, "预计完成日期");
    if (newDate <= d.due_date) throw new HttpError(400, "预计完成日期应晚于原要求日期");
    db.prepare("UPDATE impl_delays SET status = 'submitted', plan_reason = ?, plan_new_date = ?, plan_measures = ?, submitted_at = ? WHERE id = ?").run(
      required(body, "plan_reason", "延期原因"), newDate, required(body, "plan_measures", "补救措施"), nowISO(), d.id
    );
    notify(db, {
      role: "director",
      type: "delay_plan",
      title: `延期方案待审批:${p.name} ${stageLabel(d.stage_key)}`,
      content: `${p.consultant_name} 申请延期至 ${newDate}`,
      link: "/impl/director",
    });
    return { ok: true };
  });
  add("POST", "/impl/delays/:id/decide", ({ user, params, body }) => {
    requireRole(db, user, "director");
    const d = db.prepare("SELECT * FROM impl_delays WHERE id = ?").get(Number(params.id));
    if (!d) throw new HttpError(404, "延期记录不存在");
    if (d.status !== "submitted") throw new HttpError(400, "该延期方案不在待审批状态");
    const approve = !!body.approve;
    const p = getProject(db, d.project_id);
    tx(db, () => {
      const now = nowISO();
      db.prepare("UPDATE impl_delays SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(
        approve ? "approved" : "rejected", user.name, now, str(body.note), d.id
      );
      if (approve) {
        // 批准后顺延:本阶段及之后阶段、项目完成日期不早于新日期
        const newDate = d.plan_new_date;
        if (d.stage_key) {
          const st = db.prepare("SELECT seq FROM impl_stages WHERE project_id = ? AND stage_key = ?").get(p.id, d.stage_key);
          db.prepare("UPDATE impl_stages SET planned_end = ? WHERE project_id = ? AND stage_key = ?").run(newDate, p.id, d.stage_key);
          db.prepare("UPDATE impl_stages SET planned_end = ? WHERE project_id = ? AND seq > ? AND planned_end < ?").run(newDate, p.id, st.seq, newDate);
        }
        if (p.planned_end < newDate) db.prepare("UPDATE impl_projects SET planned_end = ?, updated_at = ? WHERE id = ?").run(newDate, now, p.id);
      }
      notify(db, {
        recipientId: p.consultant_id,
        type: "delay_decision",
        title: `延期方案${approve ? "已批准" : "被驳回"}:${p.name} ${stageLabel(d.stage_key)}`,
        content: approve ? `完成日期调整为 ${d.plan_new_date}。${str(body.note) ?? ""}` : `${str(body.note) ?? ""} 请修改后重新提交延期方案。`,
        link: `/impl/projects/${p.id}`,
      });
    });
    return { ok: true };
  });

  // ===== 通知 =====
  add("GET", "/impl/notifications", ({ user, query }) => {
    const roles = [...rolesOf(db, user)];
    const unreadOnly = query.unread === "1";
    const items = db
      .prepare(
        `SELECT * FROM impl_notifications WHERE (recipient_id = ? OR (recipient_id IS NULL AND recipient_role IN (${roles.map(() => "?").join(",") || "''"})))
         ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY id DESC LIMIT 50`
      )
      .all(user.id, ...roles);
    return { items };
  });
  add("POST", "/impl/notifications/read", ({ user, body }) => {
    const roles = [...rolesOf(db, user)];
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
    const scope = `(recipient_id = ? OR (recipient_id IS NULL AND recipient_role IN (${roles.map(() => "?").join(",") || "''"})))`;
    if (ids.length) {
      db.prepare(`UPDATE impl_notifications SET read_at = ? WHERE id IN (${ids.map(() => "?").join(",")}) AND ${scope}`).run(nowISO(), ...ids, user.id, ...roles);
    } else {
      db.prepare(`UPDATE impl_notifications SET read_at = ? WHERE read_at IS NULL AND ${scope}`).run(nowISO(), user.id, ...roles);
    }
    return { ok: true };
  });

  // ===== 项目管理规范 =====
  add("GET", "/impl/norms", ({ user }) => {
    if (!rolesOf(db, user).size) throw new HttpError(403, "没有权限");
    return {
      text: getSetting(db, "impl.norms", ""),
      updated_at: getSetting(db, "impl.norms_updated"),
      files: db.prepare("SELECT id, filename, size, uploaded_by, created_at, text_excerpt IS NOT NULL AS has_text FROM impl_files WHERE project_id IS NULL ORDER BY id DESC").all(),
    };
  });
  add("PUT", "/impl/norms", ({ user, body }) => {
    requireRole(db, user, "director");
    setSetting(db, "impl.norms", String(body.text ?? ""));
    setSetting(db, "impl.norms_updated", nowISO());
    return { ok: true };
  });
  add(
    "POST",
    "/impl/norms/upload",
    ({ user, query, rawBody }) => {
      requireRole(db, user, "director");
      const filename = str(query.name);
      if (!filename || !rawBody?.length) throw new HttpError(400, "请选择文件");
      const text = extractText(rawBody, filename);
      const stored = saveFile(rawBody, filename);
      db.prepare("INSERT INTO impl_files (project_id, stage_key, filename, stored_name, size, text_excerpt, uploaded_by, created_at) VALUES (NULL, NULL, ?,?,?,?,?,?)").run(
        filename, stored, rawBody.length, text ? text.slice(0, 4000) : null, user.name, nowISO()
      );
      if (text) {
        const old = getSetting(db, "impl.norms", "");
        setSetting(db, "impl.norms", (old ? old + "\n\n" : "") + `【${filename}】\n${text}`);
        setSetting(db, "impl.norms_updated", nowISO());
      }
      return { ok: true, extracted: text.length };
    },
    { raw: true, maxBody: MAX_UPLOAD }
  );

  // ===== 数字总监 =====
  add("GET", "/impl/director/overview", ({ user }) => {
    requireRole(db, user, "director", "gm");
    const today = todayCN();
    const projects = db.prepare("SELECT * FROM impl_projects WHERE status != 'completed'").all().map(p => summarize(db, p, today));
    return {
      lastPatrol: getSetting(db, "impl.last_patrol"),
      agentReady: !!process.env.PLATFORM_INTERNAL_SECRET,
      counts: {
        active: projects.filter(p => p.status === "in_progress").length,
        assigned: projects.filter(p => p.status === "assigned").length,
        overdue: projects.filter(p => p.overdue_days > 0 || p.stage_overdue_days > 0).length,
        pendingPlans: db.prepare("SELECT COUNT(*) AS n FROM impl_delays WHERE status = 'submitted'").get().n,
        awaitingPlans: db.prepare("SELECT COUNT(*) AS n FROM impl_delays WHERE status IN ('awaiting_plan','rejected')").get().n,
        openIssues: db.prepare("SELECT COUNT(*) AS n FROM impl_issues WHERE status = 'open'").get().n,
        reviewing: db.prepare("SELECT COUNT(*) AS n FROM impl_reports WHERE review_status = 'pending'").get().n,
      },
      overdueProjects: projects.filter(p => p.overdue_days > 0 || p.stage_overdue_days > 0),
      recentReviews: db
        .prepare(
          `SELECT r.id, r.project_id, r.stage_key, r.report_date, r.progress, r.request_complete, r.created_by, r.review_status, r.review_score,
                  r.review_summary, r.review_issues, r.reviewed_by, r.reviewed_at, p.name AS project_name, p.customer_name
           FROM impl_reports r JOIN impl_projects p ON p.id = r.project_id ORDER BY r.id DESC LIMIT 30`
        )
        .all()
        .map(r => ({ ...r, review_issues: JSON.parse(r.review_issues || "[]") })),
    };
  });
  add("POST", "/impl/director/patrol", ({ user }) => {
    requireRole(db, user, "director");
    return runPatrol(db);
  });
  add("POST", "/impl/director/issue-list", ({ user }) => {
    requireRole(db, user, "director", "gm");
    return buildIssueList(db) ?? { id: null, summary: "当前没有待整改问题和延期,无需生成问题清单" };
  });
  add("POST", "/impl/director/ask", async ({ user, body }) => {
    requireRole(db, user, "director", "gm", "consultant");
    const q = required(body, "question", "问题");
    const reply = await askDirector(`(提问人:${user.name},角色:${[...rolesOf(db, user)].map(r => ROLES[r]).filter(Boolean).join("/")})\n${q}`, `ask:${user.id}`);
    return { reply };
  });

  // ===== 问题清单(总经理) =====
  add("GET", "/impl/issue-lists", ({ user }) => {
    requireRole(db, user, "gm", "director");
    return { items: db.prepare("SELECT id, list_date, summary, read_at, updated_at FROM impl_issue_lists ORDER BY list_date DESC LIMIT 60").all() };
  });
  add("GET", "/impl/issue-lists/:id", ({ user, params }) => {
    requireRole(db, user, "gm", "director");
    const l = db.prepare("SELECT * FROM impl_issue_lists WHERE id = ?").get(Number(params.id));
    if (!l) throw new HttpError(404, "问题清单不存在");
    if (rolesOf(db, user).has("gm") && !l.read_at) db.prepare("UPDATE impl_issue_lists SET read_at = ? WHERE id = ?").run(nowISO(), l.id);
    return { ...l, content: JSON.parse(l.content) };
  });
  add("GET", "/impl/issues", ({ user, query }) => {
    requireRole(db, user, "gm", "director");
    const status = query.status === "resolved" ? "resolved" : "open";
    return {
      items: db
        .prepare(
          `SELECT i.*, p.name AS project_name, p.customer_name, p.consultant_name FROM impl_issues i
           JOIN impl_projects p ON p.id = i.project_id WHERE i.status = ? ORDER BY CASE i.severity WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END, i.id DESC LIMIT 300`
        )
        .all(status),
    };
  });
  add("POST", "/impl/issues/:id/resolve", ({ user, params }) => {
    const i = db.prepare("SELECT * FROM impl_issues WHERE id = ?").get(Number(params.id));
    if (!i) throw new HttpError(404, "问题不存在");
    requireProjectAccess(db, user, getProject(db, i.project_id), { write: true });
    db.prepare("UPDATE impl_issues SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE id = ?").run(user.name, nowISO(), i.id);
    return { ok: true };
  });

  // ===== 给数字总监 AI 员工用的只读接口(内部令牌鉴权,见 server.mjs) =====
  add("GET", "/agent/projects", ({ query }) => {
    const today = todayCN();
    let items = db.prepare("SELECT * FROM impl_projects ORDER BY planned_end").all().map(p => summarize(db, p, today));
    if (query.status) items = items.filter(p => p.status === query.status);
    if (query.keyword) items = items.filter(p => `${p.name}${p.customer_name}${p.consultant_name}${p.project_no}`.includes(query.keyword));
    return {
      today,
      items: items.map(p => ({
        id: p.id,
        project_no: p.project_no,
        name: p.name,
        customer: p.customer_name,
        consultant: p.consultant_name,
        status: { assigned: "待接收", in_progress: "实施中", completed: "已完成" }[p.status],
        planned_end: p.planned_end,
        progress: p.progress,
        current_stage: stageLabel(p.current_stage),
        current_stage_due: p.current_stage_due,
        overdue_days: p.overdue_days,
        stage_overdue_days: p.stage_overdue_days,
        open_delays: p.open_delays,
        open_issues: p.open_issues,
        last_report_date: p.last_report_date,
      })),
    };
  });
  add("GET", "/agent/projects/:id", ({ params }) => {
    const p = getProject(db, params.id);
    const s = summarize(db, p);
    return {
      ...s,
      stages: s.stages.map(x => ({ stage: stageLabel(x.stage_key), planned_end: x.planned_end, status: x.status, progress: x.progress })),
      recent_reports: db
        .prepare("SELECT stage_key, report_date, progress, work_content, problems, review_status, review_summary FROM impl_reports WHERE project_id = ? ORDER BY id DESC LIMIT 5")
        .all(p.id)
        .map(r => ({ ...r, stage: stageLabel(r.stage_key) })),
      open_issues: db.prepare("SELECT stage_key, problem, suggestion, severity FROM impl_issues WHERE project_id = ? AND status = 'open'").all(p.id),
      delays: db.prepare("SELECT stage_key, due_date, status, plan_new_date, plan_reason FROM impl_delays WHERE project_id = ? ORDER BY id DESC LIMIT 10").all(p.id),
    };
  });
  add("GET", "/agent/issues", () => ({
    items: db
      .prepare(
        `SELECT i.stage_key, i.problem, i.suggestion, i.severity, i.created_at, p.name AS project, p.consultant_name AS consultant
         FROM impl_issues i JOIN impl_projects p ON p.id = i.project_id WHERE i.status = 'open' ORDER BY i.id DESC LIMIT 100`
      )
      .all()
      .map(i => ({ ...i, stage: stageLabel(i.stage_key) })),
  }));
}
