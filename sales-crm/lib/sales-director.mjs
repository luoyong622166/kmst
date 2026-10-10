// 数字销售总监:从销售填写的商机、跟进记录、合同、收款登记中抽取数据,按销售(商机负责人)统计
//   商机数量 / 跟进过程 / 成交率 / 收款情况;
// 预警(久未跟进、下次跟进逾期、应收未收)按规则计算,不耗大模型额度;
// 分析报告与提问由平台自建 AI 员工 custom/agents/sales_director 完成(用平台额度),每周一 09:00 自动出一份上周报告。
import { HttpError } from "./errors.mjs";
import { askDirector, daysBetween, getSetting, notify, setSetting } from "./director.mjs";
import { requireRole } from "./impl.mjs";
import { nowISO, todayCN } from "./util.mjs";

export const SALES_DIRECTOR_NAME = "数字销售总监";
const AGENT_KEY = "sales_director";
const STALE_DAYS = 14; // 在跟商机超过这么多天没有跟进记录 → 久未跟进
const OWNER = "COALESCE(NULLIF(TRIM(o.owner), ''), '未分配')";
const STAGE_LABEL = {
  new: "新商机",
  initial_visit: "初次拜访",
  requirement: "需求分析",
  proposal: "方案提供",
  negotiation: "商务谈判",
  won: "已成交",
  lost: "已流失",
};
const FOLLOW_STAGES = ["initial_visit", "requirement", "proposal", "negotiation"];
const PERIOD_LABEL = { month: "本月", last_month: "上月", quarter: "本季度", year: "本年", week: "本周", last_week: "上周", all: "全部", custom: "自定义" };

// ---------- 统计区间 ----------
const pad = n => String(n).padStart(2, "0");
function addDays(d, n) {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""));

export function periodOf(q = {}) {
  const today = todayCN();
  const [y, m] = today.split("-").map(Number);
  const weekday = (new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7; // 周一 = 0
  const period = PERIOD_LABEL[q.period] ? q.period : "month";
  let from = null;
  let to = today;
  if (period === "month") from = `${y}-${pad(m)}-01`;
  else if (period === "last_month") {
    from = m === 1 ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`;
    to = addDays(`${y}-${pad(m)}-01`, -1);
  } else if (period === "quarter") from = `${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`;
  else if (period === "year") from = `${y}-01-01`;
  else if (period === "week") from = addDays(today, -weekday);
  else if (period === "last_week") {
    from = addDays(today, -weekday - 7);
    to = addDays(from, 6);
  } else if (period === "all") to = null;
  else {
    if (!isDate(q.from) || !isDate(q.to)) throw new HttpError(400, "请选择正确的起止日期");
    if (q.from > q.to) throw new HttpError(400, "开始日期不能晚于结束日期");
    from = q.from;
    to = q.to;
  }
  const label = period === "all" ? "全部时间" : `${PERIOD_LABEL[period]}(${from} ~ ${to})`;
  return { period, from, to, label };
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const r2 = n => Math.round((n || 0) * 100) / 100;

function blankPerson(name) {
  return {
    name,
    opps: { total: 0, active: 0, won: 0, lost: 0, new_in_period: 0, pipeline_amount: 0, by_stage: {} },
    follow: { count: 0, opportunities: 0, by_stage: {}, last_date: null, stale: 0, overdue_next: 0 },
    deal: { close_rate: null, win_rate: null, signed_count: 0, signed_amount: 0, signed_count_all: 0, signed_amount_all: 0 },
    pay: { received: 0, received_all: 0, receivable: 0, collection_rate: null },
  };
}

function finish(p) {
  p.deal.close_rate = pct(p.opps.won, p.opps.total);
  p.deal.win_rate = pct(p.opps.won, p.opps.won + p.opps.lost);
  p.deal.signed_amount = r2(p.deal.signed_amount);
  p.deal.signed_amount_all = r2(p.deal.signed_amount_all);
  p.pay.received = r2(p.pay.received);
  p.pay.received_all = r2(p.pay.received_all);
  p.pay.receivable = r2(p.deal.signed_amount_all - p.pay.received_all);
  p.pay.collection_rate = pct(p.pay.received_all, p.deal.signed_amount_all);
  p.opps.pipeline_amount = r2(p.opps.pipeline_amount);
  return p;
}

/** 在跟商机的跟进状态(久未跟进 / 下次跟进逾期),按当前状态计算,不受统计区间影响 */
function activeOpportunityStatus(db, today, owner = null) {
  return db
    .prepare(
      `SELECT o.id, o.name, o.stage, ${OWNER} AS owner, o.expected_amount, date(o.created_at, '+8 hours') AS created_day,
         (SELECT MAX(f.follow_date) FROM followups f WHERE f.opportunity_id = o.id) AS last_follow,
         (SELECT f.next_date FROM followups f WHERE f.opportunity_id = o.id ORDER BY f.follow_date DESC, f.id DESC LIMIT 1) AS next_date,
         (SELECT f.next_plan FROM followups f WHERE f.opportunity_id = o.id ORDER BY f.follow_date DESC, f.id DESC LIMIT 1) AS next_plan
       FROM opportunities o WHERE o.stage NOT IN ('won', 'lost') ${owner === null ? "" : `AND ${OWNER} = ?`}`
    )
    .all(...(owner === null ? [] : [owner]))
    .map(o => {
      const idle = daysBetween(o.last_follow ?? o.created_day, today);
      return {
        ...o,
        stage_label: STAGE_LABEL[o.stage] ?? o.stage,
        idle_days: idle,
        stale: idle >= STALE_DAYS,
        next_overdue_days: o.next_date && o.next_date < today ? daysBetween(o.next_date, today) : 0,
      };
    });
}

export function salesStats(db, range) {
  const today = todayCN();
  const F = range.from ?? "0000-01-01";
  const T = range.to ?? "9999-12-31";
  const people = new Map();
  const get = name => {
    if (!people.has(name)) people.set(name, blankPerson(name));
    return people.get(name);
  };

  // 商机:累计数量、阶段分布、区间内新增
  for (const r of db
    .prepare(
      `SELECT ${OWNER} AS owner, o.stage, COUNT(*) AS n, SUM(COALESCE(o.expected_amount, 0)) AS amount,
         SUM(date(o.created_at, '+8 hours') BETWEEN ? AND ?) AS new_n
       FROM opportunities o GROUP BY 1, 2`
    )
    .all(F, T)) {
    const p = get(r.owner);
    p.opps.total += r.n;
    p.opps.new_in_period += r.new_n;
    p.opps.by_stage[r.stage] = r.n;
    if (r.stage === "won") p.opps.won += r.n;
    else if (r.stage === "lost") p.opps.lost += r.n;
    else {
      p.opps.active += r.n;
      p.opps.pipeline_amount += r.amount;
    }
  }

  // 跟进过程:区间内跟进次数(按阶段)、覆盖商机数、最近一次跟进
  for (const r of db
    .prepare(
      `SELECT ${OWNER} AS owner, f.stage, COUNT(*) AS n FROM followups f JOIN opportunities o ON o.id = f.opportunity_id
       WHERE f.follow_date BETWEEN ? AND ? GROUP BY 1, 2`
    )
    .all(F, T)) {
    const p = get(r.owner);
    p.follow.count += r.n;
    p.follow.by_stage[r.stage] = r.n;
  }
  for (const r of db
    .prepare(
      `SELECT ${OWNER} AS owner, COUNT(DISTINCT CASE WHEN f.follow_date BETWEEN ? AND ? THEN f.opportunity_id END) AS opps, MAX(f.follow_date) AS last_date
       FROM followups f JOIN opportunities o ON o.id = f.opportunity_id GROUP BY 1`
    )
    .all(F, T)) {
    const p = get(r.owner);
    p.follow.opportunities = r.opps;
    p.follow.last_date = r.last_date;
  }
  const active = activeOpportunityStatus(db, today);
  for (const o of active) {
    const p = get(o.owner);
    if (o.stale) p.follow.stale++;
    if (o.next_overdue_days > 0) p.follow.overdue_next++;
  }

  // 成交:已签订合同(区间内按签订日期 / 累计)
  for (const r of db
    .prepare(
      `SELECT ${OWNER} AS owner, COUNT(*) AS n, SUM(c.amount) AS amount,
         COALESCE(SUM(c.sign_date BETWEEN ? AND ?), 0) AS n_p, SUM(CASE WHEN c.sign_date BETWEEN ? AND ? THEN c.amount ELSE 0 END) AS amount_p
       FROM contracts c JOIN opportunities o ON o.id = c.opportunity_id WHERE c.status = 'signed' GROUP BY 1`
    )
    .all(F, T, F, T)) {
    const p = get(r.owner);
    p.deal.signed_count_all = r.n;
    p.deal.signed_amount_all = r.amount;
    p.deal.signed_count = r.n_p;
    p.deal.signed_amount = r.amount_p;
  }

  // 收款:区间内按收款日期 / 累计
  for (const r of db
    .prepare(
      `SELECT ${OWNER} AS owner, SUM(p.amount) AS total, SUM(CASE WHEN p.pay_date BETWEEN ? AND ? THEN p.amount ELSE 0 END) AS in_period
       FROM contract_payments p JOIN contracts c ON c.id = p.contract_id JOIN opportunities o ON o.id = c.opportunity_id
       WHERE c.status = 'signed' GROUP BY 1`
    )
    .all(F, T)) {
    const p = get(r.owner);
    p.pay.received_all = r.total;
    p.pay.received = r.in_period;
  }

  const list = [...people.values()].map(finish).sort((a, b) => b.deal.signed_amount - a.deal.signed_amount || b.opps.total - a.opps.total);
  const team = blankPerson("全体");
  for (const p of list) {
    for (const k of ["total", "active", "won", "lost", "new_in_period", "pipeline_amount"]) team.opps[k] += p.opps[k];
    for (const k of ["count", "opportunities", "stale", "overdue_next"]) team.follow[k] += p.follow[k];
    for (const k of ["signed_count", "signed_amount", "signed_count_all", "signed_amount_all"]) team.deal[k] += p.deal[k];
    for (const k of ["received", "received_all"]) team.pay[k] += p.pay[k];
    for (const [s, n] of Object.entries(p.opps.by_stage)) team.opps.by_stage[s] = (team.opps.by_stage[s] ?? 0) + n;
    for (const [s, n] of Object.entries(p.follow.by_stage)) team.follow.by_stage[s] = (team.follow.by_stage[s] ?? 0) + n;
    if (p.follow.last_date && (!team.follow.last_date || p.follow.last_date > team.follow.last_date)) team.follow.last_date = p.follow.last_date;
  }
  finish(team);

  const receivables = db
    .prepare(
      `SELECT c.id, c.contract_no, c.project_name, c.amount, c.sign_date, c.payment_terms, o.name AS customer_name, ${OWNER} AS owner,
         (SELECT COALESCE(SUM(p.amount), 0) FROM contract_payments p WHERE p.contract_id = c.id) AS received,
         (SELECT MAX(p.pay_date) FROM contract_payments p WHERE p.contract_id = c.id) AS last_pay_date
       FROM contracts c JOIN opportunities o ON o.id = c.opportunity_id WHERE c.status = 'signed'`
    )
    .all()
    .map(c => ({ ...c, unpaid: r2(c.amount - c.received), days_since_sign: c.sign_date ? daysBetween(c.sign_date, today) : null }))
    .filter(c => c.unpaid > 0)
    .sort((a, b) => (b.days_since_sign ?? 0) - (a.days_since_sign ?? 0));

  return {
    today,
    range,
    staleDays: STALE_DAYS,
    team,
    people: list,
    alerts: {
      stale: active.filter(o => o.stale).sort((a, b) => b.idle_days - a.idle_days),
      overdueNext: active.filter(o => o.next_overdue_days > 0).sort((a, b) => b.next_overdue_days - a.next_overdue_days),
      receivables,
    },
  };
}

/** 单个销售的明细:名下商机、区间内跟进记录、合同与收款 */
export function personDetail(db, name, range) {
  const today = todayCN();
  const F = range.from ?? "0000-01-01";
  const T = range.to ?? "9999-12-31";
  const status = new Map(activeOpportunityStatus(db, today, name).map(o => [o.id, o]));
  const opportunities = db
    .prepare(
      `SELECT o.id, o.name, o.stage, o.expected_amount, o.expected_close, o.lead_source, date(o.created_at, '+8 hours') AS created_day,
         (SELECT COUNT(*) FROM followups f WHERE f.opportunity_id = o.id) AS followup_count,
         (SELECT MAX(f.follow_date) FROM followups f WHERE f.opportunity_id = o.id) AS last_follow,
         (SELECT COALESCE(SUM(c.amount), 0) FROM contracts c WHERE c.opportunity_id = o.id AND c.status = 'signed') AS signed_amount,
         (SELECT COALESCE(SUM(p.amount), 0) FROM contract_payments p JOIN contracts c ON c.id = p.contract_id
           WHERE c.opportunity_id = o.id AND c.status = 'signed') AS received
       FROM opportunities o WHERE ${OWNER} = ? ORDER BY o.updated_at DESC`
    )
    .all(name)
    .map(o => ({
      ...o,
      stage_label: STAGE_LABEL[o.stage] ?? o.stage,
      idle_days: status.get(o.id)?.idle_days ?? null,
      stale: status.get(o.id)?.stale ?? false,
      next_date: status.get(o.id)?.next_date ?? null,
      next_overdue_days: status.get(o.id)?.next_overdue_days ?? 0,
    }));
  const followups = db
    .prepare(
      `SELECT f.id, f.opportunity_id, f.stage, f.follow_date, f.method, f.contact_name, f.content, f.next_plan, f.next_date, f.created_by,
         o.name AS opportunity_name
       FROM followups f JOIN opportunities o ON o.id = f.opportunity_id
       WHERE ${OWNER} = ? AND f.follow_date BETWEEN ? AND ? ORDER BY f.follow_date DESC, f.id DESC LIMIT 200`
    )
    .all(name, F, T)
    .map(f => ({ ...f, stage_label: STAGE_LABEL[f.stage] ?? f.stage }));
  const payments = db
    .prepare(
      `SELECT p.id, p.amount, p.pay_date, p.method, p.remark, c.contract_no, c.project_name, o.name AS customer_name
       FROM contract_payments p JOIN contracts c ON c.id = p.contract_id JOIN opportunities o ON o.id = c.opportunity_id
       WHERE ${OWNER} = ? AND c.status = 'signed' AND p.pay_date BETWEEN ? AND ? ORDER BY p.pay_date DESC, p.id DESC`
    )
    .all(name, F, T);
  const stats = salesStats(db, range).people.find(p => p.name === name) ?? finish(blankPerson(name));
  return { name, range, stats, opportunities, followups, payments };
}

// ---------- 大模型分析报告 ----------
const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};
const money = n => `${r2(n).toLocaleString("zh-CN")}元`;
const rate = v => (v == null ? "-" : `${v}%`);

function personLine(p) {
  const st = Object.entries(p.follow.by_stage).map(([k, n]) => `${STAGE_LABEL[k]}${n}`).join("、") || "无";
  return (
    `商机:累计 ${p.opps.total} 个(在跟 ${p.opps.active}、已成交 ${p.opps.won}、已流失 ${p.opps.lost}),区间新增 ${p.opps.new_in_period},在跟预计金额 ${money(p.opps.pipeline_amount)}\n` +
    `跟进:区间内 ${p.follow.count} 次,覆盖 ${p.follow.opportunities} 个商机(${st});最近跟进 ${p.follow.last_date ?? "无"};超过 ${STALE_DAYS} 天未跟进 ${p.follow.stale} 个;下次跟进已逾期 ${p.follow.overdue_next} 个\n` +
    `成交:成交率 ${rate(p.deal.close_rate)}(已成交/全部商机),赢单率 ${rate(p.deal.win_rate)}(已成交/已成交+已流失);区间签约 ${p.deal.signed_count} 份 ${money(p.deal.signed_amount)},累计签约 ${money(p.deal.signed_amount_all)}\n` +
    `收款:区间收款 ${money(p.pay.received)},累计收款 ${money(p.pay.received_all)},未收 ${money(p.pay.receivable)},回款率 ${rate(p.pay.collection_rate)}`
  );
}

function reportPrompt(db, stats) {
  const { range } = stats;
  const F = range.from ?? "0000-01-01";
  const T = range.to ?? "9999-12-31";
  const recent = db.prepare(
    `SELECT f.follow_date, f.stage, f.method, f.content, f.next_plan, f.next_date, o.name AS customer
     FROM followups f JOIN opportunities o ON o.id = f.opportunity_id
     WHERE ${OWNER} = ? AND f.follow_date BETWEEN ? AND ? ORDER BY f.follow_date DESC, f.id DESC LIMIT 10`
  );
  const blocks = stats.people.map(p => {
    const fs = recent
      .all(p.name, F, T)
      .map(f => `  - ${f.follow_date} ${f.customer}【${STAGE_LABEL[f.stage]}·${f.method || "-"}】${clip(f.content, 160)}${f.next_plan ? ` | 下一步:${clip(f.next_plan, 60)}${f.next_date ? `(${f.next_date})` : ""}` : ""}`)
      .join("\n");
    const stale = stats.alerts.stale.filter(o => o.owner === p.name).slice(0, 5).map(o => `${o.name}(${o.stage_label},${o.idle_days}天未跟进)`).join("、");
    return `### ${p.name}\n${personLine(p)}${stale ? `\n久未跟进的商机:${stale}` : ""}\n区间内最近的跟进记录:\n${fs || "  (无)"}`;
  });
  const unpaid = stats.alerts.receivables
    .slice(0, 15)
    .map(c => `- ${c.customer_name} ${c.contract_no}(销售 ${c.owner}):合同 ${money(c.amount)},已收 ${money(c.received)},未收 ${money(c.unpaid)},签约 ${c.sign_date ?? "-"}${c.days_since_sign != null ? `(${c.days_since_sign} 天前)` : ""};付款方式:${clip(c.payment_terms, 80) || "-"}`)
    .join("\n");
  return `【销售分析任务】请根据下面从销售记录中抽取的数据,分析每位销售的商机、跟进过程、成交与收款情况。

统计区间:${range.label};今天 ${stats.today}

## 团队合计
${personLine(stats.team)}

## 每位销售
${blocks.join("\n\n") || "(没有销售数据)"}

## 应收未收合同
${unpaid || "(无)"}

## 输出要求
只输出一个 JSON 对象,不要输出任何其他文字:
{"summary": "团队整体结论(2-3 句)", "team_problems": ["团队层面的问题"], "people": [{"name": "销售姓名(与上面一致)", "score": 0到100的整数, "rating": "优秀/良好/一般/待改进", "highlights": "做得好的地方", "problems": ["具体问题"], "suggestions": ["可执行的改进建议"]}]}
评价依据:跟进是否及时连续、跟进内容是否具体(有客户需求、决策人、预算、下一步)、商机推进与成交率、回款是否及时。只依据上面的数据,不要编造;数据很少时如实说明数据不足。`;
}

function parseAnalysis(reply) {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("数字销售总监没有返回分析结果,请重新生成");
  const j = JSON.parse(reply.slice(start, end + 1));
  const list = v => (Array.isArray(v) ? v.map(x => String(x ?? "").trim()).filter(Boolean) : []);
  return {
    summary: String(j.summary ?? "").trim() || "(没有结论)",
    team_problems: list(j.team_problems),
    people: (Array.isArray(j.people) ? j.people : [])
      .map(p => ({
        name: String(p?.name ?? "").trim(),
        score: Number.isFinite(Number(p?.score)) ? Math.max(0, Math.min(100, Math.round(Number(p.score)))) : null,
        rating: String(p?.rating ?? "").trim(),
        highlights: String(p?.highlights ?? "").trim(),
        problems: list(p?.problems),
        suggestions: list(p?.suggestions),
      }))
      .filter(p => p.name),
  };
}

let running = Promise.resolve();
export function startReport(db, range, createdBy) {
  const busy = db.prepare("SELECT id FROM sales_director_reports WHERE status = 'generating'").get();
  if (busy) throw new HttpError(409, "数字销售总监正在生成另一份报告,请稍候");
  const r = db
    .prepare("INSERT INTO sales_director_reports (period_from, period_to, status, created_by, created_at) VALUES (?,?, 'generating', ?,?)")
    .run(range.from, range.to, createdBy, nowISO());
  const id = Number(r.lastInsertRowid);
  running = running.then(() => runReport(db, id, range)).catch(err => console.error("[sales-director] 报告队列异常", err));
  return { id };
}

async function runReport(db, id, range) {
  const stats = salesStats(db, range);
  try {
    const analysis = parseAnalysis(await askDirector(reportPrompt(db, stats), `sales-report:${id}`, AGENT_KEY));
    db.prepare("UPDATE sales_director_reports SET status = 'done', summary = ?, content = ?, finished_at = ? WHERE id = ?").run(
      analysis.summary, JSON.stringify({ stats, analysis }), nowISO(), id
    );
    for (const role of ["gm", "sales_manager"]) {
      notify(db, { role, type: "sales_report", title: `销售分析报告:${range.label}`, content: analysis.summary, link: `/crm/director?report=${id}` });
    }
  } catch (err) {
    db.prepare("UPDATE sales_director_reports SET status = 'error', summary = ?, content = ?, finished_at = ? WHERE id = ?").run(
      err.message, JSON.stringify({ stats, analysis: null }), nowISO(), id
    );
    console.error(`[sales-director] 报告 ${id} 生成失败:`, err.message);
  }
}

function reportRow(row) {
  if (!row) return row;
  const content = row.content ? JSON.parse(row.content) : null;
  return { ...row, content };
}

// 每周一 09:00 后自动生成上周报告(没有接通大模型或没有商机时跳过)
export function startSalesScheduler(db) {
  db.prepare("UPDATE sales_director_reports SET status = 'error', summary = '服务重启,报告生成中断,请重新生成', finished_at = ? WHERE status = 'generating'").run(nowISO());
  const tick = () => {
    try {
      const now = new Date(Date.now() + 8 * 3600_000);
      if (now.getUTCDay() !== 1 || now.getUTCHours() < 9) return;
      const today = todayCN();
      if (getSetting(db, "sales.last_weekly_report") === today) return;
      setSetting(db, "sales.last_weekly_report", today);
      if (!process.env.PLATFORM_INTERNAL_SECRET) return;
      if (!db.prepare("SELECT 1 FROM opportunities LIMIT 1").get()) return;
      startReport(db, periodOf({ period: "last_week" }), SALES_DIRECTOR_NAME);
    } catch (err) {
      console.error("[sales-director] 定时任务异常", err);
    }
  };
  setTimeout(tick, 8_000);
  setInterval(tick, 10 * 60_000);
}

// ---------- 路由 ----------
export function registerSalesDirectorRoutes(db, add) {
  const canView = user => requireRole(db, user, "sales_manager", "gm");

  add("GET", "/sales/director/overview", ({ user, query }) => {
    canView(user);
    const range = periodOf(query);
    const latest = db.prepare("SELECT id, period_from, period_to, status, summary, created_by, created_at, finished_at FROM sales_director_reports ORDER BY id DESC LIMIT 1").get() ?? null;
    return { name: SALES_DIRECTOR_NAME, agentReady: !!process.env.PLATFORM_INTERNAL_SECRET, latestReport: latest, ...salesStats(db, range) };
  });
  add("GET", "/sales/director/person", ({ user, query }) => {
    canView(user);
    const name = String(query.name ?? "").trim();
    if (!name) throw new HttpError(400, "缺少销售姓名");
    return personDetail(db, name, periodOf(query));
  });
  add("POST", "/sales/director/reports", ({ user, body }) => {
    canView(user);
    if (!process.env.PLATFORM_INTERNAL_SECRET) throw new HttpError(400, "数字销售总监尚未接通平台大模型,请重新部署后再试");
    return startReport(db, periodOf(body), user.name);
  });
  add("GET", "/sales/director/reports", ({ user }) => {
    canView(user);
    return {
      items: db
        .prepare("SELECT id, period_from, period_to, status, summary, created_by, created_at, finished_at FROM sales_director_reports ORDER BY id DESC LIMIT 60")
        .all(),
    };
  });
  add("GET", "/sales/director/reports/:id", ({ user, params }) => {
    canView(user);
    const row = reportRow(db.prepare("SELECT * FROM sales_director_reports WHERE id = ?").get(Number(params.id)));
    if (!row) throw new HttpError(404, "报告不存在");
    return row;
  });
  add("POST", "/sales/director/ask", async ({ user, body }) => {
    canView(user);
    const q = String(body.question ?? "").trim();
    if (!q) throw new HttpError(400, "请填写问题");
    try {
      return { reply: await askDirector(`(提问人:${user.name},今天 ${todayCN()})\n${q}`, `sales-ask:${user.id}`, AGENT_KEY) };
    } catch (err) {
      throw new HttpError(502, err.message);
    }
  });

  // ===== 给数字销售总监 AI 员工用的只读接口(内部令牌鉴权,见 server.mjs) =====
  const brief = p => ({
    销售: p.name,
    商机总数: p.opps.total,
    在跟商机: p.opps.active,
    已成交: p.opps.won,
    已流失: p.opps.lost,
    区间新增商机: p.opps.new_in_period,
    在跟预计金额: p.opps.pipeline_amount,
    区间跟进次数: p.follow.count,
    区间跟进覆盖商机: p.follow.opportunities,
    跟进阶段分布: Object.fromEntries(Object.entries(p.follow.by_stage).map(([k, n]) => [STAGE_LABEL[k], n])),
    最近跟进日期: p.follow.last_date,
    久未跟进商机数: p.follow.stale,
    下次跟进逾期数: p.follow.overdue_next,
    成交率: rate(p.deal.close_rate),
    赢单率: rate(p.deal.win_rate),
    区间签约份数: p.deal.signed_count,
    区间签约金额: p.deal.signed_amount,
    累计签约金额: p.deal.signed_amount_all,
    区间收款: p.pay.received,
    累计收款: p.pay.received_all,
    未收金额: p.pay.receivable,
    回款率: rate(p.pay.collection_rate),
  });
  add("GET", "/agent/sales/stats", ({ query }) => {
    const s = salesStats(db, periodOf(query));
    return { 统计区间: s.range.label, 今天: s.today, 说明: "成交率=已成交商机/全部商机;赢单率=已成交/(已成交+已流失);均为累计口径", 团队合计: brief(s.team), 每位销售: s.people.map(brief) };
  });
  add("GET", "/agent/sales/person", ({ query }) => {
    const name = String(query.name ?? "").trim();
    if (!name) throw new HttpError(400, "缺少销售姓名");
    const d = personDetail(db, name, periodOf(query));
    return {
      统计区间: d.range.label,
      汇总: brief(d.stats),
      商机: d.opportunities.map(o => ({
        客户: o.name, 阶段: o.stage_label, 预计金额: o.expected_amount, 跟进次数: o.followup_count, 最近跟进: o.last_follow,
        未跟进天数: o.idle_days, 下次跟进: o.next_date, 签约金额: o.signed_amount, 已收款: o.received,
      })),
      区间跟进记录: d.followups.slice(0, 30).map(f => ({ 日期: f.follow_date, 客户: f.opportunity_name, 阶段: f.stage_label, 方式: f.method, 内容: clip(f.content, 200), 下一步: f.next_plan, 下次日期: f.next_date })),
      区间收款: d.payments,
    };
  });
  add("GET", "/agent/sales/alerts", () => {
    const s = salesStats(db, periodOf({ period: "all" }));
    return {
      今天: s.today,
      [`超过${STALE_DAYS}天未跟进`]: s.alerts.stale.map(o => ({ 客户: o.name, 销售: o.owner, 阶段: o.stage_label, 未跟进天数: o.idle_days })),
      下次跟进逾期: s.alerts.overdueNext.map(o => ({ 客户: o.name, 销售: o.owner, 约定日期: o.next_date, 逾期天数: o.next_overdue_days, 计划: o.next_plan })),
      应收未收: s.alerts.receivables.map(c => ({ 客户: c.customer_name, 合同: c.contract_no, 销售: c.owner, 合同金额: c.amount, 已收: c.received, 未收: c.unpaid, 签约日期: c.sign_date, 付款方式: c.payment_terms })),
    };
  });
}
