// 销售管理独立数据库(SQLite,node:sqlite 内置,零依赖)。不碰平台的 MySQL 库。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TEMPLATE_HTML } from "./contract.mjs";
import { nowISO } from "./util.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS opportunities (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_code      TEXT NOT NULL UNIQUE,          -- 统一社会信用代码,一家企业只能有一条商机
  name             TEXT NOT NULL,
  name_key         TEXT NOT NULL UNIQUE,          -- 企业名查重键(见 util.companyNameKey)
  legal_person     TEXT,
  reg_status       TEXT,
  reg_capital      TEXT,
  establish_date   TEXT,
  address          TEXT,
  business_scope   TEXT,
  industry         TEXT,
  info_source      TEXT NOT NULL DEFAULT 'manual', -- tianyancha | qichacha | manual
  contact_name     TEXT,
  contact_title    TEXT,
  contact_phone    TEXT,
  lead_source      TEXT,                          -- 商机来源渠道
  owner            TEXT,                          -- 负责销售
  stage            TEXT NOT NULL DEFAULT 'new',
  expected_amount  REAL,
  expected_close   TEXT,
  remark           TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS followups (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id   INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  stage            TEXT NOT NULL,                 -- initial_visit | requirement | proposal | negotiation
  follow_date      TEXT NOT NULL,
  method           TEXT,
  contact_name     TEXT,
  content          TEXT NOT NULL,
  next_plan        TEXT,
  next_date        TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followups_opp ON followups(opportunity_id, follow_date);

CREATE TABLE IF NOT EXISTS contract_templates (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  body             TEXT NOT NULL,
  is_default       INTEGER NOT NULL DEFAULT 0,
  updated_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_no      TEXT NOT NULL UNIQUE,
  opportunity_id   INTEGER NOT NULL REFERENCES opportunities(id),
  template_id      INTEGER REFERENCES contract_templates(id),
  project_name     TEXT NOT NULL,
  amount           REAL NOT NULL,
  sign_date        TEXT,
  start_date       TEXT,
  end_date         TEXT,
  payment_terms    TEXT,
  modules          TEXT NOT NULL DEFAULT '[]',    -- JSON: [{name, description, amount}]
  extra_terms      TEXT,
  content          TEXT NOT NULL,                 -- 按模板渲染后的合同正文(HTML 快照)
  status           TEXT NOT NULL DEFAULT 'draft', -- draft | signed | void
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contracts_opp ON contracts(opportunity_id);

CREATE TABLE IF NOT EXISTS handovers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  handover_no         TEXT NOT NULL UNIQUE,
  contract_id         INTEGER NOT NULL UNIQUE REFERENCES contracts(id), -- 一份合同一张交接单
  modules             TEXT NOT NULL DEFAULT '[]', -- JSON: [{name, description}]
  main_requirements   TEXT NOT NULL,
  value_points        TEXT NOT NULL,
  risk_points         TEXT NOT NULL,
  impl_owner          TEXT,                       -- 实施负责人
  handover_date       TEXT NOT NULL,
  remark              TEXT,
  status              TEXT NOT NULL DEFAULT 'pending', -- pending | received
  received_by         TEXT,
  received_at         TEXT,
  received_note       TEXT,
  created_by          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contract_payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id  INTEGER NOT NULL REFERENCES contracts(id),
  amount       REAL NOT NULL,
  pay_date     TEXT NOT NULL,
  method       TEXT,                              -- 银行转账 / 支票 / 现金 / 其他
  remark       TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_contract ON contract_payments(contract_id, pay_date);

-- ===== 数字销售总监 =====
CREATE TABLE IF NOT EXISTS sales_director_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  period_from  TEXT,                              -- NULL = 不限
  period_to    TEXT,
  status       TEXT NOT NULL DEFAULT 'generating', -- generating | done | error
  summary      TEXT,
  content      TEXT,                              -- JSON:{stats, analysis}
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- ===== 实施管理 =====
CREATE TABLE IF NOT EXISTS impl_members (
  user_id     INTEGER PRIMARY KEY,               -- 平台后台账号 id
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,                     -- director 实施总监 | consultant 实施顾问 | gm 总经理
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS impl_projects (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_no       TEXT NOT NULL UNIQUE,
  handover_id      INTEGER NOT NULL UNIQUE REFERENCES handovers(id),
  name             TEXT NOT NULL,
  customer_name    TEXT NOT NULL,
  consultant_id    INTEGER NOT NULL,
  consultant_name  TEXT NOT NULL,
  assigned_by      TEXT,
  planned_start    TEXT NOT NULL,
  planned_end      TEXT NOT NULL,                -- 要求的实施完成时间
  status           TEXT NOT NULL DEFAULT 'assigned', -- assigned 待接收 | in_progress 实施中 | completed 已完成
  remark           TEXT,
  assigned_at      TEXT NOT NULL,
  accepted_at      TEXT,
  completed_at     TEXT,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS impl_stages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES impl_projects(id) ON DELETE CASCADE,
  stage_key     TEXT NOT NULL,                   -- prepare | blueprint | golive | acceptance
  seq           INTEGER NOT NULL,
  planned_end   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | in_progress | done
  progress      INTEGER NOT NULL DEFAULT 0,      -- 最近一次汇报的阶段进度 %
  started_at    TEXT,
  completed_at  TEXT,
  UNIQUE (project_id, stage_key)
);

CREATE TABLE IF NOT EXISTS impl_reports (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES impl_projects(id) ON DELETE CASCADE,
  stage_key        TEXT NOT NULL,
  report_date      TEXT NOT NULL,
  progress         INTEGER NOT NULL,
  work_content     TEXT NOT NULL,
  completed_items  TEXT,
  problems         TEXT,
  next_plan        TEXT,
  request_complete INTEGER NOT NULL DEFAULT 0,   -- 申请本阶段完成
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  review_status    TEXT NOT NULL DEFAULT 'pending', -- pending 审核中 | passed | failed | error
  review_score     INTEGER,
  review_summary   TEXT,
  review_issues    TEXT NOT NULL DEFAULT '[]',   -- JSON [{problem, norm, suggestion, severity}]
  reviewed_by      TEXT,
  reviewed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_impl_reports_project ON impl_reports(project_id, stage_key);

CREATE TABLE IF NOT EXISTS impl_files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER REFERENCES impl_projects(id) ON DELETE CASCADE, -- NULL = 公司项目管理规范
  stage_key    TEXT,
  filename     TEXT NOT NULL,
  stored_name  TEXT NOT NULL,
  size         INTEGER NOT NULL,
  text_excerpt TEXT,                             -- 可提取文字的文档(txt/md/docx)前若干字,供数字总监审核
  uploaded_by  TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS impl_delays (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES impl_projects(id) ON DELETE CASCADE,
  stage_key       TEXT,                          -- NULL = 项目整体超期
  due_date        TEXT NOT NULL,
  detected_at     TEXT NOT NULL,
  last_reminded   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'awaiting_plan', -- awaiting_plan 待提交方案 | submitted 待审批 | approved | rejected | resolved
  plan_reason     TEXT,
  plan_new_date   TEXT,
  plan_measures   TEXT,
  submitted_at    TEXT,
  decided_by      TEXT,
  decided_at      TEXT,
  decision_note   TEXT
);
CREATE INDEX IF NOT EXISTS idx_impl_delays_project ON impl_delays(project_id, status);

CREATE TABLE IF NOT EXISTS impl_issues (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES impl_projects(id) ON DELETE CASCADE,
  stage_key    TEXT,
  report_id    INTEGER REFERENCES impl_reports(id) ON DELETE SET NULL,
  problem      TEXT NOT NULL,
  norm         TEXT,
  suggestion   TEXT,
  severity     TEXT NOT NULL DEFAULT '中',
  status       TEXT NOT NULL DEFAULT 'open',     -- open | resolved
  resolved_by  TEXT,
  resolved_at  TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS impl_issue_lists (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  list_date    TEXT NOT NULL UNIQUE,             -- 每天一份,当天有新问题时更新
  summary      TEXT NOT NULL,
  content      TEXT NOT NULL,                    -- JSON 快照
  read_at      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS impl_notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id    INTEGER,                       -- NULL = 发给某个角色
  recipient_role  TEXT,
  type            TEXT NOT NULL,                 -- delay_reminder | review_failed | review_passed | issue_list | delay_decision | assigned
  title           TEXT NOT NULL,
  content         TEXT,
  link            TEXT,
  read_at         TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_impl_notifications_recipient ON impl_notifications(recipient_id, read_at);
`;

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function seed(db) {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM contract_templates").get();
  if (n === 0) {
    const now = nowISO();
    db.prepare(
      "INSERT INTO contract_templates (name, body, is_default, updated_by, created_at, updated_at) VALUES (?, ?, 1, 'system', ?, ?)"
    ).run("通用销售合同", DEFAULT_TEMPLATE_HTML, now, now);
  }
}

// 事务封装:fn 抛错则回滚
export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// 按日生成单号:前缀 + YYYYMMDD + 3 位流水,如 HT20261010001
export function nextSerialNo(db, table, column, prefix, dateStr) {
  const base = prefix + dateStr.replace(/-/g, "");
  const row = db
    .prepare(`SELECT ${column} AS no FROM ${table} WHERE ${column} LIKE ? ORDER BY ${column} DESC LIMIT 1`)
    .get(base + "%");
  const seq = row ? Number(String(row.no).slice(base.length)) + 1 : 1;
  return base + String(seq).padStart(3, "0");
}
