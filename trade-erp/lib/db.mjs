// 进出口贸易系统数据库(SQLite,node:sqlite 内置)。
// 所有业务单据统一存 records 表(data 为 JSON),字段定义见 meta.mjs;额度、库存等台账单独建表便于汇总。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { hashPassword, nowBJ } from "./util.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password      TEXT NOT NULL,
  roles         TEXT NOT NULL DEFAULT '[]',     -- JSON 数组:admin biz risk legal finance manager portal
  dept          TEXT NOT NULL DEFAULT '',
  partner_id    INTEGER,                        -- 门户账号绑定的客商
  enabled       INTEGER NOT NULL DEFAULT 1,
  token_ver     INTEGER NOT NULL DEFAULT 1,     -- 改密码/停用后旧登录失效
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,                  -- 单据类型,见 meta.mjs
  no            TEXT NOT NULL UNIQUE,           -- 单据编号
  title         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'draft',  -- draft 草稿 | pending 审批中 | approved 已生效 | rejected 已驳回 | cancelled 已作废
  step          INTEGER NOT NULL DEFAULT 0,     -- 审批进行到第几步
  steps         TEXT NOT NULL DEFAULT '[]',     -- 本次提交的审批步骤(角色数组)
  version       INTEGER NOT NULL DEFAULT 1,
  partner_id    INTEGER,
  project_id    INTEGER,
  contract_id   INTEGER,
  owner_id      INTEGER,
  dept          TEXT NOT NULL DEFAULT '',
  data          TEXT NOT NULL DEFAULT '{}',
  created_by    INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rec_type ON records(type, id);
CREATE INDEX IF NOT EXISTS idx_rec_partner ON records(partner_id);
CREATE INDEX IF NOT EXISTS idx_rec_contract ON records(contract_id);
CREATE INDEX IF NOT EXISTS idx_rec_project ON records(project_id);

CREATE TABLE IF NOT EXISTS record_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id     INTEGER NOT NULL,
  user_id       INTEGER,
  user_name     TEXT NOT NULL DEFAULT '',
  action        TEXT NOT NULL,
  comment       TEXT NOT NULL DEFAULT '',
  diff          TEXT,                           -- 字段级变更 JSON [{field,label,from,to}]
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_record ON record_logs(record_id, id);

CREATE TABLE IF NOT EXISTS record_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id     INTEGER NOT NULL,
  version       INTEGER NOT NULL,
  data          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE(record_id, version)
);

CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id     INTEGER NOT NULL,
  category      TEXT NOT NULL,
  filename      TEXT NOT NULL,
  stored        TEXT NOT NULL,
  size          INTEGER NOT NULL,
  uploaded_by   INTEGER,
  uploader_name TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_record ON attachments(record_id);

-- 授信额度占用 / 释放台账
CREATE TABLE IF NOT EXISTS credit_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_id     INTEGER NOT NULL,               -- 授信档案(records.type = credit_line)
  record_id     INTEGER,                        -- 引起占用/释放的单据
  contract_id   INTEGER,                        -- 占用归属的合同(释放时按合同冲减)
  kind          TEXT NOT NULL,                  -- occupy 占用 | release 释放
  amount        REAL NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger ON credit_ledger(credit_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_rec ON credit_ledger(record_id);

-- 库存流水(收货通知入库、发货通知出库、库存调整)
CREATE TABLE IF NOT EXISTS stock_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id     INTEGER NOT NULL,
  contract_id   INTEGER,
  product       TEXT NOT NULL,
  warehouse_id  INTEGER,
  qty           REAL NOT NULL,                  -- 入库为正、出库为负
  amount        REAL NOT NULL DEFAULT 0,        -- 入库成本金额(人民币)
  biz_date      TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_product ON stock_ledger(product, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_record ON stock_ledger(record_id);

CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id    INTEGER,                        -- 发给门户客商
  role          TEXT,                           -- 或发给内部某角色
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  record_id     INTEGER,
  read_at       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notice_partner ON notifications(partner_id, id);

CREATE TABLE IF NOT EXISTS seq (
  prefix        TEXT NOT NULL,
  day           TEXT NOT NULL,
  n             INTEGER NOT NULL,
  PRIMARY KEY (prefix, day)
);

CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);
`;

export const DEFAULT_SETTINGS = {
  companyName: "某某进出口贸易有限公司",
  orgs: ["境内公司", "香港公司"],                      // 多组织(跨境联动)
  depts: ["大宗事业部", "进口事业部", "出口事业部"],
  dedupRules: ["creditCode", "name"],                 // 客户查重标准
  requiredAttachments: {},                            // 覆盖 meta 里的必传附件 { type: [类别] }
  defaultDailyRate: 0.0003,                           // 默认资金占用日利率(万分之三)
  marginCallThreshold: 0,                             // 追保阈值(缺口超过多少元才发起追保)
};

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

export function ensureAdmin(db, password) {
  if (db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0 || !password) return;
  const now = nowBJ();
  db.prepare("INSERT INTO users (username, name, password, roles, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("admin", "系统管理员", hashPassword(password), JSON.stringify(["admin"]), now, now);
}

export function getSettings(db) {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const { key, value } of db.prepare("SELECT key, value FROM settings").all()) {
    if (key in out) out[key] = JSON.parse(value);
  }
  return out;
}

export function saveSettings(db, patch) {
  const up = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) up.run(k, JSON.stringify(v));
}

export function nextNo(db, prefix) {
  const day = nowBJ().slice(0, 10).replace(/-/g, "");
  const row = db.prepare("INSERT INTO seq (prefix, day, n) VALUES (?, ?, 1) ON CONFLICT(prefix, day) DO UPDATE SET n = n + 1 RETURNING n").get(prefix, day);
  return `${prefix}${day}${String(row.n).padStart(3, "0")}`;
}
