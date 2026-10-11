// 进出口贸易系统每日备份(cron 调用):数据库保留最近 30 份,附件增量复制
//   node /opt/trade-erp/backup.mjs
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.TE_DATA_DIR || "/var/lib/trade-erp";
const DIR = process.env.TE_BACKUP_DIR || "/var/backups/trade-erp";
const KEEP = 30;

fs.mkdirSync(DIR, { recursive: true });
const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, "");
const target = path.join(DIR, `trade-${stamp}.db`);
const db = new DatabaseSync(path.join(DATA_DIR, "trade.db"));
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();

const files = fs.readdirSync(DIR).filter(f => /^trade-\d+\.db$/.test(f)).sort();
for (const f of files.slice(0, Math.max(0, files.length - KEEP))) fs.unlinkSync(path.join(DIR, f));
const FILES_DIR = path.join(DATA_DIR, "files");
if (fs.existsSync(FILES_DIR)) fs.cpSync(FILES_DIR, path.join(DIR, "files"), { recursive: true, force: false });
console.log(`[trade-erp backup] ${target}`);
