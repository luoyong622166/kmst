// 通用工具:统一社会信用代码校验、企业名归一化、金额大写、日期、HTML 转义

// GB 32100-2015 统一社会信用代码:18 位,第 18 位为校验码
const CC_CHARS = "0123456789ABCDEFGHJKLMNPQRTUWXY";
const CC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
const CC_PATTERN = /^[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}$/;

export function normalizeCreditCode(s) {
  return String(s ?? "").replace(/\s+/g, "").toUpperCase();
}

export function isValidCreditCode(code) {
  if (!CC_PATTERN.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += CC_CHARS.indexOf(code[i]) * CC_WEIGHTS[i];
  return CC_CHARS[(31 - (sum % 31)) % 31] === code[17];
}

// 企业名查重键:去空白、全角括号转半角,避免「某某(杭州)」与「某某（杭州）」被当成两家
export function companyNameKey(s) {
  return String(s ?? "")
    .replace(/\s+/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")");
}

const CN_DIGITS = "零壹贰叁肆伍陆柒捌玖";
const CN_UNITS = ["", "拾", "佰", "仟"];
const CN_GROUPS = ["", "万", "亿", "万亿"];

export function amountToChinese(value) {
  const cents = Math.round(Number(value) * 100);
  if (!Number.isFinite(cents) || cents < 0) return "";
  if (cents === 0) return "零元整";
  const yuan = Math.floor(cents / 100);
  const jiao = Math.floor(cents / 10) % 10;
  const fen = cents % 10;
  let out = "";
  if (yuan > 0) {
    const str = String(yuan);
    const len = str.length;
    let pendingZero = false;
    for (let i = 0; i < len; i++) {
      const d = Number(str[i]);
      const pos = len - 1 - i;
      const unit = pos % 4;
      const group = Math.floor(pos / 4);
      if (d === 0) {
        pendingZero = true;
      } else {
        if (pendingZero) out += "零";
        pendingZero = false;
        out += CN_DIGITS[d] + CN_UNITS[unit];
      }
      if (unit === 0 && group > 0) {
        const groupDigits = str.slice(Math.max(0, len - group * 4 - 4), len - group * 4);
        if (Number(groupDigits) > 0) out += CN_GROUPS[group];
      }
    }
    out += "元";
  }
  if (jiao === 0 && fen === 0) return out + "整";
  if (jiao > 0) out += CN_DIGITS[jiao] + "角";
  else if (yuan > 0) out += "零";
  if (fen > 0) out += CN_DIGITS[fen] + "分";
  return out;
}

// 业务日期一律按东八区计
export function todayCN() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function nowISO() {
  return new Date().toISOString();
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
