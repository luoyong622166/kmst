// 实施管理数字总监:
//   1. 巡检(规则,不耗大模型额度):阶段/项目超期 → 生成延期记录、给实施顾问发延期提醒、要求提交延期方案
//   2. 审核(大模型):按公司项目管理规范审核每份进度汇报,不通过则列出问题
//   3. 问题清单:汇总在实施项目的问题与延期,每天一份提交总经理
// 大模型审核通过平台自建 AI 员工 custom/agents/impl_director 完成(用平台额度)。
import { nowISO, todayCN } from "./util.mjs";

export const DIRECTOR_NAME = "实施管理数字总监";
export const AGENT_KEY = "impl_director";
const PLATFORM_URL = process.env.CRM_PLATFORM_URL || "http://127.0.0.1:3000";

export const IMPL_STAGES = [
  { key: "prepare", label: "前期准备" },
  { key: "blueprint", label: "蓝图设计" },
  { key: "golive", label: "项目上线" },
  { key: "acceptance", label: "验收交付" },
];
export function stageLabel(key) {
  return key ? (IMPL_STAGES.find(s => s.key === key)?.label ?? key) : "项目整体";
}

export function getSetting(db, key, fallback = null) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? fallback;
}
export function setSetting(db, key, value) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** 日期差(天):b - a,参数为 YYYY-MM-DD */
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

export function notify(db, { recipientId = null, role = null, type, title, content = null, link = null }) {
  db.prepare(
    "INSERT INTO impl_notifications (recipient_id, recipient_role, type, title, content, link, created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(recipientId, role, type, title, content, link, nowISO());
}

// ---------- 阶段推进 ----------
export function completeStage(db, projectId, stageKey) {
  const now = nowISO();
  const stage = db.prepare("SELECT * FROM impl_stages WHERE project_id = ? AND stage_key = ?").get(projectId, stageKey);
  if (!stage || stage.status === "done") return;
  db.prepare("UPDATE impl_stages SET status = 'done', progress = 100, completed_at = ? WHERE id = ?").run(now, stage.id);
  db.prepare("UPDATE impl_delays SET status = 'resolved' WHERE project_id = ? AND stage_key = ? AND status IN ('awaiting_plan','rejected')").run(projectId, stageKey);
  const next = db.prepare("SELECT * FROM impl_stages WHERE project_id = ? AND seq = ?").get(projectId, stage.seq + 1);
  if (next) {
    db.prepare("UPDATE impl_stages SET status = 'in_progress', started_at = ? WHERE id = ?").run(now, next.id);
    db.prepare("UPDATE impl_projects SET updated_at = ? WHERE id = ?").run(now, projectId);
  } else {
    db.prepare("UPDATE impl_projects SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, projectId);
    db.prepare("UPDATE impl_delays SET status = 'resolved' WHERE project_id = ? AND status IN ('awaiting_plan','rejected')").run(projectId);
  }
}

// ---------- 1. 巡检 ----------
export function runPatrol(db) {
  const today = todayCN();
  const now = nowISO();
  let created = 0;
  let reminded = 0;
  const projects = db.prepare("SELECT * FROM impl_projects WHERE status = 'in_progress'").all();
  for (const p of projects) {
    const targets = db
      .prepare("SELECT stage_key, planned_end FROM impl_stages WHERE project_id = ? AND status != 'done' AND planned_end < ? ORDER BY seq")
      .all(p.id, today)
      .map(s => ({ stage_key: s.stage_key, due: s.planned_end }));
    if (p.planned_end < today) targets.push({ stage_key: null, due: p.planned_end });

    for (const t of targets) {
      const open = db
        .prepare("SELECT * FROM impl_delays WHERE project_id = ? AND stage_key IS ? AND status IN ('awaiting_plan','submitted','rejected') ORDER BY id DESC LIMIT 1")
        .get(p.id, t.stage_key);
      const overdue = daysBetween(t.due, today);
      const what = t.stage_key ? `「${stageLabel(t.stage_key)}」阶段` : "整体实施";
      const message =
        `项目「${p.name}」(${p.customer_name})的${what}要求 ${t.due} 完成,已超期 ${overdue} 天。` +
        `请尽快在项目页面提交延期方案:写明延期原因、预计完成日期和补救措施。`;
      if (!open) {
        db.prepare("INSERT INTO impl_delays (project_id, stage_key, due_date, detected_at, last_reminded) VALUES (?,?,?,?,?)").run(
          p.id, t.stage_key, t.due, now, now
        );
        notify(db, { recipientId: p.consultant_id, type: "delay_reminder", title: `延期提醒:${p.name} ${what}已超期`, content: message, link: `/impl/projects/${p.id}` });
        created++;
      } else if (["awaiting_plan", "rejected"].includes(open.status) && Date.now() - Date.parse(open.last_reminded) >= 24 * 3600_000) {
        db.prepare("UPDATE impl_delays SET last_reminded = ? WHERE id = ?").run(now, open.id);
        notify(db, { recipientId: p.consultant_id, type: "delay_reminder", title: `再次提醒:${p.name} ${what}超期 ${overdue} 天,尚未提交延期方案`, content: message, link: `/impl/projects/${p.id}` });
        reminded++;
      }
    }
  }
  setSetting(db, "impl.last_patrol", now);
  return { checked: projects.length, created, reminded, at: now };
}

// ---------- 2. 大模型审核 ----------
export async function askDirector(content, sessionKey) {
  const secret = process.env.PLATFORM_INTERNAL_SECRET;
  if (!secret) throw new Error("数字总监未接通平台(缺少 PLATFORM_INTERNAL_SECRET 配置)");
  let res;
  try {
    res = await fetch(`${PLATFORM_URL}/api/custom-agent/${AGENT_KEY}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ content, sessionKey, audience: "internal" }),
      signal: AbortSignal.timeout(150_000),
    });
  } catch {
    throw new Error("数字总监响应超时,请稍后重新审核");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error ? `数字总监调用失败:${data.error}` : `数字总监调用失败(HTTP ${res.status})`);
  return String(data.reply ?? "");
}

function parseReview(reply) {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("数字总监没有返回审核结果,请重新审核");
  const j = JSON.parse(reply.slice(start, end + 1));
  const issues = (Array.isArray(j.issues) ? j.issues : [])
    .map(i => ({
      problem: String(i?.problem ?? "").trim(),
      norm: String(i?.norm ?? "").trim(),
      suggestion: String(i?.suggestion ?? "").trim(),
      severity: ["高", "中", "低"].includes(i?.severity) ? i.severity : "中",
    }))
    .filter(i => i.problem);
  const passed = j.passed === true || j.passed === "true";
  return {
    passed,
    score: Number.isFinite(Number(j.score)) ? Math.max(0, Math.min(100, Math.round(Number(j.score)))) : null,
    summary: String(j.summary ?? "").trim() || (passed ? "审核通过" : "审核不通过"),
    issues,
  };
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + "……(以下省略)" : s || "");

function reviewPrompt(db, report) {
  const p = db.prepare("SELECT * FROM impl_projects WHERE id = ?").get(report.project_id);
  const stage = db.prepare("SELECT * FROM impl_stages WHERE project_id = ? AND stage_key = ?").get(p.id, report.stage_key);
  const h = db.prepare("SELECT main_requirements, risk_points, modules FROM handovers WHERE id = ?").get(p.handover_id);
  const norms = getSetting(db, "impl.norms", "");
  const files = db.prepare("SELECT filename, text_excerpt FROM impl_files WHERE project_id = ? AND stage_key = ? ORDER BY id").all(p.id, report.stage_key);
  const today = todayCN();
  const modules = JSON.parse(h?.modules || "[]").map(m => m.name).join("、");
  return `【审核任务】请按公司项目管理规范,审核下面这份实施进度汇报。

## 公司项目管理规范
${clip(norms, 8000) || "(公司尚未上传项目管理规范。请按通用项目管理要求审核:汇报内容具体可核实、进度与计划匹配、问题有应对措施、阶段交付物齐全、申请阶段完成时须有对应交付文档。)"}

## 项目信息
- 项目:${p.name}(客户:${p.customer_name})
- 实施顾问:${p.consultant_name}
- 项目要求完成日期:${p.planned_end}(今天 ${today})
- 实施模块:${modules || "-"}
- 交接主要需求:${clip(h?.main_requirements, 600)}
- 交接风险点:${clip(h?.risk_points, 400)}
- 本阶段:${stageLabel(report.stage_key)},要求 ${stage?.planned_end} 完成${stage && stage.planned_end < today ? `,已超期 ${daysBetween(stage.planned_end, today)} 天` : ""}

## 本次汇报(${report.report_date})
- 阶段进度:${report.progress}%
- 是否申请本阶段完成:${report.request_complete ? "是" : "否"}
- 工作内容:${report.work_content}
- 已完成事项:${report.completed_items || "-"}
- 存在问题:${report.problems || "-"}
- 下一步计划:${report.next_plan || "-"}

## 本阶段已上传文档(${files.length} 份)
${files.map(f => `- ${f.filename}${f.text_excerpt ? `\n  内容摘录:${clip(f.text_excerpt, 600)}` : ""}`).join("\n") || "(无)"}

## 输出要求
只输出一个 JSON 对象,不要输出任何其他文字:
{"passed": true或false, "score": 0到100的整数, "summary": "一句话审核结论", "issues": [{"problem": "具体问题", "norm": "对应的规范条款(规范没写到的写'通用要求')", "suggestion": "整改建议", "severity": "高/中/低"}]}
判定标准:汇报有不符合规范的问题(尤其是申请阶段完成但缺少规范要求的交付物、内容空泛无法核实、进度明显滞后却没有应对措施)时 passed=false 并逐条列出问题;没有实质问题时 passed=true,issues 可以为空。`;
}

export async function reviewReport(db, reportId) {
  const report = db.prepare("SELECT * FROM impl_reports WHERE id = ?").get(reportId);
  if (!report || report.review_status !== "pending") return;
  const p = db.prepare("SELECT * FROM impl_projects WHERE id = ?").get(report.project_id);
  let result;
  try {
    result = parseReview(await askDirector(reviewPrompt(db, report), `review:${reportId}`));
  } catch (err) {
    db.prepare("UPDATE impl_reports SET review_status = 'error', review_summary = ?, reviewed_at = ? WHERE id = ?").run(err.message, nowISO(), reportId);
    console.error(`[impl] 审核汇报 ${reportId} 失败:`, err.message);
    return;
  }
  const now = nowISO();
  db.prepare(
    "UPDATE impl_reports SET review_status = ?, review_score = ?, review_summary = ?, review_issues = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?"
  ).run(result.passed ? "passed" : "failed", result.score, result.summary, JSON.stringify(result.issues), DIRECTOR_NAME, now, reportId);
  applyReviewOutcome(db, report, p, result);
}

/** 审核结论落地(大模型审核与总监人工审核共用) */
export function applyReviewOutcome(db, report, p, { passed, summary, issues }) {
  const label = stageLabel(report.stage_key);
  const link = `/impl/projects/${p.id}`;
  if (passed) {
    if (report.request_complete) completeStage(db, p.id, report.stage_key);
    notify(db, {
      recipientId: p.consultant_id,
      type: "review_passed",
      title: `汇报审核通过:${p.name} ${label}${report.request_complete ? "(阶段已完成)" : ""}`,
      content: summary,
      link,
    });
    return;
  }
  const now = nowISO();
  const ins = db.prepare(
    "INSERT INTO impl_issues (project_id, stage_key, report_id, problem, norm, suggestion, severity, created_at) VALUES (?,?,?,?,?,?,?,?)"
  );
  for (const i of issues) ins.run(p.id, report.stage_key, report.id, i.problem, i.norm, i.suggestion, i.severity, now);
  notify(db, {
    recipientId: p.consultant_id,
    type: "review_failed",
    title: `汇报审核不通过:${p.name} ${label}`,
    content: `${summary}\n${issues.map((i, n) => `${n + 1}. ${i.problem}${i.suggestion ? `(建议:${i.suggestion})` : ""}`).join("\n")}\n请按问题整改后重新提交汇报。`,
    link,
  });
  buildIssueList(db);
}

// 审核排队:串行执行,避免同时占用大模型
let chain = Promise.resolve();
export function queueReview(db, reportId) {
  chain = chain.then(() => reviewReport(db, reportId)).catch(err => console.error("[impl] 审核队列异常", err));
}

// ---------- 3. 问题清单 ----------
export function buildIssueList(db) {
  const today = todayCN();
  const now = nowISO();
  const projects = db.prepare("SELECT * FROM impl_projects WHERE status != 'completed' ORDER BY planned_end").all();
  const items = [];
  for (const p of projects) {
    const issues = db
      .prepare("SELECT id, stage_key, problem, norm, suggestion, severity, created_at FROM impl_issues WHERE project_id = ? AND status = 'open' ORDER BY id")
      .all(p.id);
    const delays = db
      .prepare("SELECT id, stage_key, due_date, status, plan_reason, plan_new_date FROM impl_delays WHERE project_id = ? AND status IN ('awaiting_plan','submitted','rejected') ORDER BY id")
      .all(p.id)
      .map(d => ({ ...d, overdue_days: daysBetween(d.due_date, today) }));
    if (!issues.length && !delays.length) continue;
    items.push({
      project_id: p.id,
      project_no: p.project_no,
      name: p.name,
      customer_name: p.customer_name,
      consultant_name: p.consultant_name,
      planned_end: p.planned_end,
      issues,
      delays,
    });
  }
  if (!items.length) return null;
  const issueCount = items.reduce((a, i) => a + i.issues.length, 0);
  const high = items.reduce((a, i) => a + i.issues.filter(x => x.severity === "高").length, 0);
  const delayCount = items.reduce((a, i) => a + i.delays.length, 0);
  const summary = `在实施项目 ${projects.length} 个,其中 ${items.length} 个存在问题:待整改问题 ${issueCount} 条(高风险 ${high} 条),延期 ${delayCount} 项。`;
  const content = JSON.stringify({ generated_at: now, generated_by: DIRECTOR_NAME, items });
  const existing = db.prepare("SELECT id FROM impl_issue_lists WHERE list_date = ?").get(today);
  if (existing) db.prepare("UPDATE impl_issue_lists SET summary = ?, content = ?, read_at = NULL, updated_at = ? WHERE id = ?").run(summary, content, now, existing.id);
  else db.prepare("INSERT INTO impl_issue_lists (list_date, summary, content, created_at, updated_at) VALUES (?,?,?,?,?)").run(today, summary, content, now, now);
  const id = existing?.id ?? db.prepare("SELECT id FROM impl_issue_lists WHERE list_date = ?").get(today).id;
  notify(db, { role: "gm", type: "issue_list", title: `${today} 在实施项目问题清单${existing ? "(已更新)" : ""}`, content: summary, link: `/impl/issues?list=${id}` });
  return { id, summary };
}

// ---------- 定时任务 ----------
export function startScheduler(db) {
  const tick = () => {
    try {
      const last = getSetting(db, "impl.last_patrol");
      if (!last || Date.now() - Date.parse(last) >= 60 * 60_000) runPatrol(db);
      // 每天 18:00 后汇总一次问题清单(当天已有清单则更新)
      const hourCN = new Date(Date.now() + 8 * 3600_000).getUTCHours();
      const today = todayCN();
      if (hourCN >= 18 && getSetting(db, "impl.last_daily_list") !== today) {
        buildIssueList(db);
        setSetting(db, "impl.last_daily_list", today);
      }
    } catch (err) {
      console.error("[impl] 定时任务异常", err);
    }
  };
  setTimeout(tick, 5_000);
  setInterval(tick, 10 * 60_000);
  for (const r of db.prepare("SELECT id FROM impl_reports WHERE review_status = 'pending'").all()) queueReview(db, r.id);
}
