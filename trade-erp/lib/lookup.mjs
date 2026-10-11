// 企业工商信息查询:天眼查 / 企查查开放平台,配了哪家的密钥就用哪家(都配了优先天眼查)。
//   天眼查:TIANYANCHA_TOKEN
//   企查查:QICHACHA_KEY + QICHACHA_SECRET
// 返回统一结构 { name, creditCode, legalPerson, regStatus, regCapital, establishDate, address, businessScope, industry }
import crypto from "node:crypto";

export class LookupError extends Error {}

export function lookupProvider() {
  if (process.env.TIANYANCHA_TOKEN) return "tianyancha";
  if (process.env.QICHACHA_KEY && process.env.QICHACHA_SECRET) return "qichacha";
  return null;
}

async function getJson(url, headers) {
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new LookupError("工商信息接口连接超时,请稍后再试,或先手动填写信用代码");
  }
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new LookupError(`工商信息接口返回异常(HTTP ${res.status}),请稍后再试,或先手动填写信用代码`);
  }
}

function toDate(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number") return new Date(v + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// ---------- 天眼查 ----------
const TYC_BASE = "https://open.api.tianyancha.com/services/open";

function tycHeaders() {
  return { Authorization: process.env.TIANYANCHA_TOKEN };
}

function tycCheck(j) {
  if (j.error_code === 0) return true;
  if (j.error_code === 300000) return false; // 查询无结果
  throw new LookupError(`天眼查查询失败:${j.reason || "错误码 " + j.error_code}`);
}

function tycNormalize(r) {
  return {
    name: r.name,
    creditCode: r.creditCode || "",
    legalPerson: r.legalPersonName || "",
    regStatus: r.regStatus || "",
    regCapital: r.regCapital || "",
    establishDate: toDate(r.estiblishTime),
    address: r.regLocation || "",
    businessScope: r.businessScope || "",
    industry: r.industry || "",
  };
}

async function tycSearch(keyword) {
  const j = await getJson(`${TYC_BASE}/search/2.0?word=${encodeURIComponent(keyword)}&pageSize=10`, tycHeaders());
  if (!tycCheck(j)) return [];
  return (j.result?.items ?? []).map(it => tycNormalize({ ...it, name: String(it.name ?? "").replace(/<\/?em>/g, "") }));
}

async function tycDetail(keyword) {
  const j = await getJson(`${TYC_BASE}/ic/baseinfo/normal?keyword=${encodeURIComponent(keyword)}`, tycHeaders());
  if (!tycCheck(j)) return null;
  return tycNormalize(j.result);
}

// ---------- 企查查 ----------
const QCC_BASE = "https://api.qichacha.com";

function qccHeaders() {
  const timespan = String(Math.floor(Date.now() / 1000));
  const token = crypto
    .createHash("md5")
    .update(process.env.QICHACHA_KEY + timespan + process.env.QICHACHA_SECRET)
    .digest("hex")
    .toUpperCase();
  return { Token: token, Timespan: timespan };
}

function qccCheck(j) {
  if (j.Status === "200") return true;
  if (j.Status === "201") return false; // 查询无结果
  throw new LookupError(`企查查查询失败:${j.Message || "状态码 " + j.Status}`);
}

function qccNormalize(r) {
  return {
    name: r.Name,
    creditCode: r.CreditCode || "",
    legalPerson: r.OperName || "",
    regStatus: r.Status || "",
    regCapital: r.RegistCapi || "",
    establishDate: toDate(r.StartDate),
    address: r.Address || "",
    businessScope: r.Scope || "",
    industry: r.Industry?.Industry || "",
  };
}

async function qccSearch(keyword) {
  const key = encodeURIComponent(process.env.QICHACHA_KEY);
  const j = await getJson(`${QCC_BASE}/FuzzySearch/GetList?key=${key}&searchKey=${encodeURIComponent(keyword)}`, qccHeaders());
  if (!qccCheck(j)) return [];
  return (j.Result ?? []).map(qccNormalize);
}

async function qccDetail(keyword) {
  const key = encodeURIComponent(process.env.QICHACHA_KEY);
  const j = await getJson(`${QCC_BASE}/ECIV4/GetBasicDetailsByName?key=${key}&keyword=${encodeURIComponent(keyword)}`, qccHeaders());
  if (!qccCheck(j)) return null;
  return qccNormalize(j.Result);
}

// ---------- 对外 ----------
const NOT_CONFIGURED = "尚未配置工商信息接口(天眼查或企查查),请先手动填写统一社会信用代码";

export async function searchCompanies(keyword) {
  const p = lookupProvider();
  if (!p) throw new LookupError(NOT_CONFIGURED);
  return p === "tianyancha" ? tycSearch(keyword) : qccSearch(keyword);
}

export async function companyDetail(keyword) {
  const p = lookupProvider();
  if (!p) throw new LookupError(NOT_CONFIGURED);
  return p === "tianyancha" ? tycDetail(keyword) : qccDetail(keyword);
}
