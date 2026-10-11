// 端到端接口测试(在临时实例上跑):
//   TE_PORT=3399 TE_DATA_DIR=/tmp/te-test TE_ADMIN_PASSWORD=adminpw123 node server.mjs &
//   node test/e2e.mjs http://127.0.0.1:3399/trade adminpw123
const BASE = process.argv[2], PW = process.argv[3];
let pass = 0, failN = 0;
const ok = (cond, msg) => { if (cond) pass++; else { failN++; console.log("FAIL:", msg); } };

function client() {
  let cookie = "";
  const call = async (method, path, body, raw) => {
    const headers = { cookie };
    let b;
    if (raw) b = raw;
    else if (body !== undefined) { headers["Content-Type"] = "application/json"; b = JSON.stringify(body); }
    const r = await fetch(BASE + "/api" + path, { method, headers, body: b });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const ct = r.headers.get("content-type") || "";
    const data = ct.includes("json") ? await r.json() : await r.arrayBuffer();
    return { status: r.status, data };
  };
  const must = async (method, path, body, raw) => {
    const r = await call(method, path, body, raw);
    if (r.status !== 200) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  return { call, must };
}

const A = client();
await A.must("POST", "/login", { username: "admin", password: PW });
const save = (type, data, id) => A.must(id ? "PUT" : "POST", `/records/${type}${id ? "/" + id : ""}`, { data });
const act = (type, id, action, payload = {}) => A.must("POST", `/records/${type}/${id}/actions/${action}`, payload);
const tryAct = (type, id, action, payload = {}) => A.call("POST", `/records/${type}/${id}/actions/${action}`, payload);
const upload = (type, id, cat, name = "a.pdf") => A.must("POST", `/records/${type}/${id}/attachments?category=${encodeURIComponent(cat)}&name=${name}`, undefined, Buffer.from("%PDF-1.4 test"));
const approveAll = async (type, id) => {
  let d = await act(type, id, "submit");
  while (d.record.status === "pending") d = await act(type, id, "approve", { comment: "同意" });
  return d;
};

// ---- 客商 ----
const mk = async (name, code, ptype, extra = {}) => {
  const d = await save("partner", { name, credit_code: code, ptype, contact: "张三", phone: "1380000" + code.slice(-4), ...extra });
  await upload("partner", d.record.id, "营业执照");
  const r = await approveAll("partner", d.record.id);
  ok(r.record.status === "approved", `partner ${name} approved`);
  return r.record.id;
};
const cust = await mk("甲客户有限公司", "91310000MA1FL00001", ["客户"]);
const supp = await mk("乙供应商有限公司", "91310000MA1FL00002", ["供应商-货物"]);
const wh = await mk("丙仓储有限公司", "91310000MA1FL00003", ["供应商-仓储"], { capacity: 1000 });
const carrier = await mk("丁物流有限公司", "91310000MA1FL00004", ["供应商-物流"]);
const hk = await mk("境内内部公司", "91310000MA1FL00005", ["内部组织"], { internal_org: "境内公司" });

let r = await A.call("POST", "/records/partner", { data: { name: "甲客户有限公司", ptype: ["客户"] } });
ok(r.status === 400 && /重复/.test(r.data.error), "dedup by name: " + JSON.stringify(r.data));

// 未上传营业执照不能提交
const noLic = await save("partner", { name: "戊公司", credit_code: "91310000MA1FL00006", ptype: ["客户"] });
r = await tryAct("partner", noLic.record.id, "submit");
ok(r.status === 400 && /营业执照/.test(r.data.error), "required attachment");

// 黑名单
await save("blacklist", { name: "戊公司", reason: "集团通报", source: "集团下发", active: true });
r = await A.must("GET", `/records/partner/${noLic.record.id}`);
ok(r.record.data.locked === true, "blacklist locks partner");

// ---- 评级 ----
const i1 = (await save("rating_index", { name: "经营年限", weight: 40 })).record.id;
const i2 = (await save("rating_index", { name: "财务状况", weight: 60 })).record.id;
const scheme = (await save("risk_scheme", { name: "客户方案", ptype: ["客户"], indexes: [{ index: i1, weight: 40 }, { index: i2, weight: 60 }],
  grades: [{ grade: "B", min_score: 60, credit_class: "一般" }, { grade: "A", min_score: 85, credit_class: "优质", credit_cap: 2000000, margin_ratio: 10 }] })).record.id;
let rt = await save("partner_rating", { partner: cust, scheme });
ok(rt.record.data.scores.length === 2, "rating prefill indexes");
rt = await save("partner_rating", { partner: cust, scheme, scores: [{ index: i1, weight: 40, score: 90 }, { index: i2, weight: 60, score: 85 }] }, rt.record.id);
ok(rt.record.data.score === 87 && rt.record.data.grade === "A", "rating score " + rt.record.data.score + rt.record.data.grade);
await approveAll("partner_rating", rt.record.id);
r = await A.must("GET", `/records/partner/${cust}`);
ok(r.record.data.rating === "A", "rating written to partner");

// ---- 授信 ----
const credit = async (partner, credit_type, amount) => {
  const d = await save("credit_apply", { partner, credit_type, amount, valid_from: "2026-01-01", valid_to: "2027-12-31", reason: "业务需要" });
  const x = await approveAll("credit_apply", d.record.id);
  ok(x.record.status === "approved", "credit approved " + credit_type);
};
await credit(cust, "赊销额度", 1000000);
await credit(supp, "预付额度", 500000);
const lines = await A.must("GET", "/records/credit_line");
ok(lines.total === 2, "credit lines created");

// ---- 条款、公式、项目 ----
const cl = (await save("clause", { title: "争议解决", category: "通用", mandatory: true, content: "提交上海仲裁委员会仲裁。" })).record.id;
const fm = (await save("formula", { name: "升贴水", method: "点价", expression: "基准价 + 升贴水" })).record;
ok(fm.data.test_result === 1001, "formula test " + fm.data.test_result);
r = await A.call("POST", "/records/formula", { data: { name: "坏公式", expression: "基准价 * (2" } });
ok(r.status === 400, "bad formula rejected");
const proj = await save("project", { name: "铜贸易项目", start_date: "2026-10-01", settlement: "月结", margin_ratio: 10, risk_control: "货权控制", daily_rate: 0.0003,
  parties: [{ partner: cust, role: "核心企业" }, { partner: supp, role: "供应商" }] });
await upload("project", proj.record.id, "立项报告");
await approveAll("project", proj.record.id);

// ---- 采购合同 ----
const base = { kind: "合同", trade_type: "国内贸易", org: "境内公司", sign_date: "2026-10-01", currency: "CNY", pricing_method: "一口价", tolerance: 5, project: proj.record.id };
let pc = await save("contract", { ...base, direction: "采购", partner: supp, payment_method: "预付款", prepay_ratio: 30,
  items: [{ product: "电解铜", unit: "吨", qty: 100, price: 60000 }], pay_plan: [{ date: "2026-10-05", kind: "预付款", amount: 1800000 }],
  clauses: [{ clause: cl, title: "", content: "提交北京仲裁委员会仲裁。" }] });
ok(pc.record.data.total_amount === 6000000 && pc.record.data.clause_changed === true, "contract amount & clause change");
await upload("contract", pc.record.id, "合同正本");
r = await tryAct("contract", pc.record.id, "submit");
ok(r.status === 400 && /预付额度不足/.test(r.data.error), "credit insufficient: " + JSON.stringify(r.data));
pc = await save("contract", { ...pc.record.data, items: [{ product: "电解铜", unit: "吨", qty: 20, price: 60000 }] }, pc.record.id);
let sub = await act("contract", pc.record.id, "submit");
ok(JSON.stringify(sub.record.steps) === '["legal","manager"]', "legal step added: " + JSON.stringify(sub.record.steps));
while (sub.record.status === "pending") sub = await act("contract", pc.record.id, "approve");
const pcId = pc.record.id;
r = await A.must("GET", "/reports/credit_summary");
ok(r.rows.find(x => x.ctype === "预付额度").used === 360000, "prepay occupied 360000");

// ---- 销售合同 ----
let sc = await save("contract", { ...base, direction: "销售", partner: cust, payment_method: "赊销", prepay_ratio: 0,
  items: [{ product: "电解铜", unit: "吨", qty: 20, price: 65000 }], pay_plan: [{ date: "2026-10-08", kind: "尾款", amount: 1300000 }],
  clauses: [{ clause: cl }] });
ok(sc.record.data.clause_changed === false, "unchanged clause");
await upload("contract", sc.record.id, "合同正本");
r = await tryAct("contract", sc.record.id, "submit");
ok(r.status === 400 && /赊销额度不足/.test(r.data.error), "sale credit insufficient");
sc = await save("contract", { ...sc.record.data, prepay_ratio: 30 }, sc.record.id);
sub = await act("contract", sc.record.id, "submit");
ok(JSON.stringify(sub.record.steps) === '["manager"]', "manager only");
sub = await act("contract", sc.record.id, "approve");
const scId = sc.record.id;
ok(sub.record.status === "approved", "sales contract approved");

// 黑名单客商不能签合同
r = await A.call("POST", "/records/contract", { data: { ...base, direction: "销售", partner: noLic.record.id, payment_method: "款到发货", items: [{ product: "电解铜", qty: 1, price: 1 }] } });
let blk = r.status === 200 ? await tryAct("contract", r.data.record.id, "submit") : r;
ok(blk.status === 400 && /黑名单|准入/.test(blk.data.error), "locked partner blocked: " + JSON.stringify(blk.data));

// ---- 点价合同 ----
let fc = await save("contract", { ...base, direction: "销售", partner: cust, payment_method: "款到发货", pricing_method: "点价", formula: fm.id,
  items: [{ product: "电解铜", unit: "吨", qty: 10, base_price: 60000, premium: 200 }], clauses: [{ clause: cl }] });
await upload("contract", fc.record.id, "合同正本");
await approveAll("contract", fc.record.id);
await save("pricing_fix", { contract: fc.record.id, date: "2026-10-09", price: 61000, lots: 1, lot_size: 4 });
await save("pricing_fix", { contract: fc.record.id, date: "2026-10-10", price: 62000, lots: 1, lot_size: 6 });
r = await A.must("GET", `/records/contract/${fc.record.id}`);
ok(r.record.data.fixed_qty === 10 && r.record.data.fixed_avg === 61600 && r.record.data.items[0].price === 61800, "pricing fix rewrite " + JSON.stringify([r.record.data.fixed_avg, r.record.data.items[0].price]));
r = await A.call("POST", "/records/pricing_fix", { data: { contract: fc.record.id, date: "2026-10-10", price: 62000, lots: 1, lot_size: 1 } });
ok(r.status === 400 && /超过合同数量上限/.test(r.data.error), "pricing fix over limit");

// ---- 采销匹配 ----
await save("match", { purchase: pcId, sale: scId, product: "电解铜", qty: 20, active: true });
r = await A.call("POST", "/records/match", { data: { purchase: pcId, sale: scId, product: "电解铜", qty: 5, active: true } });
ok(r.status === 400, "match over qty");

// ---- 入库 / 出库 ----
const rn = await save("receipt_notice", { contract: pcId, warehouse: wh, product: "电解铜", plan_qty: 20 });
r = await tryAct("receipt_notice", rn.record.id, "confirm_in", { actual_qty: 22, in_date: "2026-10-06" });
ok(r.status === 400 && /溢短装/.test(r.data.error), "overfill blocked");
await act("receipt_notice", rn.record.id, "confirm_in", { actual_qty: 20.5, in_date: "2026-10-06" });
r = await A.must("GET", "/reports/credit_summary");
ok(r.rows.find(x => x.ctype === "预付额度").used === 0, "prepay released on receipt " + r.rows.find(x => x.ctype === "预付额度").used);
const dn = await save("delivery_notice", { contract: scId, warehouse: wh, product: "电解铜", plan_qty: 10 });
await act("delivery_notice", dn.record.id, "confirm_out", { actual_qty: 10, out_date: "2026-10-07" });
r = await A.must("GET", "/reports/stock");
ok(r.rows[0].qty === 10.5, "stock 10.5: " + JSON.stringify(r.rows[0]));

// 款到发货合同资金池校验
const dn2 = await A.call("POST", "/records/delivery_notice", { data: { contract: fc.record.id, warehouse: wh, product: "电解铜", plan_qty: 5 } });
ok(dn2.status === 400 && /资金池/.test(dn2.data.error), "customer pool check: " + JSON.stringify(dn2.data));

// ---- 收款认领 释放赊销额度 ----
let pay = await save("payment", { kind: "收款", partner: cust, pay_date: "2026-10-08", currency: "CNY", amount: 500000, bank_ref: "HS001" });
pay = await act("payment", pay.record.id, "submit");
ok(pay.record.status === "approved", "receipt approved without steps");
await act("payment", pay.record.id, "claim", { contract: scId, claim_type: "应收/应付", amount: 500000 });
r = await A.must("GET", "/reports/credit_summary");
ok(r.rows.find(x => x.ctype === "赊销额度").used === 410000, "sale credit released: " + r.rows.find(x => x.ctype === "赊销额度").used);

// 付款(审批 2 步)
let pp = await save("payment", { kind: "付款", partner: supp, pay_date: "2026-10-03", currency: "CNY", amount: 360000, claims: [{ contract: pcId, claim_type: "预收/预付", amount: 360000 }] });
await upload("payment", pp.record.id, "付款申请");
pp = await approveAll("payment", pp.record.id);
ok(pp.record.status === "approved", "payment approved");
r = await A.must("GET", "/reports/interest");
ok(r.rows.length >= 1 && r.rows[0].interest > 0, "interest calculated " + JSON.stringify(r.rows[0]));

// ---- 保证金追保 ----
const mg = await save("margin", { direction: "向客户收取", contract: scId, ratio: 10, events: [{ date: "2026-10-02", kind: "收取", amount: 130000 }] });
ok(mg.record.data.required === 130000 && mg.record.data.gap === 0, "margin required");
await save("market_price", { product: "电解铜", date: "2026-10-10", kind: "现货", price: 60000 });
r = await A.must("GET", `/records/margin/${mg.record.id}`);
ok(r.record.data.call_total === 100000, "auto margin call 100000: " + r.record.data.call_total);

// ---- 报关 / 缴税 / 保函 ----
const cs = await save("customs", { contract: pcId, direction: "进口", decl_date: "2026-10-05", currency: "USD", exchange_rate: 7, items: [{ hs_code: "7403111100", product: "电解铜", qty: 20, value: 100000, duty_rate: 1, vat_rate: 13 }] });
ok(cs.record.data.total_value === 700000 && cs.record.data.total_duty === 7000 && cs.record.data.total_vat === 91910, "customs tax " + JSON.stringify([cs.record.data.total_duty, cs.record.data.total_vat]));
const g = await save("guarantee", { guarantee_no: "BH001", bank: "中国银行", amount: 50000 });
let tp = await save("tax_payment", { customs: cs.record.id, duty: null, vat: null, guarantee: g.record.id, guarantee_amount: 50000, pay_date: "2026-10-06" });
ok(tp.record.data.cash_amount === 48910, "tax cash " + tp.record.data.cash_amount);
await approveAll("tax_payment", tp.record.id);
r = await A.must("GET", `/records/guarantee/${g.record.id}`);
ok(r.record.data.balance === 0, "guarantee used");

// ---- 出口退税 ----
const ecs = await save("customs", { contract: scId, direction: "出口", decl_date: "2026-10-07", currency: "USD", exchange_rate: 7, items: [{ hs_code: "7403111100", product: "电解铜", qty: 10, value: 90000, refund_rate: 13 }] });
await save("invoice", { direction: "进项", contract: pcId, partner: supp, invoice_no: "00112233", invoice_date: "2026-10-06", items: [{ product: "电解铜", qty: 20, amount: 1000000, tax_rate: 13 }] });
const tr = await save("tax_refund", { customs: ecs.record.id });
const am = await act("tax_refund", tr.record.id, "automatch");
ok(am.record.data.refund_due === 65000 && am.record.data.matches[0].qty === 10, "refund auto match " + am.record.data.refund_due);
await upload("tax_refund", tr.record.id, "退税申报表");
await approveAll("tax_refund", tr.record.id);
const rf = await act("tax_refund", tr.record.id, "refunded", { refund_actual: 64000, refund_date: "2026-11-01" });
ok(rf.record.data.refund_diff === -1000, "refund diff");
const zi = await act("customs", ecs.record.id, "zero_invoice");
ok(/已生成发票/.test(zi.message), "zero-rate invoice");

// ---- 费用、品质、结算 ----
const ex = await save("expense", { fee_type: "仓储费", amount: 3000, fee_date: "2026-10-07", allocs: [{ contract: scId, amount: 3000 }] });
await approveAll("expense", ex.record.id);
await save("quality", { contract: scId, stage: "出库", inspect_date: "2026-10-07", items: [{ indicator: "铜含量", standard: ">=99.95", actual: "99.93", penalty: 2000 }] });
const st = await save("settlement", { contract: scId, kind: "最终结算", settle_date: "2026-10-10", charge_fees: true });
const fl = await act("settlement", st.record.id, "fill");
ok(fl.record.data.qty === 10 && fl.record.data.quality_penalty === 2000 && fl.record.data.fees === 3000 && fl.record.data.paid === 500000, "settlement fill " + JSON.stringify(fl.record.data));
await approveAll("settlement", st.record.id);
r = await A.must("GET", `/records/contract/${scId}`);
ok(r.record.data.closed === true, "contract closed by final settlement");
r = await A.must("GET", "/reports/credit_summary");
ok(r.rows.find(x => x.ctype === "赊销额度").used === 0, "credit fully released after close");

// ---- 合同变更校验 ----
await act("contract", pcId, "change", { comment: "减少数量" });
const pcd = (await A.must("GET", `/records/contract/${pcId}`)).record.data;
await save("contract", { ...pcd, items: [{ product: "电解铜", unit: "吨", qty: 10, price: 60000 }] }, pcId);
r = await tryAct("contract", pcId, "submit");
ok(r.status === 400 && /不允许本次变更/.test(r.data.error), "change downstream check: " + JSON.stringify(r.data));
await save("contract", { ...pcd, items: [{ product: "电解铜", unit: "吨", qty: 21, price: 60000 }] }, pcId);
let ch = await act("contract", pcId, "submit");
while (ch.record.status === "pending") ch = await act("contract", pcId, "approve");
ok(ch.record.version === 2 && ch.record.status === "approved", "contract V2 approved");
r = await A.must("GET", `/records/contract/${pcId}/versions`);
ok(r.versions.length === 2, "versions kept");

// ---- 跨境联动 ----
const cb = await act("contract", pcId, "cross_border", { org: "香港公司" });
ok(/联动合同/.test(cb.message), "cross border " + cb.message);

// ---- 报表 / 卷宗 / 归档 ----
for (const name of ["credit_ledger", "credit_summary", "contract_ledger", "project_pool", "customer_pool", "interest", "interest_by_owner", "budget_exec", "stock", "weight_diff", "ar_ap", "margin_status"]) {
  const x = await A.call("GET", `/reports/${name}`);
  ok(x.status === 200 && Array.isArray(x.data.rows), "report " + name + " " + (x.data.error || ""));
}
const ds = await A.must("GET", `/dossier/${scId}`);
ok(Object.keys(ds.groups).length >= 5, "dossier groups " + Object.keys(ds.groups).join(","));
const zip = await A.call("GET", `/archive/${pcId}`);
ok(zip.status === 200 && Buffer.from(zip.data).slice(0, 2).toString() === "PK", "archive zip");

// 预算
const bg = await save("budget", { dept: "大宗事业部", month: "2026-10" });
const bf = await act("budget", bg.record.id, "autofill");
ok(/已带出/.test(bf.message), "budget autofill");

// ---- 门户 ----
const pa = await act("partner", cust, "portal_account");
const m = pa.message.match(/用户名 (\S+),初始密码 (\S+)/);
ok(!!m, "portal account " + pa.message);
const P = client();
await P.must("POST", "/login", { username: m[1], password: m[2] });
const meta = await P.must("GET", "/meta");
ok(meta.portalTypes.includes("contract") && !meta.portalTypes.includes("credit_line"), "portal types");
const pcs = await P.must("GET", "/records/contract");
ok(pcs.items.every(c => c.data.partner === cust) && pcs.items.length >= 2, "portal sees own contracts " + pcs.items.length);
let x = await P.call("GET", `/records/contract/${pcId}`);
ok(x.status === 404, "portal cannot see others' contract");
x = await P.call("GET", "/records/credit_line");
ok(x.status === 200 && x.data.items.length === 0, "portal no credit lines");
const fcid = fc.record.id;
x = await P.must("POST", `/records/contract/${fcid}/actions/confirm`, {});
ok(/已确认/.test(x.record.data.partner_confirm), "portal confirm contract");
x = await P.must("POST", "/records/payment", { data: { kind: "收款", pay_date: "2026-10-10", currency: "CNY", amount: 1000, claims: [{ contract: fcid, claim_type: "预收/预付", amount: 1000 }] } });
ok(x.record.data.source === "客户付款回单" && x.record.data.partner === cust, "portal receipt upload");
await P.must("POST", `/records/payment/${x.record.id}/attachments?category=${encodeURIComponent("银行回单")}&name=hd.png`, undefined, Buffer.from("png"));
x = await P.must("POST", `/records/payment/${x.record.id}/actions/submit`, {});
ok(JSON.stringify(x.record.steps) === '["finance"]', "receipt needs finance");
let y = await P.call("POST", "/records/payment", { data: { kind: "收款", pay_date: "2026-10-10", currency: "CNY", amount: 1, claims: [{ contract: pcId, claim_type: "预收/预付", amount: 1 }] } });
ok(y.status === 400, "portal cannot claim others' contract");
y = await P.call("POST", "/records/credit_apply", { data: {} });
ok(y.status === 403, "portal cannot create credit apply");

// 门户注册
const N = client();
x = await N.must("POST", "/portal/register", { company: "新供应商有限公司", credit_code: "91310000MA1FL00009", ptype: ["供应商-货物"], contact: "李四", phone: "13900000000", username: "newsupp", password: "abcdefgh1" });
ok(x.user.partner_status === "draft", "register draft");
const nm = await N.must("GET", "/meta");
ok(JSON.stringify(nm.portalTypes) === '["partner"]', "unapproved portal only partner " + JSON.stringify(nm.portalTypes));
x = await N.call("POST", "/portal/register", { company: "甲客户有限公司", ptype: ["客户"], contact: "a", phone: "1", username: "dupuser", password: "abcdefgh1" });
ok(x.status === 400 && /重复/.test(x.data.error), "register dedup");

// 未登录
const Z = client();
x = await Z.call("GET", "/records/contract");
ok(x.status === 401, "unauth 401");

console.log(`PASS ${pass}  FAIL ${failN}`);
