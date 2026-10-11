// 驾校报名独立数据库(SQLite,node:sqlite 内置,零依赖)。金额一律以「分」存整数。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { nowBJ } from "./util.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS courses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,                  -- 课程名称:A照 / B照 / C照
  license_class  TEXT NOT NULL,                  -- 准驾车型说明,如 C1/C2
  description    TEXT NOT NULL DEFAULT '',
  price_fen      INTEGER NOT NULL,               -- 报名价格(分),后台维护
  min_age        INTEGER NOT NULL DEFAULT 18,    -- 报名最低周岁
  enabled        INTEGER NOT NULL DEFAULT 1,     -- 0 = 下架,手机端不显示
  sort           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS registrations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token          TEXT NOT NULL UNIQUE,           -- 学员访问自己报名单/合同的随机凭证
  name           TEXT NOT NULL,
  gender         TEXT NOT NULL,                  -- 由身份证号推出
  id_card        TEXT NOT NULL,
  birth_date     TEXT NOT NULL,
  phone          TEXT NOT NULL,
  address        TEXT NOT NULL,
  course_id      INTEGER NOT NULL REFERENCES courses(id),
  course_name    TEXT NOT NULL,                  -- 报名时的课程与价格快照,后台改价不影响已报名学员
  license_class  TEXT NOT NULL,
  price_fen      INTEGER NOT NULL,
  signature      TEXT NOT NULL,                  -- 学员手写签名 PNG(data URL)
  status         TEXT NOT NULL DEFAULT 'pending', -- pending 待付款 | paid 已付款 | cancelled 已取消
  cancel_reason  TEXT,
  pay_method     TEXT,                           -- mock 在线支付(演示) | offline 线下收款
  pay_no         TEXT,
  paid_at        TEXT,
  contract_no    TEXT UNIQUE,
  contract_html  TEXT,                           -- 付款时生成的合同快照,之后改模板不影响已签合同
  client_ip      TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reg_created ON registrations(created_at);
CREATE INDEX IF NOT EXISTS idx_reg_phone ON registrations(phone);
CREATE INDEX IF NOT EXISTS idx_reg_idcard ON registrations(id_card);

CREATE TABLE IF NOT EXISTS settings (
  key            TEXT PRIMARY KEY,
  value          TEXT NOT NULL
);
`;

export const PAY_MODES = { mock: "在线支付(演示,不真实扣款)", offline: "线下缴费,后台确认收款" };

export const DEFAULT_TERMS = `第一条 培训项目
乙方自愿报名参加甲方组织的{{课程名称}}(准驾车型:{{准驾车型}})机动车驾驶培训。培训内容包括道路交通安全法律法规和相关知识、科目二场地驾驶技能、科目三道路驾驶技能及安全文明驾驶常识。
第二条 培训费用
培训费用为人民币{{金额}}元(大写:{{金额大写}}),乙方于{{付款时间}}一次性付清。考试费、补考费等由考试机构收取的费用,按有关规定另行缴纳。
第三条 甲方权利和义务
1. 甲方按照国家机动车驾驶培训教学大纲组织教学,配备具有相应资格的教练员和合格的教练车辆。
2. 甲方为乙方建立培训档案,如实记录培训学时,按规定为乙方预约考试。
3. 甲方不得在本合同约定之外向乙方收取其他培训费用。
第四条 乙方权利和义务
1. 乙方应提供真实有效的身份信息,并按规定提交体检合格证明。
2. 乙方应遵守甲方的培训纪律和安全管理规定,按预约时间参加培训。
3. 乙方有权对甲方的教学质量和服务进行监督和投诉。
第五条 退学与退费
1. 乙方在开始培训前申请退学的,甲方扣除报名建档等已实际发生的费用后,退还剩余费用。
2. 培训开始后乙方申请退学的,甲方按未完成培训学时的比例退还相应费用。
3. 因甲方原因无法继续培训的,甲方应全额退还未培训部分的费用。
第六条 争议解决
双方因本合同发生争议的,应协商解决;协商不成的,可向甲方所在地人民法院提起诉讼。
第七条 其他
本合同以电子形式订立,乙方在线手写签名并完成付款即视为已阅读并同意本合同全部条款。本合同自乙方付款完成之日起生效,至乙方取得驾驶证或双方解除合同之日终止。`;

export const DEFAULT_SETTINGS = {
  schoolName: "某某机动车驾驶培训学校",
  schoolAddress: "",
  schoolPhone: "",
  notice: "报名前请准备好本人身份证。报名提交后请尽快完成缴费,缴费成功后系统自动生成电子培训合同。",
  payMode: "mock",
  contractTerms: DEFAULT_TERMS,
};

const SEED_COURSES = [
  ["C照", "C1/C2 小型汽车", "适合驾驶家用小汽车,最常见的驾照类型。", 480000, 18, 30],
  ["B照", "B1/B2 中型客车、大型货车", "适合驾驶中型客车、大型货车。", 980000, 20, 20],
  ["A照", "A1/A2/A3 大型客车、牵引车、城市公交车", "适合驾驶大型客车、牵引车、城市公交车。", 1680000, 22, 10],
];

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  if (db.prepare("SELECT COUNT(*) AS n FROM courses").get().n === 0) {
    const now = nowBJ();
    const ins = db.prepare(`INSERT INTO courses (name, license_class, description, price_fen, min_age, sort, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const c of SEED_COURSES) ins.run(...c, now, now);
  }
  return db;
}

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const { key, value } of db.prepare("SELECT key, value FROM settings").all()) if (key in out) out[key] = value;
  return out;
}

export function saveSettings(db, patch) {
  const up = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) up.run(k, String(v));
}
