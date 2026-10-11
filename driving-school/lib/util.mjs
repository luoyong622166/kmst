// 通用工具:错误类型、北京时间、身份证校验、金额格式、限流
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 北京时间 "YYYY-MM-DD HH:mm:ss"
export function nowBJ(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export const yuan = fen => (fen / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 人民币大写,入参单位:分
export function rmbUpper(fen) {
  const D = "零壹贰叁肆伍陆柒捌玖", U = ["", "拾", "佰", "仟"], G = ["", "万", "亿", "万亿"];
  let rest = Math.floor(fen / 100);
  const jiao = Math.floor(fen / 10) % 10, cent = fen % 10;
  let s = "";
  if (rest > 0) {
    const groups = [];
    while (rest > 0) {
      groups.push(rest % 10000);
      rest = Math.floor(rest / 10000);
    }
    let needZero = false;
    for (let gi = groups.length - 1; gi >= 0; gi--) {
      const g = groups[gi];
      if (g === 0) {
        needZero = s !== "";
        continue;
      }
      if (s && g < 1000) needZero = true;
      let gs = "", zero = false;
      for (let i = 3; i >= 0; i--) {
        const d = Math.floor(g / 10 ** i) % 10;
        if (d === 0) zero = gs !== "";
        else {
          gs += (zero ? "零" : "") + D[d] + U[i];
          zero = false;
        }
      }
      s += (needZero ? "零" : "") + gs + G[gi];
      needZero = false;
    }
    s += "元";
  }
  if (!jiao && !cent) return (s || "零元") + "整";
  if (jiao) s += D[jiao] + "角";
  else if (s) s += "零";
  if (cent) s += D[cent] + "分";
  return s;
}

// 18 位居民身份证:校验码 + 出生日期,返回 { id, birth, gender } 或 null
export function parseIdCard(raw) {
  const id = String(raw ?? "").trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) return null;
  const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(id[i]) * W[i];
  if ("10X98765432"[sum % 11] !== id[17]) return null;
  const y = +id.slice(6, 10), m = +id.slice(10, 12), d = +id.slice(12, 14);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { id, birth: id.slice(6, 10) + "-" + id.slice(10, 12) + "-" + id.slice(12, 14), gender: Number(id[16]) % 2 ? "男" : "女" };
}

// 周岁:birth / today 均为 "YYYY-MM-DD"
export function ageOn(birth, today) {
  const age = Number(today.slice(0, 4)) - Number(birth.slice(0, 4));
  return today.slice(5) < birth.slice(5) ? age - 1 : age;
}

export const maskIdCard = id => id.slice(0, 6) + "********" + id.slice(14);
export const maskPhone = p => p.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");

// 简单的内存限流:窗口内每个 key 最多 limit 次
export function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    let e = hits.get(key);
    if (!e || e.reset < now) hits.set(key, (e = { n: 0, reset: now + windowMs }));
    return ++e.n <= limit;
  };
}
