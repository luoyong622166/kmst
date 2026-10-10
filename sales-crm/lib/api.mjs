// 销售管理 REST 接口:商机 / 客户跟进 / 销售合同(含模板、我方信息) / 销售交接
import { nextSerialNo, tx } from "./db.mjs";
import { PLACEHOLDERS, renderContract } from "./contract.mjs";
import { companyDetail, lookupProvider, searchCompanies } from "./lookup.mjs";
import { companyNameKey, isValidCreditCode, normalizeCreditCode, nowISO, todayCN } from "./util.mjs";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const OPP_STAGES = [
  { key: "new", label: "新商机" },
  { key: "initial_visit", label: "初次拜访" },
  { key: "requirement", label: "需求分析" },
  { key: "proposal", label: "方案提供" },
  { key: "negotiation", label: "商务谈判" },
  { key: "won", label: "已成交" },
  { key: "lost", label: "已流失" },
];
const FOLLOW_STAGES = ["initial_visit", "requirement", "proposal", "negotiation"];
const STAGE_ORDER = Object.fromEntries(OPP_STAGES.map((s, i) => [s.key, i]));

const COMPANY_KEYS = ["name", "credit_code", "address", "contact", "phone", "bank_name", "bank_account"];

// ---------- 小工具 ----------
function str(v) {
  return v == null ? null : String(v).trim() || null;
}

function required(body, field, label) {
  const v = str(body[field]);
  if (!v) throw new HttpError(400, `请填写${label}`);
  return v;
}

function money(v, label, { optional = false } = {}) {
  if (optional && (v === "" || v == null)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${label}格式不正确`);
  return Math.round(n * 100) / 100;
}

function date(v, label, { optional = true } = {}) {
  const s = str(v);
  if (!s) {
    if (optional) return null;
    throw new HttpError(400, `请填写${label}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, `${label}格式应为 YYYY-MM-DD`);
  return s;
}

function paging(q) {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function like(keyword) {
  return `%${String(keyword).replace(/[%_\\]/g, m => "\\" + m)}%`;
}

function parseModules(v, withAmount) {
  if (!Array.isArray(v)) return [];
  return v
    .map(m => ({
      name: str(m?.name) ?? "",
      description: str(m?.description) ?? "",
      ...(withAmount ? { amount: m?.amount === "" || m?.amount == null ? "" : money(m.amount, "模块金额") } : {}),
    }))
    .filter(m => m.name);
}

function getOr404(db, sql, id, what) {
  const row = db.prepare(sql).get(id);
  if (!row) throw new HttpError(404, `${what}不存在`);
  return row;
}

function getCompany(db) {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'company.%'").all();
  const company = Object.fromEntries(COMPANY_KEYS.map(k => [k, ""]));
  for (const r of rows) company[r.key.slice(8)] = r.value ?? "";
  if (!company.name) company.name = process.env.CRM_COMPANY_NAME || "";
  return company;
}

// ---------- 商机 ----------
const OPP_FIELDS = [
  "legal_person", "reg_status", "reg_capital", "establish_date", "address", "business_scope", "industry",
  "contact_name", "contact_title", "contact_phone", "lead_source", "owner", "expected_close", "remark",
];

function findDuplicate(db, creditCode, nameKey, excludeId = 0) {
  return db
    .prepare("SELECT id, name, credit_code, owner FROM opportunities WHERE (credit_code = ? OR name_key = ?) AND id != ?")
    .get(creditCode, nameKey, excludeId);
}

function duplicateMessage(dup) {
  return `该企业已存在商机「${dup.name}」(${dup.credit_code}${dup.owner ? ",负责人 " + dup.owner : ""}),同一企业不能重复录入`;
}

function oppPayload(body) {
  const credit_code = normalizeCreditCode(body.credit_code);
  if (!credit_code) throw new HttpError(400, "请填写统一社会信用代码");
  if (!isValidCreditCode(credit_code)) throw new HttpError(400, "统一社会信用代码校验不通过,请核对是否填错");
  const name = required(body, "name", "企业名称");
  const data = { credit_code, name, name_key: companyNameKey(name) };
  for (const f of OPP_FIELDS) data[f] = str(body[f]);
  data.expected_amount = money(body.expected_amount, "预计金额", { optional: true });
  data.expected_close = date(body.expected_close, "预计成交日期");
  data.info_source = ["tianyancha", "qichacha"].includes(body.info_source) ? body.info_source : "manual";
  return data;
}

function listOpportunities(db, q) {
  const where = [];
  const args = [];
  if (q.keyword) {
    where.push("(o.name LIKE ? ESCAPE '\\' OR o.credit_code LIKE ? ESCAPE '\\' OR o.contact_name LIKE ? ESCAPE '\\')");
    args.push(like(q.keyword), like(q.keyword), like(q.keyword));
  }
  if (q.stage) {
    where.push("o.stage = ?");
    args.push(q.stage);
  }
  if (q.owner) {
    where.push("o.owner = ?");
    args.push(q.owner);
  }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const { pageSize, offset, page } = paging(q);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM opportunities o ${w}`).get(...args).n;
  const items = db
    .prepare(
      `SELECT o.*,
         (SELECT COUNT(*) FROM followups f WHERE f.opportunity_id = o.id) AS followup_count,
         (SELECT MAX(follow_date) FROM followups f WHERE f.opportunity_id = o.id) AS last_follow_date
       FROM opportunities o ${w} ORDER BY o.updated_at DESC LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, offset);
  return { items, total, page, pageSize };
}

// ---------- 跟进 ----------
function listFollowups(db, q) {
  const where = [];
  const args = [];
  if (q.opportunityId) {
    where.push("f.opportunity_id = ?");
    args.push(Number(q.opportunityId));
  }
  if (q.stage) {
    where.push("f.stage = ?");
    args.push(q.stage);
  }
  if (q.keyword) {
    where.push("(o.name LIKE ? ESCAPE '\\' OR f.content LIKE ? ESCAPE '\\')");
    args.push(like(q.keyword), like(q.keyword));
  }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const { pageSize, offset, page } = paging(q);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM followups f JOIN opportunities o ON o.id = f.opportunity_id ${w}`).get(...args).n;
  const items = db
    .prepare(
      `SELECT f.*, o.name AS opportunity_name, o.stage AS opportunity_stage
       FROM followups f JOIN opportunities o ON o.id = f.opportunity_id ${w}
       ORDER BY f.follow_date DESC, f.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, offset);
  return { items, total, page, pageSize };
}

// ---------- 合同 ----------
function contractPayload(db, body) {
  const opportunity_id = Number(body.opportunity_id);
  const opportunity = getOr404(db, "SELECT * FROM opportunities WHERE id = ?", opportunity_id, "商机");
  if (opportunity.stage === "lost") throw new HttpError(400, "已流失的商机不能生成合同");
  const template_id = Number(body.template_id) || db.prepare("SELECT id FROM contract_templates ORDER BY is_default DESC, id LIMIT 1").get()?.id;
  const template = getOr404(db, "SELECT * FROM contract_templates WHERE id = ?", template_id, "合同模板");
  const contract = {
    opportunity_id,
    template_id,
    project_name: required(body, "project_name", "项目名称"),
    amount: money(body.amount, "合同金额"),
    sign_date: date(body.sign_date, "签订日期"),
    start_date: date(body.start_date, "服务开始日期"),
    end_date: date(body.end_date, "服务结束日期"),
    payment_terms: str(body.payment_terms),
    modules: parseModules(body.modules, true),
    extra_terms: str(body.extra_terms),
  };
  if (!(contract.amount > 0)) throw new HttpError(400, "合同金额必须大于 0");
  if (!contract.modules.length) throw new HttpError(400, "请至少填写一个产品模块");
  return { contract, opportunity, template };
}

function renderFor(db, contractNo, { contract, opportunity, template }) {
  return renderContract(template.body, { contractNo, contract, opportunity, company: getCompany(db) });
}

function contractRow(row) {
  return row && { ...row, modules: JSON.parse(row.modules || "[]") };
}

function listContracts(db, q) {
  const where = [];
  const args = [];
  if (q.keyword) {
    where.push("(c.contract_no LIKE ? ESCAPE '\\' OR c.project_name LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\')");
    args.push(like(q.keyword), like(q.keyword), like(q.keyword));
  }
  if (q.status) {
    where.push("c.status = ?");
    args.push(q.status);
  }
  if (q.opportunityId) {
    where.push("c.opportunity_id = ?");
    args.push(Number(q.opportunityId));
  }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const { pageSize, offset, page } = paging(q);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM contracts c JOIN opportunities o ON o.id = c.opportunity_id ${w}`).get(...args).n;
  const items = db
    .prepare(
      `SELECT c.id, c.contract_no, c.opportunity_id, c.project_name, c.amount, c.sign_date, c.status, c.modules,
              c.created_by, c.created_at, o.name AS customer_name, h.id AS handover_id, h.status AS handover_status
       FROM contracts c JOIN opportunities o ON o.id = c.opportunity_id
       LEFT JOIN handovers h ON h.contract_id = c.id ${w}
       ORDER BY c.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, offset)
    .map(contractRow);
  return { items, total, page, pageSize };
}

// ---------- 交接 ----------
function handoverPayload(body) {
  return {
    modules: parseModules(body.modules, false),
    main_requirements: required(body, "main_requirements", "主要需求"),
    value_points: required(body, "value_points", "主要交接的价值点"),
    risk_points: required(body, "risk_points", "主要风险点"),
    impl_owner: str(body.impl_owner),
    handover_date: date(body.handover_date, "交接日期", { optional: false }),
    remark: str(body.remark),
  };
}

const HANDOVER_SELECT = `SELECT h.*, c.contract_no, c.project_name, c.amount, c.sign_date, c.start_date, c.end_date,
    o.id AS opportunity_id, o.name AS customer_name, o.contact_name, o.contact_phone, o.owner AS sales_owner
  FROM handovers h JOIN contracts c ON c.id = h.contract_id JOIN opportunities o ON o.id = c.opportunity_id`;

function handoverRow(row) {
  return row && { ...row, modules: JSON.parse(row.modules || "[]") };
}

// ---------- 路由表 ----------
export function buildRoutes(db) {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    routes.push({ method, re, keys, handler });
  };

  add("GET", "/meta", ({ user }) => ({
    user: { id: user.id, name: user.name, role: user.role },
    stages: OPP_STAGES,
    followStages: OPP_STAGES.filter(s => FOLLOW_STAGES.includes(s.key)),
    lookupProvider: lookupProvider(),
    placeholders: PLACEHOLDERS,
  }));

  add("GET", "/stats", () => {
    const byStage = db.prepare("SELECT stage, COUNT(*) AS n FROM opportunities GROUP BY stage").all();
    const contract = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM contracts WHERE status = 'signed'").get();
    const pendingHandover = db.prepare("SELECT COUNT(*) AS n FROM handovers WHERE status = 'pending'").get().n;
    const toHandover = db
      .prepare("SELECT COUNT(*) AS n FROM contracts c LEFT JOIN handovers h ON h.contract_id = c.id WHERE c.status = 'signed' AND h.id IS NULL")
      .get().n;
    return { byStage, signedContracts: contract.n, signedAmount: contract.amount, pendingHandover, toHandover };
  });

  // 工商信息
  add("GET", "/lookup/search", async ({ query }) => {
    const keyword = str(query.keyword);
    if (!keyword || keyword.length < 2) throw new HttpError(400, "请输入至少 2 个字的企业名称");
    const items = await searchCompanies(keyword);
    return { items: items.map(it => ({ ...it, existing: it.creditCode ? findDuplicate(db, normalizeCreditCode(it.creditCode), companyNameKey(it.name)) ?? null : null })) };
  });
  add("GET", "/lookup/detail", async ({ query }) => {
    const keyword = str(query.keyword);
    if (!keyword) throw new HttpError(400, "缺少企业名称或信用代码");
    const detail = await companyDetail(keyword);
    if (!detail) throw new HttpError(404, "没有查到这家企业,请核对名称");
    return detail;
  });

  // 商机
  add("GET", "/opportunities/check", ({ query }) => {
    const code = normalizeCreditCode(query.creditCode);
    const nameKey = companyNameKey(query.name);
    const dup = findDuplicate(db, code || "\u0000", nameKey || "\u0000", Number(query.excludeId) || 0);
    return { creditCodeValid: code ? isValidCreditCode(code) : null, duplicate: dup ?? null, message: dup ? duplicateMessage(dup) : null };
  });
  add("GET", "/opportunities/owners", () => ({
    items: db.prepare("SELECT DISTINCT owner FROM opportunities WHERE owner IS NOT NULL ORDER BY owner").all().map(r => r.owner),
  }));
  add("GET", "/opportunities", ({ query }) => listOpportunities(db, query));
  add("POST", "/opportunities", ({ body, user }) => {
    const data = oppPayload(body);
    const dup = findDuplicate(db, data.credit_code, data.name_key);
    if (dup) throw new HttpError(409, duplicateMessage(dup));
    const now = nowISO();
    data.owner = data.owner || user.name;
    const cols = [...Object.keys(data), "stage", "created_by", "created_at", "updated_at"];
    const vals = [...Object.values(data), "new", user.name, now, now];
    const r = db.prepare(`INSERT INTO opportunities (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...vals);
    return db.prepare("SELECT * FROM opportunities WHERE id = ?").get(r.lastInsertRowid);
  });
  add("GET", "/opportunities/:id", ({ params }) => {
    const opp = getOr404(db, "SELECT * FROM opportunities WHERE id = ?", Number(params.id), "商机");
    opp.followups = db.prepare("SELECT * FROM followups WHERE opportunity_id = ? ORDER BY follow_date DESC, id DESC").all(opp.id);
    opp.contracts = db.prepare("SELECT id, contract_no, project_name, amount, status, sign_date FROM contracts WHERE opportunity_id = ? ORDER BY id DESC").all(opp.id);
    return opp;
  });
  add("PUT", "/opportunities/:id", ({ params, body }) => {
    const id = Number(params.id);
    getOr404(db, "SELECT id FROM opportunities WHERE id = ?", id, "商机");
    const data = oppPayload(body);
    const dup = findDuplicate(db, data.credit_code, data.name_key, id);
    if (dup) throw new HttpError(409, duplicateMessage(dup));
    if (body.stage !== undefined) {
      if (!(body.stage in STAGE_ORDER)) throw new HttpError(400, "商机阶段不正确");
      data.stage = body.stage;
    }
    data.updated_at = nowISO();
    db.prepare(`UPDATE opportunities SET ${Object.keys(data).map(k => `${k} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(data), id);
    return db.prepare("SELECT * FROM opportunities WHERE id = ?").get(id);
  });
  add("DELETE", "/opportunities/:id", ({ params }) => {
    const id = Number(params.id);
    getOr404(db, "SELECT id FROM opportunities WHERE id = ?", id, "商机");
    if (db.prepare("SELECT 1 FROM contracts WHERE opportunity_id = ?").get(id)) throw new HttpError(400, "该商机已有销售合同,不能删除");
    db.prepare("DELETE FROM opportunities WHERE id = ?").run(id);
    return { ok: true };
  });

  // 跟进
  add("GET", "/followups", ({ query }) => listFollowups(db, query));
  add("POST", "/followups", ({ body, user }) => {
    const opp = getOr404(db, "SELECT * FROM opportunities WHERE id = ?", Number(body.opportunity_id), "商机");
    if (!FOLLOW_STAGES.includes(body.stage)) throw new HttpError(400, "请选择跟进阶段");
    const data = {
      opportunity_id: opp.id,
      stage: body.stage,
      follow_date: date(body.follow_date, "跟进日期", { optional: false }),
      method: str(body.method),
      contact_name: str(body.contact_name),
      content: required(body, "content", "跟进内容"),
      next_plan: str(body.next_plan),
      next_date: date(body.next_date, "下次跟进日期"),
    };
    return tx(db, () => {
      const now = nowISO();
      const r = db
        .prepare(
          "INSERT INTO followups (opportunity_id, stage, follow_date, method, contact_name, content, next_plan, next_date, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
        )
        .run(...Object.values(data), user.name, now);
      // 跟进推进到更后的阶段时,商机阶段随之前进(已成交/已流失不动)
      const advance = !["won", "lost"].includes(opp.stage) && STAGE_ORDER[data.stage] > STAGE_ORDER[opp.stage];
      db.prepare("UPDATE opportunities SET stage = ?, updated_at = ? WHERE id = ?").run(advance ? data.stage : opp.stage, now, opp.id);
      return db.prepare("SELECT * FROM followups WHERE id = ?").get(r.lastInsertRowid);
    });
  });
  add("DELETE", "/followups/:id", ({ params }) => {
    const id = Number(params.id);
    getOr404(db, "SELECT id FROM followups WHERE id = ?", id, "跟进记录");
    db.prepare("DELETE FROM followups WHERE id = ?").run(id);
    return { ok: true };
  });

  // 合同模板 & 我方信息
  add("GET", "/templates", () => ({ items: db.prepare("SELECT * FROM contract_templates ORDER BY is_default DESC, id").all() }));
  add("POST", "/templates", ({ body, user }) => {
    const now = nowISO();
    const r = db
      .prepare("INSERT INTO contract_templates (name, body, is_default, updated_by, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)")
      .run(required(body, "name", "模板名称"), required(body, "body", "模板正文"), user.name, now, now);
    return db.prepare("SELECT * FROM contract_templates WHERE id = ?").get(r.lastInsertRowid);
  });
  add("PUT", "/templates/:id", ({ params, body, user }) => {
    const id = Number(params.id);
    getOr404(db, "SELECT id FROM contract_templates WHERE id = ?", id, "合同模板");
    tx(db, () => {
      if (body.is_default) db.prepare("UPDATE contract_templates SET is_default = 0").run();
      db.prepare(
        "UPDATE contract_templates SET name = ?, body = ?, is_default = CASE WHEN ? THEN 1 ELSE is_default END, updated_by = ?, updated_at = ? WHERE id = ?"
      ).run(required(body, "name", "模板名称"), required(body, "body", "模板正文"), body.is_default ? 1 : 0, user.name, nowISO(), id);
    });
    return db.prepare("SELECT * FROM contract_templates WHERE id = ?").get(id);
  });
  add("DELETE", "/templates/:id", ({ params }) => {
    const id = Number(params.id);
    const t = getOr404(db, "SELECT * FROM contract_templates WHERE id = ?", id, "合同模板");
    if (t.is_default) throw new HttpError(400, "默认模板不能删除,请先把其他模板设为默认");
    if (db.prepare("SELECT 1 FROM contracts WHERE template_id = ?").get(id)) throw new HttpError(400, "已有合同使用该模板,不能删除");
    db.prepare("DELETE FROM contract_templates WHERE id = ?").run(id);
    return { ok: true };
  });
  add("GET", "/settings/company", () => getCompany(db));
  add("PUT", "/settings/company", ({ body }) => {
    const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    tx(db, () => COMPANY_KEYS.forEach(k => stmt.run("company." + k, str(body[k]) ?? "")));
    return getCompany(db);
  });

  // 合同
  add("GET", "/contracts", ({ query }) => listContracts(db, query));
  add("POST", "/contracts/preview", ({ body }) => {
    const p = contractPayload(db, body);
    return { content: renderFor(db, "(保存后生成)", p) };
  });
  add("POST", "/contracts", ({ body, user }) => {
    const p = contractPayload(db, body);
    return tx(db, () => {
      const now = nowISO();
      const no = nextSerialNo(db, "contracts", "contract_no", "HT", todayCN());
      const c = p.contract;
      const r = db
        .prepare(
          `INSERT INTO contracts (contract_no, opportunity_id, template_id, project_name, amount, sign_date, start_date, end_date,
             payment_terms, modules, extra_terms, content, status, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,?)`
        )
        .run(no, c.opportunity_id, c.template_id, c.project_name, c.amount, c.sign_date, c.start_date, c.end_date,
          c.payment_terms, JSON.stringify(c.modules), c.extra_terms, renderFor(db, no, p), user.name, now, now);
      return contractRow(db.prepare("SELECT * FROM contracts WHERE id = ?").get(r.lastInsertRowid));
    });
  });
  add("GET", "/contracts/:id", ({ params }) => {
    const c = contractRow(getOr404(db, "SELECT * FROM contracts WHERE id = ?", Number(params.id), "合同"));
    c.opportunity = db.prepare("SELECT id, name, credit_code, contact_name, contact_phone, owner, stage FROM opportunities WHERE id = ?").get(c.opportunity_id);
    c.handover = db.prepare("SELECT id, handover_no, status FROM handovers WHERE contract_id = ?").get(c.id) ?? null;
    return c;
  });
  add("PUT", "/contracts/:id", ({ params, body }) => {
    const id = Number(params.id);
    const old = getOr404(db, "SELECT * FROM contracts WHERE id = ?", id, "合同");
    if (old.status !== "draft") throw new HttpError(400, "只有草稿状态的合同可以修改");
    const p = contractPayload(db, { ...body, opportunity_id: old.opportunity_id });
    const c = p.contract;
    db.prepare(
      `UPDATE contracts SET template_id = ?, project_name = ?, amount = ?, sign_date = ?, start_date = ?, end_date = ?,
         payment_terms = ?, modules = ?, extra_terms = ?, content = ?, updated_at = ? WHERE id = ?`
    ).run(c.template_id, c.project_name, c.amount, c.sign_date, c.start_date, c.end_date, c.payment_terms,
      JSON.stringify(c.modules), c.extra_terms, renderFor(db, old.contract_no, p), nowISO(), id);
    return contractRow(db.prepare("SELECT * FROM contracts WHERE id = ?").get(id));
  });
  add("POST", "/contracts/:id/sign", ({ params, body }) => {
    const id = Number(params.id);
    const c = getOr404(db, "SELECT * FROM contracts WHERE id = ?", id, "合同");
    if (c.status !== "draft") throw new HttpError(400, "只有草稿状态的合同可以确认签订");
    const signDate = date(body.sign_date, "签订日期") || c.sign_date || todayCN();
    tx(db, () => {
      const now = nowISO();
      db.prepare("UPDATE contracts SET status = 'signed', sign_date = ?, updated_at = ? WHERE id = ?").run(signDate, now, id);
      db.prepare("UPDATE opportunities SET stage = 'won', updated_at = ? WHERE id = ?").run(now, c.opportunity_id);
    });
    return contractRow(db.prepare("SELECT * FROM contracts WHERE id = ?").get(id));
  });
  add("POST", "/contracts/:id/void", ({ params }) => {
    const id = Number(params.id);
    const c = getOr404(db, "SELECT * FROM contracts WHERE id = ?", id, "合同");
    if (c.status === "void") throw new HttpError(400, "合同已作废");
    if (db.prepare("SELECT 1 FROM handovers WHERE contract_id = ?").get(id)) throw new HttpError(400, "该合同已生成交接单,不能作废");
    db.prepare("UPDATE contracts SET status = 'void', updated_at = ? WHERE id = ?").run(nowISO(), id);
    return contractRow(db.prepare("SELECT * FROM contracts WHERE id = ?").get(id));
  });

  // 交接
  add("GET", "/handovers", ({ query }) => {
    const where = [];
    const args = [];
    if (query.keyword) {
      where.push("(h.handover_no LIKE ? ESCAPE '\\' OR c.contract_no LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\')");
      args.push(like(query.keyword), like(query.keyword), like(query.keyword));
    }
    if (query.status) {
      where.push("h.status = ?");
      args.push(query.status);
    }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const { pageSize, offset, page } = paging(query);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM handovers h JOIN contracts c ON c.id = h.contract_id JOIN opportunities o ON o.id = c.opportunity_id ${w}`).get(...args).n;
    const items = db.prepare(`${HANDOVER_SELECT} ${w} ORDER BY h.id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, offset).map(handoverRow);
    return { items, total, page, pageSize };
  });
  add("POST", "/handovers", ({ body, user }) => {
    const contract = getOr404(db, "SELECT * FROM contracts WHERE id = ?", Number(body.contract_id), "合同");
    if (contract.status !== "signed") throw new HttpError(400, "只有已签订的合同才能移交实施");
    if (db.prepare("SELECT 1 FROM handovers WHERE contract_id = ?").get(contract.id)) throw new HttpError(409, "该合同已有交接单");
    const h = handoverPayload(body);
    if (!h.modules.length) h.modules = JSON.parse(contract.modules).map(m => ({ name: m.name, description: m.description }));
    return tx(db, () => {
      const now = nowISO();
      const no = nextSerialNo(db, "handovers", "handover_no", "JJ", todayCN());
      const r = db
        .prepare(
          `INSERT INTO handovers (handover_no, contract_id, modules, main_requirements, value_points, risk_points, impl_owner,
             handover_date, remark, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?, 'pending', ?,?,?)`
        )
        .run(no, contract.id, JSON.stringify(h.modules), h.main_requirements, h.value_points, h.risk_points, h.impl_owner,
          h.handover_date, h.remark, user.name, now, now);
      return handoverRow(db.prepare(`${HANDOVER_SELECT} WHERE h.id = ?`).get(r.lastInsertRowid));
    });
  });
  add("GET", "/handovers/:id", ({ params }) => handoverRow(getOr404(db, `${HANDOVER_SELECT} WHERE h.id = ?`, Number(params.id), "交接单")));
  add("PUT", "/handovers/:id", ({ params, body }) => {
    const id = Number(params.id);
    const old = getOr404(db, "SELECT * FROM handovers WHERE id = ?", id, "交接单");
    if (old.status !== "pending") throw new HttpError(400, "实施部已接收的交接单不能再修改");
    const h = handoverPayload(body);
    db.prepare(
      `UPDATE handovers SET modules = ?, main_requirements = ?, value_points = ?, risk_points = ?, impl_owner = ?,
         handover_date = ?, remark = ?, updated_at = ? WHERE id = ?`
    ).run(JSON.stringify(h.modules), h.main_requirements, h.value_points, h.risk_points, h.impl_owner, h.handover_date, h.remark, nowISO(), id);
    return handoverRow(db.prepare(`${HANDOVER_SELECT} WHERE h.id = ?`).get(id));
  });
  add("POST", "/handovers/:id/receive", ({ params, body, user }) => {
    const id = Number(params.id);
    const old = getOr404(db, "SELECT * FROM handovers WHERE id = ?", id, "交接单");
    if (old.status !== "pending") throw new HttpError(400, "该交接单已被接收");
    const now = nowISO();
    db.prepare("UPDATE handovers SET status = 'received', received_by = ?, received_at = ?, received_note = ?, updated_at = ? WHERE id = ?").run(
      user.name, now, str(body.note), now, id
    );
    return handoverRow(db.prepare(`${HANDOVER_SELECT} WHERE h.id = ?`).get(id));
  });

  return routes;
}
