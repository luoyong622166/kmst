// 业务计算:合同执行量、额度占用/释放、库存、资金占用计息。hooks 与报表共用。
import { bad, nowBJ, todayBJ, round, num, sum, daysBetween, addDays } from "./util.mjs";
import { getSettings } from "./db.mjs";

export function createCalc(E) {
  const db = E.db;
  const live = "status != 'cancelled'";

  // ---------- 合同 ----------
  function contractLimits(c) {
    const qty = num(c.data.total_qty), tol = num(c.data.tolerance) / 100;
    return { qty, max: round(qty * (1 + tol), 6), min: round(qty * (1 - tol), 6) };
  }
  // 合同加权单价(原币)、汇率
  function contractPrice(c, product) {
    const items = (c.data.items || []).filter(i => !product || i.product === product);
    const q = sum(items, i => i.qty);
    return q ? sum(items, i => i.amount) / q : 0;
  }
  const rateOf = c => num(c.data.exchange_rate) || 1;

  // 关联到合同的单据(按 data.contract)
  const docs = (type, contractId, extra = "") => E.list(type, `contract_id = ? AND ${live} ${extra}`, contractId);
  const docsByField = (type, field, id) => E.list(type, `json_extract(data, '$.${field}') = ? AND ${live}`, id);

  function stockQty({ contractId, product, warehouseId, sign } = {}) {
    const w = [], a = [];
    if (contractId) w.push("contract_id = ?") && a.push(contractId);
    if (product) w.push("product = ?") && a.push(product);
    if (warehouseId) w.push("warehouse_id = ?") && a.push(warehouseId);
    if (sign === "in") w.push("qty > 0");
    if (sign === "out") w.push("qty < 0");
    const r = db.prepare(`SELECT COALESCE(SUM(qty), 0) AS q, COALESCE(SUM(amount), 0) AS a FROM stock_ledger ${w.length ? "WHERE " + w.join(" AND ") : ""}`).get(...a);
    return { qty: round(r.q, 6), amount: round(r.a, 2) };
  }

  function executed(c) {
    const id = c.id;
    const received = stockQty({ contractId: id, sign: "in" }).qty;
    const shipped = -stockQty({ contractId: id, sign: "out" }).qty;
    const bl = sum(docs("shipment", id), s => s.data.bl_qty);
    const arrived = sum(docs("shipment", id), s => s.data.arrived_qty);
    const fixed = sum(docs("pricing_fix", id), p => p.data.qty);
    const declared = sum(docs("customs", id), d => sum(d.data.items || [], i => i.qty));
    const matched = sum(E.list("match", `${live} AND json_extract(data, '$.active') = 1 AND (json_extract(data, '$.purchase') = ? OR json_extract(data, '$.sale') = ?)`, id, id), m => m.data.qty);
    const invoiced = sum(docs("invoice", id), i => i.data.total);
    return { received, shipped, bl, arrived, fixed, declared, matched, invoiced };
  }

  // 合同的已收/已付(认领到合同的人民币金额)
  function claimsFor(contractId, kind) {
    const rows = E.list("payment", `status = 'approved' AND json_extract(data, '$.kind') = ? AND data LIKE ?`, kind, `%"contract":${contractId}%`);
    const out = [];
    for (const p of rows) for (const cl of p.data.claims || []) if (cl.contract === contractId) out.push({ date: p.data.pay_date, amount: num(cl.amount), payment: p, claim: cl });
    return out;
  }

  // ---------- 授信额度 ----------
  function creditUsed(creditId) {
    const r = db.prepare("SELECT COALESCE(SUM(CASE WHEN kind = 'occupy' THEN amount ELSE -amount END), 0) AS u FROM credit_ledger WHERE credit_id = ?").get(creditId);
    return round(r.u, 2);
  }
  function refreshCredit(creditId) {
    const c = E.load(creditId);
    if (!c) return;
    c.data.used = creditUsed(creditId);
    c.data.available = round(num(c.data.amount) - c.data.used, 2);
    E.write(c);
  }
  function creditLines(partnerId, type) {
    const today = todayBJ();
    return E.list("credit_line", `status = 'approved' AND partner_id = ? AND json_extract(data, '$.credit_type') = ?`, partnerId, type)
      .filter(c => !c.data.frozen && (!c.data.valid_from || c.data.valid_from <= today) && (!c.data.valid_to || c.data.valid_to >= today));
  }
  function availableCredit(partnerId, type) {
    return round(sum(creditLines(partnerId, type), c => num(c.data.amount) - creditUsed(c.id)), 2);
  }
  // 合同在某额度类型上尚未释放的占用
  function contractOccupied(contractId, type) {
    const rows = db.prepare(`SELECT l.credit_id, SUM(CASE WHEN l.kind = 'occupy' THEN l.amount ELSE -l.amount END) AS remain
      FROM credit_ledger l JOIN records r ON r.id = l.credit_id WHERE l.contract_id = ? ${type ? "AND json_extract(r.data, '$.credit_type') = ?" : ""}
      GROUP BY l.credit_id`).all(...(type ? [contractId, type] : [contractId]));
    return rows.filter(r => r.remain > 0.005).map(r => ({ creditId: r.credit_id, remain: round(r.remain, 2) }));
  }
  function ledger(creditId, kind, amount, { recordId, contractId, note }) {
    if (amount <= 0.005) return;
    db.prepare("INSERT INTO credit_ledger (credit_id, record_id, contract_id, kind, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(creditId, recordId ?? null, contractId ?? null, kind, round(amount, 2), note || "", nowBJ());
  }
  function occupy(partnerId, type, amount, { recordId, contractId, note }) {
    amount = round(amount, 2);
    if (amount <= 0) return;
    const lines = creditLines(partnerId, type);
    const avail = round(sum(lines, c => num(c.data.amount) - creditUsed(c.id)), 2);
    if (avail + 0.005 < amount) throw bad(`${type}不足:需占用 ${amount.toLocaleString()} 元,可用 ${avail.toLocaleString()} 元。请先申请授信。`);
    let left = amount;
    for (const c of lines) {
      const a = Math.min(left, num(c.data.amount) - creditUsed(c.id));
      if (a > 0) {
        ledger(c.id, "occupy", a, { recordId, contractId, note });
        refreshCredit(c.id);
        left = round(left - a, 2);
      }
      if (left <= 0) break;
    }
  }
  // 按合同释放,最多释放到该合同剩余占用为止
  function release(contractId, type, amount, { recordId, note }) {
    let left = round(amount, 2);
    for (const o of contractOccupied(contractId, type)) {
      if (left <= 0) break;
      const a = Math.min(left, o.remain);
      ledger(o.creditId, "release", a, { recordId, contractId, note });
      refreshCredit(o.creditId);
      left = round(left - a, 2);
    }
  }
  // 删除某单据产生的全部台账(单据重算或作废时)
  function undoLedger(recordId) {
    const ids = db.prepare("SELECT DISTINCT credit_id FROM credit_ledger WHERE record_id = ?").all(recordId).map(r => r.credit_id);
    db.prepare("DELETE FROM credit_ledger WHERE record_id = ?").run(recordId);
    ids.forEach(refreshCredit);
  }

  // 合同需要占用的额度
  function contractCreditNeed(c) {
    const d = c.data, amt = num(d.amount_cny), pre = num(d.prepay_ratio) / 100;
    if (d.direction === "销售" && d.payment_method === "赊销") return { type: "赊销额度", amount: amt * (1 - pre) };
    if (d.direction === "销售" && d.payment_method === "中信保赊销") return { type: "中信保额度", amount: amt * (1 - pre) };
    if (d.direction === "采购" && d.payment_method === "预付款") return { type: "预付额度", amount: amt * pre };
    if (d.direction === "采购" && d.payment_method === "信用证") return { type: "开证额度", amount: amt };
    return null;
  }

  // ---------- 计息 ----------
  // 资金单元:采购合同若已匹配销售合同,其付款计入销售合同(以销定购),否则按合同本身
  function fundUnit(contractId) {
    const m = E.list("match", `${live} AND json_extract(data, '$.active') = 1 AND json_extract(data, '$.purchase') = ?`, contractId)[0];
    return m ? m.data.sale : contractId;
  }
  function dailyRate(c) {
    if (num(c.data.daily_rate)) return num(c.data.daily_rate);
    const fw = c.data.framework && E.load(c.data.framework);
    if (fw && num(fw.data.daily_rate)) return num(fw.data.daily_rate);
    const pj = c.data.project && E.load(c.data.project);
    if (pj && num(pj.data.daily_rate)) return num(pj.data.daily_rate);
    return num(getSettings(db).defaultDailyRate);
  }
  // 返回 { unitId -> [{date, amount(+付 -收)}] }
  function fundFlows() {
    const flows = new Map();
    for (const p of E.list("payment", "status = 'approved'")) {
      const sign = p.data.kind === "付款" ? 1 : p.data.kind === "收款" ? -1 : 0;
      if (!sign) continue;
      for (const cl of p.data.claims || []) {
        if (!cl.contract || cl.claim_type === "费用") continue;
        const u = fundUnit(cl.contract);
        if (!flows.has(u)) flows.set(u, []);
        flows.get(u).push({ date: p.data.pay_date, amount: sign * num(cl.amount) });
      }
    }
    return flows;
  }
  // 按日计息:每天的占用余额(只计正数)× 日利率。可限定区间 [from, to]
  function interestOf(unitId, flows, { from, to } = {}) {
    const c = E.load(unitId);
    const list = (flows.get(unitId) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const rate = c ? dailyRate(c) : 0;
    const end = to || todayBJ();
    let bal = 0, interest = 0, maxBal = 0, days = 0;
    const byDay = new Map();
    for (const f of list) byDay.set(f.date, (byDay.get(f.date) || 0) + f.amount);
    if (!list.length) return { rate, interest: 0, balance: 0, maxBal: 0, days: 0, daily: [] };
    const daily = [];
    for (let d = list[0].date; d <= end; d = addDays(d, 1)) {
      bal = round(bal + (byDay.get(d) || 0), 2);
      if (from && d < from) continue;
      if (bal > 0) {
        const i = bal * rate;
        interest += i;
        days++;
        daily.push({ date: d, balance: bal, interest: i });
      }
      maxBal = Math.max(maxBal, bal);
      if (daysBetween(list[0].date, d) > 3660) break;
    }
    return { rate, interest: round(interest, 2), balance: bal, maxBal, days, daily };
  }

  return {
    contractLimits, contractPrice, rateOf, docs, docsByField, stockQty, executed, claimsFor,
    creditUsed, refreshCredit, creditLines, availableCredit, contractOccupied, occupy, release, undoLedger, contractCreditNeed,
    fundUnit, dailyRate, fundFlows, interestOf,
  };
}
