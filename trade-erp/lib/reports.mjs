// 报表台账。每个报表返回 { title, columns: [{key,label,type}], rows, params?, note? }
import { REPORTS } from "./meta.mjs";
import { bad, todayBJ, num, round, sum } from "./util.mjs";

export function buildReports(E, C, extra) {
  const db = E.db;
  const col = (key, label, type) => ({ key, label, type });
  const M = "money", Q = "qty";
  const contracts = (where = "") => E.list("contract", `status = 'approved' ${where}`);
  const userName = id => (id ? db.prepare("SELECT name FROM users WHERE id = ?").get(id)?.name : "") || "";

  const R = {
    credit_ledger(q) {
      const rows = db.prepare(`SELECT l.*, cr.no AS credit_no, json_extract(cr.data, '$.partner_name') AS partner, json_extract(cr.data, '$.credit_type') AS ctype,
        d.no AS doc_no, d.type AS doc_type, ct.no AS contract_no FROM credit_ledger l JOIN records cr ON cr.id = l.credit_id
        LEFT JOIN records d ON d.id = l.record_id LEFT JOIN records ct ON ct.id = l.contract_id
        ${q.partner ? "WHERE cr.partner_id = ?" : ""} ORDER BY l.id DESC LIMIT 1000`).all(...(q.partner ? [Number(q.partner)] : []));
      return {
        params: [{ key: "partner", label: "客商", type: "ref", ref: "partner" }],
        columns: [col("created_at", "时间"), col("partner", "客商"), col("ctype", "额度类型"), col("credit_no", "授信档案"), col("kind", "方向"), col("amount", "金额", M),
          col("contract_no", "合同"), col("doc_no", "单据"), col("note", "说明")],
        rows: rows.map(r => ({ ...r, kind: r.kind === "occupy" ? "占用" : "释放", _link: r.record_id })),
      };
    },

    credit_summary() {
      const rows = E.list("credit_line", "status = 'approved'").map(c => ({
        partner: c.data.partner_name, ctype: c.data.credit_type, no: c.no, amount: c.data.amount, used: C.creditUsed(c.id),
        available: round(num(c.data.amount) - C.creditUsed(c.id), 2), valid_to: c.data.valid_to, state: c.data.frozen ? "冻结" : c.data.valid_to < todayBJ() ? "已到期" : "有效",
        rate: num(c.data.amount) ? round(C.creditUsed(c.id) / num(c.data.amount) * 100, 1) + "%" : "-", _link: c.id,
      }));
      return {
        columns: [col("partner", "客商"), col("ctype", "额度类型"), col("no", "档案号"), col("amount", "授信额度", M), col("used", "已占用", M), col("available", "可用", M),
          col("rate", "使用率"), col("valid_to", "到期日"), col("state", "状态")],
        rows,
      };
    },

    contract_ledger(q) {
      const rows = contracts().filter(c => !q.direction || c.data.direction === q.direction).map(c => {
        const ex = C.executed(c), isSale = c.data.direction === "销售";
        const money = sum(C.claimsFor(c.id, isSale ? "收款" : "付款"), x => x.amount);
        const settled = C.docs("settlement", c.id).filter(s => s.status === "approved").map(s => s.data.kind).pop() || "";
        return {
          no: c.no, direction: c.data.direction, trade_type: c.data.trade_type, partner: c.data.partner_name, product: c.data.product_summary, owner: userName(c.owner_id),
          qty: c.data.total_qty, amount: c.data.amount_cny, fixed: ex.fixed, bl: ex.bl, received: ex.received, shipped: ex.shipped, invoiced: ex.invoiced, money,
          progress: isSale ? pct(ex.shipped, c.data.total_qty) : pct(ex.received, c.data.total_qty), settled, closed: c.data.closed ? "已完结" : "执行中", _link: c.id,
        };
      });
      return {
        params: [{ key: "direction", label: "方向", type: "select", options: ["", "采购", "销售"] }],
        columns: [col("no", "合同号"), col("direction", "方向"), col("trade_type", "贸易类型"), col("partner", "签约方"), col("product", "品名"), col("owner", "业务员"),
          col("qty", "合同数量", Q), col("amount", "合同金额", M), col("fixed", "已点价", Q), col("bl", "提单", Q), col("received", "入库", Q), col("shipped", "出库", Q),
          col("progress", "执行进度"), col("invoiced", "已开/收票", M), col("money", "已收/付款", M), col("settled", "结算"), col("closed", "状态")],
        rows,
      };
    },

    project_pool() {
      const rows = E.list("project", "status = 'approved'").map(p => {
        const list = E.list("contract", "status = 'approved' AND project_id = ?", p.id);
        let inflow = 0, outflow = 0;
        for (const c of list) {
          inflow += sum(C.claimsFor(c.id, "收款"), x => x.amount);
          outflow += sum(C.claimsFor(c.id, "付款"), x => x.amount);
        }
        const margins = sum(E.list("margin", "status = 'approved' AND project_id = ?", p.id), m => m.data.received);
        return { name: p.data.name, contracts: list.length, budget: p.data.budget_amount, inflow: round(inflow, 2), outflow: round(outflow, 2),
          net: round(inflow - outflow, 2), margins, usage: num(p.data.budget_amount) ? pct(outflow - inflow, p.data.budget_amount) : "-", _link: p.id };
      });
      return {
        note: "项目资金池 = 项目下全部合同的收款 − 付款;净额为负表示公司资金被占用。",
        columns: [col("name", "项目"), col("contracts", "合同数"), col("budget", "项目额度", M), col("inflow", "累计收款", M), col("outflow", "累计付款", M),
          col("net", "资金池净额", M), col("usage", "额度占用率"), col("margins", "已收保证金", M)],
        rows,
      };
    },

    customer_pool() {
      const rows = contracts().filter(c => c.data.direction === "销售" && !c.data.closed).map(c => {
        const received = sum(C.claimsFor(c.id, "收款"), x => x.amount);
        const shippedValue = sum(db.prepare("SELECT product, -qty AS q FROM stock_ledger WHERE contract_id = ? AND qty < 0").all(c.id), x => x.q * C.contractPrice(c, x.product) * C.rateOf(c));
        const credit = C.availableCredit(c.partner_id, "赊销额度") + C.availableCredit(c.partner_id, "中信保额度");
        return { no: c.no, partner: c.data.partner_name, method: c.data.payment_method, amount: c.data.amount_cny, received, shipped_value: round(shippedValue, 2),
          pool: round(received - shippedValue, 2), credit: round(credit, 2), _link: c.id };
      });
      return {
        note: "放货余额 = 已收款 − 已发货货值。款到发货合同只能在放货余额内发货;赊销合同另可使用客户可用信用额度。",
        columns: [col("no", "合同"), col("partner", "客户"), col("method", "付款方式"), col("amount", "合同金额", M), col("received", "已收款", M),
          col("shipped_value", "已发货货值", M), col("pool", "放货余额", M), col("credit", "客户可用信用额度", M)],
        rows,
      };
    },

    interest() {
      const flows = C.fundFlows();
      const rows = [...flows.keys()].map(id => {
        const c = E.load(id);
        const r = C.interestOf(id, flows);
        return { no: c?.no, partner: c?.data.partner_name, owner: userName(c?.owner_id), dept: c?.dept, rate: r.rate, balance: r.balance, max: r.maxBal, days: r.days, interest: r.interest, _link: id };
      }).sort((a, b) => b.interest - a.interest);
      return {
        note: "按合同(已采销匹配的采购付款并入对应销售合同)逐日计算:占用余额 = 累计付款 − 累计收款,只对正余额计息,日利率取合同 → 框架协议 → 项目 → 系统默认。",
        columns: [col("no", "合同"), col("partner", "签约方"), col("owner", "业务员"), col("dept", "部门"), col("rate", "日利率"), col("balance", "当前占用", M),
          col("max", "最高占用", M), col("days", "计息天数"), col("interest", "累计利息", M)],
        rows,
      };
    },

    interest_by_owner(q) {
      const month = q.month || todayBJ().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) throw bad("月份格式 YYYY-MM");
      const from = `${month}-01`, to = lastDay(month);
      const flows = C.fundFlows();
      const agg = new Map();
      for (const id of flows.keys()) {
        const c = E.load(id);
        const r = C.interestOf(id, flows, { from, to: to > todayBJ() ? todayBJ() : to });
        if (!r.interest) continue;
        const k = `${c?.dept || "未分部门"}|${userName(c?.owner_id) || "未知"}`;
        const a = agg.get(k) || { dept: k.split("|")[0], owner: k.split("|")[1], contracts: 0, avg: 0, interest: 0 };
        a.contracts++;
        a.interest = round(a.interest + r.interest, 2);
        a.avg = round(a.avg + sum(r.daily, x => x.balance) / Math.max(1, daysIn(from, to)), 2);
        agg.set(k, a);
      }
      return {
        params: [{ key: "month", label: "月份(YYYY-MM)", type: "text", value: month }],
        columns: [col("dept", "部门"), col("owner", "业务员"), col("contracts", "计息合同数"), col("avg", "日均资金占用", M), col("interest", "当月利息", M)],
        rows: [...agg.values()].sort((a, b) => b.interest - a.interest),
      };
    },

    budget_exec(q) {
      const month = q.month || todayBJ().slice(0, 7);
      const budgets = E.list("budget", "status = 'approved' AND json_extract(data, '$.month') = ?", month);
      const rows = [];
      for (const b of budgets) {
        for (const it of b.data.items || []) {
          const kind = it.kind === "收款" ? "收款" : "付款";
          const actual = it.contract ? sum(C.claimsFor(it.contract, kind).filter(x => String(x.date).startsWith(month)), x => x.amount) : 0;
          const c = it.contract ? E.load(it.contract) : null;
          rows.push({ dept: b.data.dept, contract: c?.no || "-", partner: c?.data.partner_name || it.note, kind, plan_date: it.date, plan: it.amount, actual,
            diff: round(actual - num(it.amount), 2), rate: pct(actual, it.amount), _link: c?.id });
        }
      }
      return {
        params: [{ key: "month", label: "月份(YYYY-MM)", type: "text", value: month }],
        columns: [col("dept", "事业部"), col("contract", "合同"), col("partner", "对方"), col("kind", "收/付"), col("plan_date", "计划日期"), col("plan", "计划金额", M),
          col("actual", "实际金额", M), col("diff", "差异", M), col("rate", "执行率")],
        rows,
      };
    },

    stock() {
      const rows = db.prepare("SELECT product, warehouse_id, SUM(qty) AS qty, SUM(amount) AS amount FROM stock_ledger GROUP BY product, warehouse_id HAVING ABS(SUM(qty)) > 0.000001").all().map(r => {
        const wh = E.load(r.warehouse_id);
        const mp = extra.latestPrice(r.product);
        const mv = mp ? round(r.qty * mp.price, 2) : null;
        return { product: r.product, warehouse: wh?.data.name || "-", qty: round(r.qty, 3), cost: round(r.amount, 2), avg: r.qty ? round(r.amount / r.qty, 2) : 0,
          market: mp?.price ?? null, market_date: mp?.date || "无行情", value: mv, pnl: mv === null ? null : round(mv - r.amount, 2) };
      });
      return {
        note: "浮动盈亏 = 库存数量 × 最新行情价 − 库存成本。行情在「市场行情」维护。",
        columns: [col("product", "物料"), col("warehouse", "仓库"), col("qty", "库存数量", Q), col("cost", "库存成本", M), col("avg", "平均成本", M), col("market", "最新行情", M),
          col("market_date", "行情日期"), col("value", "市值", M), col("pnl", "浮动盈亏", M)],
        rows,
      };
    },

    weight_diff() {
      const rows = contracts().map(c => {
        const ex = C.executed(c);
        if (!ex.bl && !ex.received && !ex.shipped) return null;
        return { no: c.no, partner: c.data.partner_name, product: c.data.product_summary, bl: ex.bl, arrived: ex.arrived, received: ex.received, shipped: ex.shipped,
          d1: round(ex.arrived - ex.bl, 3), d2: round(ex.received - (ex.arrived || ex.bl), 3), d3: c.data.direction === "销售" ? null : round(ex.shipped - ex.received, 3),
          rate: ex.bl ? round((ex.received - ex.bl) / ex.bl * 1000, 2) + "‰" : "-", _link: c.id };
      }).filter(Boolean);
      return {
        note: "差异需处理时,在「库存调整(磅差)」登记调整,审批后计入库存流水;结算单会带出磅差说明。",
        columns: [col("no", "合同"), col("partner", "签约方"), col("product", "品名"), col("bl", "提单数量", Q), col("arrived", "到港数量", Q), col("received", "入库数量", Q),
          col("shipped", "出库数量", Q), col("d1", "到港-提单", Q), col("d2", "入库-到港", Q), col("d3", "出库-入库", Q), col("rate", "入库磅差率")],
        rows,
      };
    },

    ar_ap() {
      const rows = contracts().map(c => {
        const isSale = c.data.direction === "销售";
        const invoiced = sum(C.docs("invoice", c.id).filter(i => i.data.direction === (isSale ? "销项" : "进项")), i => i.data.total);
        const money = sum(C.claimsFor(c.id, isSale ? "收款" : "付款").filter(x => x.claim.claim_type !== "保证金"), x => x.amount);
        const ex = C.executed(c);
        const goods = round((isSale ? ex.shipped : ex.received) * C.contractPrice(c) * C.rateOf(c), 2);
        const due = (c.data.pay_plan || []).filter(p => p.date <= todayBJ()).reduce((s, p) => s + num(p.amount) * C.rateOf(c), 0);
        return { no: c.no, kind: isSale ? "应收" : "应付", partner: c.data.partner_name, goods, invoiced, money, balance: round(Math.max(goods, invoiced) - money, 2),
          overdue: round(Math.max(0, due - money), 2), _link: c.id };
      }).filter(r => r.goods || r.invoiced || r.money);
      return {
        note: "余额 = max(已发/收货货值, 已开/收票) − 已收/付款;逾期 = 到期收付款计划 − 已收/付款。正式应收应付核算以金蝶财务为准。",
        columns: [col("no", "合同"), col("kind", "类型"), col("partner", "对方"), col("goods", "货值", M), col("invoiced", "已开/收票", M), col("money", "已收/付款", M),
          col("balance", "余额", M), col("overdue", "逾期金额", M)],
        rows,
      };
    },

    margin_status() {
      const rows = E.list("margin", "status = 'approved'").map(m => {
        const c = E.load(m.data.contract);
        const mp = extra.latestPrice(m.data.product || c?.data.items?.[0]?.product || "");
        const calls = (m.data.events || []).filter(e => e.kind === "追保通知");
        return { partner: m.data.partner_name, contract: c?.no, direction: m.data.direction, ratio: m.data.ratio + "%", required: m.data.required, calls: calls.length,
          call_total: m.data.call_total, received: m.data.received, gap: m.data.gap, market: mp?.price ?? null, _link: m.id };
      });
      return {
        columns: [col("partner", "客商"), col("contract", "合同"), col("direction", "方向"), col("ratio", "比例"), col("required", "初始应收", M), col("calls", "追保次数"),
          col("call_total", "累计追保", M), col("received", "已收", M), col("gap", "缺口", M), col("market", "最新行情", M)],
        rows,
      };
    },
  };

  return function run(name, q) {
    if (!R[name]) throw bad("报表不存在");
    return { title: REPORTS[name].label, ...R[name](q || {}) };
  };
}

function pct(a, b) {
  return num(b) ? round(num(a) / num(b) * 100, 1) + "%" : "-";
}
function lastDay(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function daysIn(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400e3) + 1;
}
