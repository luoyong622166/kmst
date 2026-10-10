// 销售管理数据库每日备份(cron 调用),保留最近 30 份
//   node /opt/sales-crm/backup.mjs
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DB_FILE = process.env.CRM_DB_FILE || "/var/lib/sales-crm/crm.db";
const DIR = process.env.CRM_BACKUP_DIR || "/var/backups/sales-crm";
const KEEP = 30;

fs.mkdirSync(DIR, { recursive: true });
const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, "");
const target = path.join(DIR, `crm-${stamp}.db`);
const db = new DatabaseSync(DB_FILE);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();

const files = fs.readdirSync(DIR).filter(f => /^crm-\d+\.db$/.test(f)).sort();
for (const f of files.slice(0, Math.max(0, files.length - KEEP))) fs.unlinkSync(path.join(DIR, f));

// 实施文档:增量复制(文件名唯一且上传后不再修改,已备份的跳过)
const FILES_DIR = process.env.CRM_FILES_DIR || "/var/lib/sales-crm/files";
if (fs.existsSync(FILES_DIR)) fs.cpSync(FILES_DIR, path.join(DIR, "files"), { recursive: true, force: false });
console.log(`[sales-crm backup] ${target}`);
