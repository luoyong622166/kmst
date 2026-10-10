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

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
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
