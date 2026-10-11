// 通用工具:错误、时间、数字、密码、限流、表达式求值、ZIP 打包
import crypto from "node:crypto";
import zlib from "node:zlib";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const bad = msg => new HttpError(400, msg);

// 北京时间
export const nowBJ = (d = new Date()) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
export const todayBJ = () => nowBJ().slice(0, 10);

export const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const round = (v, d = 2) => Math.round(num(v) * 10 ** d + Number.EPSILON) / 10 ** d;
export const sum = (arr, fn = x => x) => round(arr.reduce((s, x) => s + num(fn(x)), 0), 6);

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400e3);
}
export function addDays(d, n) {
  return new Date(Date.parse(d + "T00:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
}

// 企业名称查重键:去空白、括号统一、去常见后缀差异
export function nameKey(name) {
  return String(name ?? "")
    .replace(/\s+/g, "")
    .replace(/[（(]/g, "(")
    .replace(/[）)]/g, ")")
    .toUpperCase();
}

// ---------- 密码 ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(String(pw), salt, 32).toString("hex")}`;
}
export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(String(pw), salt, 32), b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

// ---------- 计价公式:只支持 + - * / 括号、数字、变量、min/max/round/abs ----------
export function evalFormula(expr, vars) {
  const src = String(expr ?? "");
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const fail = msg => {
    throw bad(`计价公式错误:${msg}(位置 ${i + 1})`);
  };
  const FN = { min: Math.min, max: Math.max, abs: Math.abs, round: (x, d = 0) => round(x, d) };
  function primary() {
    ws();
    const c = src[i];
    if (c === "(") {
      i++;
      const v = expr0();
      ws();
      if (src[i] !== ")") fail("缺少右括号");
      i++;
      return v;
    }
    if (c === "-") {
      i++;
      return -primary();
    }
    if (c === "+") {
      i++;
      return primary();
    }
    const n = src.slice(i).match(/^\d+(\.\d+)?/);
    if (n) {
      i += n[0].length;
      return Number(n[0]);
    }
    const id = src.slice(i).match(/^[A-Za-z_一-龥][\w一-龥]*/);
    if (id) {
      i += id[0].length;
      ws();
      if (src[i] === "(") {
        const fn = FN[id[0].toLowerCase()];
        if (!fn) fail(`不支持的函数 ${id[0]}`);
        i++;
        const args = [];
        ws();
        if (src[i] !== ")") {
          for (;;) {
            args.push(expr0());
            ws();
            if (src[i] === ",") {
              i++;
              continue;
            }
            break;
          }
        }
        if (src[i] !== ")") fail("函数缺少右括号");
        i++;
        return fn(...args);
      }
      if (!(id[0] in vars)) fail(`未知变量「${id[0]}」`);
      return num(vars[id[0]]);
    }
    fail("无法识别的内容");
  }
  function term() {
    let v = primary();
    for (;;) {
      ws();
      const c = src[i];
      if (c === "*" || c === "/") {
        i++;
        const r = primary();
        if (c === "/" && r === 0) fail("除数为 0");
        v = c === "*" ? v * r : v / r;
      } else return v;
    }
  }
  function expr0() {
    let v = term();
    for (;;) {
      ws();
      const c = src[i];
      if (c === "+" || c === "-") {
        i++;
        const r = term();
        v = c === "+" ? v + r : v - r;
      } else return v;
    }
  }
  const v = expr0();
  ws();
  if (i < src.length) fail("多余的内容");
  return v;
}
export function formulaVars(expr) {
  const s = String(expr ?? ""), out = new Set();
  for (const m of s.matchAll(/[A-Za-z_一-龥][\w一-龥]*/g)) {
    if (!/^\s*\(/.test(s.slice(m.index + m[0].length))) out.add(m[0]);
  }
  return [...out];
}

// ---------- ZIP(deflate,无依赖) ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), data = f.data, comp = zlib.deflateRawSync(data), crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(0, 10); h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    locals.push(h, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(0, 12); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    centrals.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
