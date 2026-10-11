// 各单据的业务规则(引擎在保存、生效、审批、作废时调用,见 engine.mjs 顶部说明)
import crypto from "node:crypto";
import { ENTITIES, SENSITIVE_PARTNER_FIELDS } from "./meta.mjs";
import { bad, HttpError, nowBJ, todayBJ, num, round, sum, nameKey, evalFormula, hashPassword } from "./util.mjs";
import { getSettings } from "./db.mjs";
import { hasRole, isPortal } from "./engine.mjs";

export function buildHooks(E, C) {
  const db = E.db;
  const internal = u => !isPortal(u);
  const fmt = n => round(n, 2).toLocaleString("zh-CN");
  const contractOf = data => (data.contract ? E.load(data.contract) : null);
  const firstProduct = c => c?.data.items?.[0]?.product || "";

  // 门户用户引用的合同必须是自己的
  function portalOwnContract(ctx, contractId) {
    if (!isPortal(ctx.user) || !contractId) return;
    const c = E.load(contractId);
    if (!c || c.partner_id !== ctx.user.partner_id) throw bad("只能选择本单位的合同");
  }

  function latestPrice(product) {
    const rows = E.list("market_price", "status = 'approved' AND json_extract(data, '$.product') = ?", product);
    rows.sort((a, b) => b.data.date.localeCompare(a.data.date) || b.id - a.id);
    return rows[0] ? { price: num(rows[0].data.price), date: rows[0].data.date } : null;
  }

  // ---------- 黑名单比对 ----------
  function blacklistMatch(p) {
    const code = String(p.credit_code || "").trim().toUpperCase(), key = nameKey(p.name);
    return E.list("blacklist", "status = 'approved' AND json_extract(data, '$.active') = 1").find(b =>
      (code && String(b.data.credit_code || "").trim().toUpperCase() === code) || (key && nameKey(b.data.name) === key));
  }
  function applyBlacklist(ctx) {
    let n = 0;
    for (const p of E.list("partner", "status != 'cancelled'")) {
      if (p.data.locked) continue;
      const hit = blacklistMatch(p.data);
      if (!hit) continue;
      p.data.locked = true;
      p.data.lock_reason = `命中黑名单(${hit.data.source || ""}):${hit.data.reason || hit.data.name}`;
      E.write(p);
      E.log(p.id, ctx.user, "黑名单锁定", p.data.lock_reason);
      E.notify({ role: "risk", title: `客商命中黑名单已锁定:${p.data.name}`, record_id: p.id });
      n++;
    }
    return n;
  }

  // ---------- 保证金追保 ----------
  function marginCall(ctx, m, { auto = false } = {}) {
    const c = E.load(m.data.contract);
    const product = m.data.product || firstProduct(c);
    const mp = latestPrice(product);
    if (!mp) return auto ? null : bad(`没有「${product}」的市场行情,请先在「市场行情」登记`);
    const qty = num(c.data.total_qty), cPrice = C.contractPrice(c) * C.rateOf(c);
    const adverse = m.data.direction === "向客户收取" ? Math.max(0, cPrice - mp.price) * qty : Math.max(0, mp.price - cPrice) * qty;
    const need = round(num(m.data.required) + adverse, 2);
    const covered = round(num(m.data.required) + num(m.data.call_total), 2);
    const gap = round(need - covered, 2);
    const threshold = num(getSettings(db).marginCallThreshold);
    if (gap <= Math.max(threshold, 0.005)) return auto ? null : { message: `按 ${mp.date} 行情 ${fmt(mp.price)} 计算,保证金充足,无需追保` };
    m.data.events = [...(m.data.events || []), { date: todayBJ(), kind: "追保通知", amount: gap, market_price: mp.price, note: `${auto ? "行情更新自动追保" : "手工追保"}:合同价 ${fmt(cPrice)},行情 ${fmt(mp.price)}` }];
    recalcMargin(m.data);
    E.write(m);
    E.log(m.id, ctx.user, "追保通知", `追加保证金 ${fmt(gap)} 元`);
    if (m.partner_id) E.notify({ partner_id: m.partner_id, title: `追加保证金通知:${fmt(gap)} 元`, body: `合同 ${E.label(c)},请于 3 个工作日内补足`, record_id: m.id });
    E.notify({ role: "biz", title: `已发起追保:${m.data.partner_name} ${fmt(gap)} 元`, record_id: m.id });
    return { message: `已追保 ${fmt(gap)} 元` };
  }
  function recalcMargin(d) {
    const ev = d.events || [];
    d.received = round(sum(ev.filter(e => e.kind === "收取"), e => e.amount) - sum(ev.filter(e => e.kind === "退还"), e => e.amount), 2);
    d.call_total = sum(ev.filter(e => e.kind === "追保通知"), e => e.amount);
    d.gap = round(num(d.required) + num(d.call_total) - num(d.received), 2);
  }

  // ---------- 合同价格计算 ----------
  function priceContract(d) {
    const fm = d.formula ? E.load(d.formula) : null;
    const tol = num(d.tolerance);
    if (tol < 0 || tol > 50) throw bad("溢短装比例需在 0 ~ 50% 之间");
    for (const it of d.items || []) {
      if (d.pricing_method !== "一口价" && fm) {
        const base = d.pricing_method === "点价" && num(d.fixed_qty) > 0 ? num(d.fixed_avg) : num(it.base_price);
        it.price = round(evalFormula(fm.data.expression, {
          基准价: base, 升贴水: num(it.premium), 含量: num(it.content), 系数: num(it.coef) || 1, 汇率: num(d.exchange_rate) || 1, 点价均价: num(d.fixed_avg),
        }), 4);
      } else if (d.pricing_method === "点价" && num(d.fixed_qty) > 0 && !fm) {
        it.price = round(num(d.fixed_avg) + num(it.premium), 4);
      }
      it.amount = round(num(it.qty) * num(it.price), 2);
    }
    d.total_qty = sum(d.items || [], i => i.qty);
    d.total_amount = sum(d.items || [], i => i.amount);
    d.amount_cny = round(d.total_amount * (num(d.exchange_rate) || 1), 2);
    d.product_summary = [...new Set((d.items || []).map(i => i.product))].join("/").slice(0, 60);
  }

  function clauseCheck(d) {
    let changed = false;
    const notes = [];
    for (const cl of d.clauses || []) {
      if (cl.clause) {
        const src = E.load(cl.clause);
        if (src) {
          cl.origin = src.data.content;
          if (!cl.title) cl.title = src.data.title;
          if (!cl.content) cl.content = src.data.content;
          if (cl.content.trim() !== String(src.data.content).trim()) {
            changed = true;
            notes.push(`修改了「${src.data.title}」`);
          }
        }
      } else if (cl.content) {
        changed = true;
        notes.push(`新增非标条款「${cl.title}」`);
      }
    }
    const cats = ["通用", d.direction, d.trade_type === "进口" ? "进口" : d.trade_type === "出口" ? "出口" : null].filter(Boolean);
    const used = new Set((d.clauses || []).map(c => c.clause).filter(Boolean));
    for (const m of E.list("clause", "status = 'approved' AND json_extract(data, '$.mandatory') = 1")) {
      if (cats.includes(m.data.category) && !used.has(m.id)) {
        changed = true;
        notes.push(`删除了必选条款「${m.data.title}」`);
      }
    }
    d.clause_changed = changed;
    d.clause_notes = notes.join(";");
  }

  function reoccupyContract(ctx, c) {
    // 先把本合同之前占用(合同自身记的占用)全部冲回,再按最新金额占用
    db.prepare("DELETE FROM credit_ledger WHERE record_id = ? AND kind = 'occupy'").run(c.id);
    const affected = db.prepare("SELECT DISTINCT credit_id FROM credit_ledger WHERE contract_id = ?").all(c.id).map(r => r.credit_id);
    affected.forEach(C.refreshCredit);
    const need = C.contractCreditNeed(c);
    if (need && need.amount > 0) {
      // 已释放部分(收款/入库)保持不变:应占用 = 需求 - 已释放
      const released = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM credit_ledger WHERE contract_id = ? AND kind = 'release'").get(c.id).s;
      C.occupy(c.partner_id, need.type, Math.max(0, need.amount - released), { recordId: c.id, contractId: c.id, note: `合同 ${c.no} V${c.version} 审批生效` });
    }
  }

  function releaseAllForContract(ctx, c, note) {
    for (const o of C.contractOccupied(c.id)) {
      db.prepare("INSERT INTO credit_ledger (credit_id, record_id, contract_id, kind, amount, note, created_at) VALUES (?, ?, ?, 'release', ?, ?, ?)")
        .run(o.creditId, c.id, c.id, o.remain, note, nowBJ());
      C.refreshCredit(o.creditId);
    }
  }

  function recalcFixes(ctx, contractId) {
    const c = E.load(contractId);
    const fixes = C.docs("pricing_fix", contractId);
    const q = sum(fixes, f => f.data.qty);
    c.data.fixed_qty = q;
    c.data.fixed_avg = q ? round(sum(fixes, f => num(f.data.qty) * num(f.data.price)) / q, 4) : 0;
    priceContract(c.data);
    E.write(c);
    E.log(c.id, ctx.user, "点价反写", `已点价 ${q},均价 ${c.data.fixed_avg}`);
  }

  function refreshGuarantee(id) {
    const g = E.load(id);
    if (!g) return;
    g.data.used = sum(E.list("tax_payment", "status = 'approved' AND json_extract(data, '$.guarantee') = ?", id), t => t.data.guarantee_amount);
    g.data.balance = round(num(g.data.amount) - g.data.used, 2);
    E.write(g);
  }

  function refreshFxLock(id) {
    const l = E.load(id);
    if (!l) return;
    l.data.used = sum(E.list("payment", "status = 'approved' AND json_extract(data, '$.fx_lock') = ?", id), p => p.data.amount);
    E.write(l);
  }

  function missingDocs(rec) {
    const req = getSettings(db).requiredAttachments[rec.type] || ENTITIES[rec.type].attachments?.required || [];
    const have = new Set(db.prepare("SELECT DISTINCT category FROM attachments WHERE record_id = ?").all(rec.id).map(a => a.category));
    return req.filter(c => !have.has(c));
  }

  // 付款/收款对额度的释放(幂等:先删本单据的台账再重算)
  function paymentRelease(ctx, p) {
    C.undoLedger(p.id);
    if (p.status !== "approved") return;
    for (const cl of p.data.claims || []) {
      const c = E.load(cl.contract);
      if (!c) continue;
      const opts = { recordId: p.id, note: `${p.data.kind} ${p.no}` };
      if (p.data.kind === "收款" && c.data.direction === "销售") {
        C.release(c.id, "赊销额度", num(cl.amount), opts);
        C.release(c.id, "中信保额度", num(cl.amount), opts);
      }
      if (p.data.kind === "付款" && c.data.direction === "采购" && c.data.payment_method === "信用证") C.release(c.id, "开证额度", num(cl.amount), opts);
    }
  }

  const H = {};

  // =========================== 客商 ===========================
  H.partner = {
    beforeSave(ctx, d, prev) {
      if (!d.name) throw bad("请填写企业名称");
      if (d.credit_code && d.region !== "国外" && !/^[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}$/.test(String(d.credit_code).toUpperCase())) throw bad("统一社会信用代码格式不正确");
      if (d.credit_code) d.credit_code = String(d.credit_code).toUpperCase();
      if ((d.ptype || []).includes("内部组织") && !d.internal_org) throw bad("内部组织客商请选择「对应内部组织」");
      // 查重
      const rules = getSettings(db).dedupRules || [];
      const others = E.list("partner", "status != 'cancelled' AND id != ?", prev?.id || 0);
      const checks = {
        creditCode: ["统一社会信用代码", p => p.credit_code && p.credit_code === d.credit_code],
        name: ["企业名称", p => nameKey(p.name) === nameKey(d.name)],
        bankAccount: ["收款账号", p => d.bank_account && p.bank_account === d.bank_account],
        phone: ["联系电话", p => d.phone && p.phone === d.phone],
      };
      for (const r of rules) {
        const [lbl, fn] = checks[r] || [];
        const dup = fn && others.find(o => fn(o.data));
        if (dup) throw bad(`客商重复:与「${dup.data.name}」(${dup.no})的${lbl}相同`);
      }
      const hit = blacklistMatch(d);
      if (hit && !d.locked) {
        d.locked = true;
        d.lock_reason = `命中黑名单(${hit.data.source || ""}):${hit.data.reason || hit.data.name}`;
      }
    },
    validateActive(ctx, rec) {
      if (rec.data.locked) throw bad(`该客商已被锁定:${rec.data.lock_reason || "黑名单"}`);
    },
    actions: {
      unlock: {
        label: "解除锁定", show: (r, u) => r.data.locked && hasRole(u, "risk"), comment: "解除原因", commentRequired: true,
        run(ctx, r) {
          if (blacklistMatch(r.data)) throw bad("该客商仍在有效黑名单中,请先停用对应黑名单记录");
          r.data.locked = false;
          r.data.lock_reason = "";
          E.write(r);
        },
      },
      portal_account: {
        label: "开通门户账号", show: (r, u) => internal(u) && r.status === "approved" && !db.prepare("SELECT 1 FROM users WHERE partner_id = ?").get(r.id),
        confirm: "将为该客商开通外部门户账号(用户名为信用代码或手机号),初始密码只显示一次,请转告对方。",
        run(ctx, r) {
          const username = r.data.credit_code || r.data.phone;
          if (!username) throw bad("请先填写统一社会信用代码或联系电话作为登录名");
          if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) throw bad(`登录名 ${username} 已被占用`);
          const pw = crypto.randomBytes(9).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
          db.prepare("INSERT INTO users (username, name, password, roles, partner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(username, r.data.contact || r.data.name, hashPassword(pw), JSON.stringify(["portal"]), r.id, nowBJ(), nowBJ());
          return { message: `门户账号已开通:用户名 ${username},初始密码 ${pw}` };
        },
      },
    },
  };

  H.partner_change = {
    beforeSave(ctx, d, prev) {
      const p = E.load(d.partner);
      if (!p || p.type !== "partner") throw bad("请选择客商");
      const allowed = ENTITIES.partner.fields.filter(fd => !fd.ro && fd.key !== "ptype" && fd.key !== "internal_org").map(fd => fd.key);
      const changes = {};
      for (const [k, v] of Object.entries(d.changes || {})) {
        if (allowed.includes(k) && String(v ?? "").trim() !== "" && String(v).trim() !== String(p.data[k] ?? "")) changes[k] = String(v).trim().slice(0, 2000);
      }
      if (!Object.keys(changes).length) throw bad("没有填写任何与现有资料不同的变更内容");
      d.changes = changes;
      d.need_approval = Object.keys(changes).some(k => SENSITIVE_PARTNER_FIELDS.includes(k));
    },
    steps: (ctx, rec) => (rec.data.need_approval ? ["risk"] : []),
    onApproved(ctx, rec) {
      const p = E.load(rec.data.partner);
      const diff = Object.entries(rec.data.changes).map(([k, v]) => ({ field: k, label: ENTITIES.partner.fields.find(f => f.key === k)?.label || k, from: p.data[k] ?? null, to: v }));
      Object.assign(p.data, rec.data.changes);
      H.partner.beforeSave(ctx, p.data, p); // 改名后重新查重、比对黑名单
      E.write(p);
      E.log(p.id, ctx.user, `信息变更(${rec.no})`, rec.data.reason || "", diff);
    },
  };

  H.risk_scheme = {
    beforeSave(ctx, d) {
      for (const l of d.indexes || []) if (l.index && !num(l.weight)) l.weight = num(E.load(l.index)?.data.weight) || 10;
      d.grades = (d.grades || []).sort((a, b) => num(b.min_score) - num(a.min_score));
    },
  };

  H.partner_rating = {
    beforeSave(ctx, d) {
      const s = d.scheme && E.load(d.scheme);
      if (s && !(d.scores || []).length) d.scores = (s.data.indexes || []).map(l => ({ index: l.index, weight: l.weight, score: null, note: "" }));
      const rows = (d.scores || []).filter(r => r.score !== null && r.score !== undefined);
      for (const r of rows) if (num(r.score) < 0 || num(r.score) > 100) throw bad("指标得分需在 0 ~ 100 之间");
      const w = sum(rows, r => r.weight || 1);
      d.score = w ? round(sum(rows, r => num(r.score) * (num(r.weight) || 1)) / w, 1) : null;
      const g = s && d.score !== null ? (s.data.grades || []).find(x => d.score >= num(x.min_score)) : null;
      d.grade = g?.grade || (d.score !== null ? "未达最低等级" : "");
      d.credit_class = g?.credit_class || "";
      d.credit_cap = g?.credit_cap ?? null;
      d.margin_ratio = g?.margin_ratio ?? null;
    },
    validateActive(ctx, rec) {
      if (!(rec.data.scores || []).length || rec.data.scores.some(r => r.score === null || r.score === undefined)) throw bad("请为每个指标打分");
    },
    onApproved(ctx, rec) {
      const p = E.load(rec.data.partner);
      const diff = [{ field: "rating", label: "评级", from: p.data.rating ?? null, to: rec.data.grade }];
      p.data.rating = rec.data.grade;
      p.data.credit_class = rec.data.credit_class;
      E.write(p);
      E.log(p.id, ctx.user, `评级更新(${rec.no})`, `总分 ${rec.data.score}`, diff);
    },
  };

  H.blacklist = {
    beforeSave(ctx, d) {
      if (d.credit_code) d.credit_code = String(d.credit_code).toUpperCase().trim();
    },
    onApproved(ctx) {
      applyBlacklist(ctx);
    },
  };

  H.credit_apply = {
    beforeSave(ctx, d) {
      if (d.credit_type === "库存授信" && !d.product && !d.warehouse) throw bad("库存授信请填写物料或仓库");
      if (d.valid_from && d.valid_to && d.valid_to < d.valid_from) throw bad("到期日期不能早于生效日期");
      if (num(d.amount) <= 0 && !num(d.qty_cap)) throw bad("请填写申请额度");
    },
    onApproved(ctx, rec) {
      const d = rec.data;
      const line = E.insertRaw("credit_line", {
        partner: d.partner, partner_name: d.partner_name, credit_type: d.credit_type, amount: num(d.amount), used: 0, available: num(d.amount),
        product: d.product, qty_cap: d.qty_cap, warehouse: d.warehouse, valid_from: d.valid_from, valid_to: d.valid_to, frozen: false, apply: rec.id,
      }, { user: ctx.user, status: "approved" });
      E.log(line.id, ctx.user, "授信生效", `来自 ${rec.no}`);
      E.notify({ role: "biz", title: `授信已生效:${d.partner_name} ${d.credit_type} ${fmt(d.amount)} 元`, record_id: line.id });
    },
  };

  H.credit_line = {
    beforeSave(ctx, d, prev) {
      if (!prev) throw bad("授信档案由授信申请审批生成");
    },
    onApproved(ctx, rec) {
      if (rec.data.used === undefined) C.refreshCredit(rec.id);
    },
  };

  // =========================== 立项与资金 ===========================
  H.project = {
    validateActive(ctx, rec) {
      if (!(rec.data.parties || []).some(p => p.role === "核心企业")) throw bad("请至少添加一个「核心企业」参与方");
    },
  };

  H.margin = {
    beforeSave(ctx, d) {
      const c = contractOf(d);
      if (c) {
        d.partner = c.data.partner;
        d.partner_name = c.data.partner_name;
        d.project = c.data.project || null;
        d.base_amount = num(c.data.amount_cny);
        if (!d.product) d.product = firstProduct(c);
      }
      d.required = round(num(d.base_amount) * num(d.ratio) / 100, 2);
      recalcMargin(d);
    },
    actions: {
      call: { label: "按最新行情追保", show: (r, u) => internal(u) && r.status === "approved", run: (ctx, r) => marginCall(ctx, r) },
    },
  };

  H.guarantee = {
    beforeSave(ctx, d, prev) {
      d.used = prev ? sum(E.list("tax_payment", "status = 'approved' AND json_extract(data, '$.guarantee') = ?", prev.id), t => t.data.guarantee_amount) : 0;
      d.balance = round(num(d.amount) - d.used, 2);
      if (d.balance < 0) throw bad("保函金额不能小于已抵扣金额");
    },
  };

  H.budget = {
    beforeSave(ctx, d) {
      if (!/^\d{4}-\d{2}$/.test(d.month || "")) throw bad("预算月份格式为 YYYY-MM");
      d.plan_in = sum((d.items || []).filter(i => i.kind === "收款"), i => i.amount);
      d.plan_out = sum((d.items || []).filter(i => i.kind === "付款"), i => i.amount);
    },
    actions: {
      autofill: {
        label: "自动获取计划收付款", show: (r, u) => internal(u) && ["draft", "rejected"].includes(r.status),
        run(ctx, r) {
          const items = [];
          for (const c of E.list("contract", "status = 'approved' AND dept = ?", r.data.dept)) {
            if (c.data.closed) continue;
            for (const p of c.data.pay_plan || []) {
              if (!String(p.date || "").startsWith(r.data.month)) continue;
              items.push({ contract: c.id, kind: c.data.direction === "销售" ? "收款" : "付款", date: p.date, amount: round(num(p.amount) * C.rateOf(c), 2), note: `${p.kind} · ${c.data.partner_name}` });
            }
          }
          r.data.items = items;
          H.budget.beforeSave(ctx, r.data);
          E.write(r);
          return { message: `已带出 ${items.length} 条计划收付款` };
        },
      },
    },
  };

  // =========================== 合同 ===========================
  H.formula = {
    beforeSave(ctx, d) {
      d.test_result = round(evalFormula(d.expression, { 基准价: 1000, 升贴水: 1, 含量: 1, 系数: 1, 汇率: 1, 点价均价: 1000 }), 4);
    },
  };

  H.market_price = {
    onApproved(ctx, rec, prevData) {
      if (prevData && prevData.price === rec.data.price) return;
      const latest = latestPrice(rec.data.product);
      if (!latest || latest.date > rec.data.date) return;
      for (const m of E.list("margin", "status = 'approved'")) {
        const c = E.load(m.data.contract);
        if ((m.data.product || firstProduct(c)) === rec.data.product && !c?.data.closed) marginCall(ctx, m, { auto: true });
      }
    },
  };

  H.rfq = {
    validateActive(ctx, rec) {
      const d = rec.data;
      if (!d.winner) throw bad("请先选定供应商再提交采购请示");
      if (!(d.quotes || []).some(q => q.supplier === d.winner)) throw bad("选定的供应商没有报价");
    },
    actions: {
      invite: {
        label: "发出报价邀请", show: (r, u) => internal(u) && ["draft", "rejected"].includes(r.status),
        run(ctx, r) {
          for (const pid of r.data.invited || []) E.notify({ partner_id: pid, title: `报价邀请:${r.data.subject}`, body: `截止 ${r.data.deadline}`, record_id: r.id });
          return { message: `已通知 ${(r.data.invited || []).length} 家供应商${r.data.public ? ",并公开公告" : ""}` };
        },
      },
      quote: {
        label: "提交报价", portal: true, primary: true,
        show: (r, u) => isPortal(u) && ["draft", "rejected"].includes(r.status) && r.data.deadline >= todayBJ(),
        inputs: [{ key: "product", label: "品名/服务", type: "text", required: true }, { key: "price", label: "单价", type: "money", required: true },
          { key: "qty", label: "数量", type: "qty" }, { key: "delivery", label: "交期/条件", type: "text" }, { key: "remark", label: "备注", type: "text" }],
        run(ctx, r, p) {
          if (!p.product || !(num(p.price) > 0)) throw bad("请填写品名和单价");
          const quotes = (r.data.quotes || []).filter(q => !(q.supplier === ctx.user.partner_id && q.product === p.product));
          quotes.push({ supplier: ctx.user.partner_id, product: String(p.product).slice(0, 100), price: num(p.price), qty: num(p.qty) || null, delivery: String(p.delivery || "").slice(0, 100), remark: String(p.remark || "").slice(0, 200), quoted_at: nowBJ() });
          r.data.quotes = quotes;
          E.write(r);
          E.notify({ role: "biz", title: `收到报价:${r.data.subject}`, record_id: r.id });
          return { message: "报价已提交" };
        },
      },
    },
  };

  H.pricing = {
    beforeSave(ctx, d) {
      d.price = round((num(d.cost_price) + num(d.fee_price)) * (1 + num(d.margin_pct) / 100), 2);
    },
    onApproved(ctx, rec) {
      rec.data.customer_reply = "待确认";
      E.write(rec);
      E.notify({ partner_id: rec.partner_id, title: `价格待确认:${rec.data.product} ${fmt(rec.data.price)} 元/${rec.data.unit}`, body: `有效期至 ${rec.data.valid_to}`, record_id: rec.id });
    },
    actions: {
      accept: {
        label: "确认价格", portal: true, primary: true, show: (r, u) => isPortal(u) && r.status === "approved" && r.data.customer_reply === "待确认",
        run(ctx, r, p) {
          if (r.data.valid_to < todayBJ()) throw bad("报价已过有效期,请联系业务员重新报价");
          r.data.customer_reply = "已确认";
          r.data.customer_note = String(p.comment || "").slice(0, 200);
          E.write(r);
          E.notify({ role: "biz", title: `客户已确认价格:${r.data.partner_name} ${r.data.product}`, record_id: r.id });
        },
      },
      decline: {
        label: "不接受", portal: true, danger: true, comment: "意见", show: (r, u) => isPortal(u) && r.status === "approved" && r.data.customer_reply === "待确认",
        run(ctx, r, p) {
          r.data.customer_reply = "已拒绝";
          r.data.customer_note = String(p.comment || "").slice(0, 200);
          E.write(r);
          E.notify({ role: "biz", title: `客户未接受报价:${r.data.partner_name} ${r.data.product}`, record_id: r.id });
        },
      },
    },
  };

  H.contract = {
    beforeSave(ctx, d, prev) {
      if (!(num(d.exchange_rate) > 0)) d.exchange_rate = 1;
      if (d.currency === "CNY") d.exchange_rate = 1;
      if (num(d.prepay_ratio) < 0 || num(d.prepay_ratio) > 100) throw bad("预付比例需在 0 ~ 100% 之间");
      if (prev) {
        d.fixed_qty = prev.data.fixed_qty;
        d.fixed_avg = prev.data.fixed_avg;
      }
      priceContract(d);
      clauseCheck(d);
    },
    steps: (ctx, rec) => (rec.data.clause_changed ? ["legal", "manager"] : ["manager"]),
    validateActive(ctx, rec) {
      const d = rec.data;
      if (!(d.items || []).length) throw bad("请填写货物明细");
      if (d.pricing_method !== "一口价" && d.pricing_method !== "点价" && !d.formula) throw bad(`${d.pricing_method}请选择计价公式`);
      const lim = C.contractLimits(rec);
      // 变更:校验下游已执行量
      if (rec.version > 1) {
        const ex = C.executed(rec);
        const done = Math.max(ex.received, ex.shipped, ex.bl, ex.fixed, ex.declared);
        if (done > lim.max + 1e-6) throw bad(`变更后合同数量上限 ${lim.max} 小于下游已执行数量 ${done}(入库 ${ex.received} / 出库 ${ex.shipped} / 提单 ${ex.bl} / 点价 ${ex.fixed} / 报关 ${ex.declared}),不允许本次变更`);
        if (ex.matched > lim.max + 1e-6) throw bad(`变更后合同数量上限 ${lim.max} 小于已采销匹配数量 ${ex.matched}`);
      }
      // 授信额度
      const need = C.contractCreditNeed(rec);
      if (need && need.amount > 0) {
        const mine = sum(C.contractOccupied(rec.id, need.type), o => o.remain);
        const avail = C.availableCredit(rec.partner_id, need.type) + mine;
        if (avail + 0.005 < need.amount) throw bad(`${need.type}不足:本合同需占用 ${fmt(need.amount)} 元,可用 ${fmt(avail)} 元`);
      }
      // 库存授信(采购):在库 + 在途 + 本合同 ≤ 上限
      if (d.direction === "采购") {
        for (const it of d.items || []) {
          for (const cl of E.list("credit_line", "status = 'approved' AND json_extract(data, '$.credit_type') = '库存授信' AND json_extract(data, '$.product') = ?", it.product)) {
            if (cl.data.frozen) continue;
            const inStock = C.stockQty({ product: it.product }).qty;
            let transit = 0;
            for (const pc of E.list("contract", "status = 'approved' AND id != ? AND json_extract(data, '$.direction') = '采购' AND json_extract(data, '$.closed') IS NOT 1", rec.id)) {
              const q = sum((pc.data.items || []).filter(i => i.product === it.product), i => i.qty);
              if (q) transit += Math.max(0, q - C.stockQty({ contractId: pc.id, product: it.product, sign: "in" }).qty);
            }
            const total = inStock + transit + num(it.qty);
            if (num(cl.data.qty_cap) > 0 && total > num(cl.data.qty_cap) + 1e-6) {
              throw bad(`「${it.product}」超出库存授信:在库 ${round(inStock, 3)} + 在途 ${round(transit, 3)} + 本合同 ${it.qty} > 上限 ${cl.data.qty_cap}`);
            }
            const price = num(it.price) * C.rateOf(rec);
            if (num(cl.data.amount) > 0 && total * price > num(cl.data.amount) + 0.005) {
              throw bad(`「${it.product}」超出库存授信金额上限 ${fmt(cl.data.amount)} 元`);
            }
          }
        }
      }
    },
    onApproved(ctx, rec) {
      reoccupyContract(ctx, rec);
      if (rec.data.clause_changed) E.log(rec.id, ctx.user, "条款留痕", rec.data.clause_notes || "");
      rec = E.load(rec.id);
      rec.data.partner_confirm = "待确认";
      E.write(rec);
      E.notify({ partner_id: rec.partner_id, title: `${rec.data.kind}待确认:${rec.no}`, body: rec.data.product_summary, record_id: rec.id });
    },
    onCancel(ctx, rec) {
      const ex = C.executed(rec);
      if (ex.received || ex.shipped || ex.bl || ex.fixed || ex.matched || C.claimsFor(rec.id, "收款").length || C.claimsFor(rec.id, "付款").length) {
        throw bad("合同已有下游执行(收发货/点价/匹配/收付款),不能作废,请走变更或完结");
      }
      releaseAllForContract(ctx, rec, `合同 ${rec.no} 作废`);
    },
    actions: {
      confirm: {
        label: "确认合同", portal: true, primary: true, show: (r, u) => isPortal(u) && r.status === "approved" && r.data.partner_confirm === "待确认",
        run(ctx, r) {
          r.data.partner_confirm = `已确认 ${nowBJ().slice(0, 16)}`;
          E.write(r);
          E.notify({ role: "biz", title: `对方已确认合同:${r.no}`, record_id: r.id });
        },
      },
      dispute: {
        label: "提出异议", portal: true, danger: true, comment: "异议内容", commentRequired: true,
        show: (r, u) => isPortal(u) && r.status === "approved" && r.data.partner_confirm === "待确认",
        run(ctx, r, p) {
          if (!p.comment) throw bad("请填写异议内容");
          r.data.partner_confirm = `有异议:${String(p.comment).slice(0, 100)}`;
          E.write(r);
          E.notify({ role: "biz", title: `对方对合同有异议:${r.no}`, body: p.comment, record_id: r.id });
        },
      },
      close: {
        label: "合同完结", confirm: "完结后释放剩余占用额度,不再允许新的收发货。", show: (r, u) => internal(u) && r.status === "approved" && !r.data.closed,
        run(ctx, r) {
          r.data.closed = true;
          E.write(r);
          releaseAllForContract(ctx, r, `合同 ${r.no} 完结`);
        },
      },
      cross_border: {
        label: "生成跨境联动合同", show: (r, u) => internal(u) && r.status === "approved" && !r.data.linked_contract,
        inputs: [{ key: "org", label: "联动组织(对方签约主体)", type: "select", options: "@orgs", required: true }],
        run(ctx, r, p) {
          const orgs = getSettings(db).orgs;
          if (!orgs.includes(p.org) || p.org === r.data.org) throw bad("请选择与本合同不同的签约主体");
          const internalPartner = E.list("partner", "status = 'approved' AND json_extract(data, '$.internal_org') = ?", r.data.org)[0];
          if (!internalPartner) throw bad(`请先建立并准入代表「${r.data.org}」的内部组织客商(客商类型选「内部组织」)`);
          const d = structuredClone(r.data);
          Object.assign(d, {
            org: p.org, partner: internalPartner.id, partner_name: internalPartner.data.name, linked_contract: r.id, partner_confirm: null, closed: false,
            fixed_qty: 0, fixed_avg: 0, contract_no: "", remark: `跨境联动:由 ${r.no}(${r.data.org})生成`, payment_method: "款到发货", prepay_ratio: 0,
          });
          const n = E.insertRaw("contract", d, { user: ctx.user });
          E.log(n.id, ctx.user, "新建", `跨境联动自 ${r.no}`);
          r.data.linked_contract = n.id;
          E.write(r);
          return { message: `已生成联动合同 ${n.no}(草稿),请补充后提交审批` };
        },
      },
    },
  };

  H.pricing_fix = {
    beforeSave(ctx, d) {
      d.qty = round(num(d.lots) * num(d.lot_size), 6);
      if (d.qty <= 0) throw bad("点价数量必须大于 0");
    },
    validateActive(ctx, rec) {
      const c = E.load(rec.data.contract);
      if (c.data.pricing_method !== "点价") throw bad("该合同不是点价合同");
      const others = sum(C.docs("pricing_fix", c.id).filter(f => f.id !== rec.id), f => f.data.qty);
      const lim = C.contractLimits(c);
      if (others + rec.data.qty > lim.max + 1e-6) throw bad(`累计点价 ${round(others + rec.data.qty, 3)} 超过合同数量上限 ${lim.max}`);
    },
    onApproved(ctx, rec) {
      recalcFixes(ctx, rec.data.contract);
      if (rec.data.hedge) E.notify({ role: "manager", title: `套保申请:${rec.data.contract_title} 点价 ${rec.data.qty} @ ${rec.data.price}`, record_id: rec.id });
    },
    onCancel(ctx, rec) {
      rec.status = "cancelled";
      E.write(rec);
      recalcFixes(ctx, rec.data.contract);
    },
  };

  H.match = {
    validateActive(ctx, rec) {
      const d = rec.data;
      if (!d.active) return;
      for (const [key, lbl] of [["purchase", "采购"], ["sale", "销售"]]) {
        const c = E.load(d[key]);
        if (!(c.data.items || []).some(i => i.product === d.product)) throw bad(`${lbl}合同中没有品名「${d.product}」`);
        const lim = sum((c.data.items || []).filter(i => i.product === d.product), i => i.qty) * (1 + num(c.data.tolerance) / 100);
        const used = sum(E.list("match", `status != 'cancelled' AND id != ? AND json_extract(data, '$.active') = 1 AND json_extract(data, '$.${key}') = ? AND json_extract(data, '$.product') = ?`, rec.id, c.id, d.product), m => m.data.qty);
        if (used + num(d.qty) > lim + 1e-6) throw bad(`${lbl}合同「${d.product}」可匹配 ${round(lim - used, 3)},本次 ${d.qty} 超出`);
      }
    },
  };

  // =========================== 物流仓储 ===========================
  H.shipment = {
    validateActive(ctx, rec) {
      const c = E.load(rec.data.contract);
      if (!(c.data.items || []).some(i => i.product === rec.data.product)) throw bad(`合同中没有品名「${rec.data.product}」`);
      const others = sum(C.docs("shipment", c.id).filter(s => s.id !== rec.id), s => s.data.bl_qty);
      const lim = C.contractLimits(c);
      if (others + num(rec.data.bl_qty) > lim.max + 1e-6) throw bad(`累计提单数量 ${round(others + num(rec.data.bl_qty), 3)} 超过合同溢短装上限 ${lim.max}`);
    },
  };

  H.transport = {
    beforeSave(ctx, d, prev) {
      if (d.state === "已签收" && d.signed_qty === null) d.signed_qty = d.qty;
      if (!prev) d._new = true;
    },
    onApproved(ctx, rec) {
      if (rec.data._new) {
        delete rec.data._new;
        E.write(rec);
        E.notify({ partner_id: rec.data.carrier, title: `新运输委托:${rec.data.product} ${rec.data.qty}`, body: `${rec.data.from_addr} → ${rec.data.to_addr}`, record_id: rec.id });
      }
    },
  };

  function overfillCheck(c, product, addQty, sign, excludeId) {
    const lim = C.contractLimits(c);
    const done = sign === "in" ? C.stockQty({ contractId: c.id, sign: "in" }).qty : -C.stockQty({ contractId: c.id, sign: "out" }).qty;
    if (done + addQty > lim.max + 1e-6) throw bad(`超出合同溢短装上限:已${sign === "in" ? "入库" : "出库"} ${done},本次 ${addQty},上限 ${lim.max}`);
    void product, excludeId;
  }

  H.receipt_notice = {
    beforeSave(ctx, d, prev) {
      if (!prev) d.state = "待入库";
      if (prev && prev.data.state === "已入库") throw bad("已入库的收货通知不能修改,如需调整请作废后重开或做库存调整");
    },
    validateActive(ctx, rec) {
      const c = E.load(rec.data.contract);
      if (!(c.data.items || []).some(i => i.product === rec.data.product)) throw bad(`合同中没有物料「${rec.data.product}」`);
      if (rec.data.state === "待入库") overfillCheck(c, rec.data.product, num(rec.data.plan_qty), "in");
    },
    onApproved(ctx, rec, prevData) {
      if (!prevData) E.notify({ partner_id: rec.data.warehouse, title: `收货通知:${rec.data.product} ${rec.data.plan_qty}`, body: `计划 ${rec.data.plan_date || ""}`, record_id: rec.id });
    },
    onCancel(ctx, rec) {
      db.prepare("DELETE FROM stock_ledger WHERE record_id = ?").run(rec.id);
      C.undoLedger(rec.id);
    },
    actions: {
      confirm_in: {
        label: "确认入库", portal: true, primary: true,
        show: (r, u) => r.status === "approved" && r.data.state === "待入库" && (internal(u) || u.partner_id === r.data.warehouse),
        inputs: [{ key: "actual_qty", label: "实收数量", type: "qty", required: true }, { key: "in_date", label: "入库日期", type: "date", required: true }],
        run(ctx, r, p) {
          const qty = num(p.actual_qty);
          if (!(qty > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(p.in_date || "")) throw bad("请填写实收数量和入库日期");
          const c = E.load(r.data.contract);
          if (c.data.closed) throw bad("合同已完结");
          overfillCheck(c, r.data.product, qty, "in");
          const wh = E.load(r.data.warehouse);
          const cap = num(wh?.data.capacity);
          if (cap > 0) {
            const inWh = C.stockQty({ warehouseId: r.data.warehouse }).qty;
            if (inWh + qty > cap + 1e-6) throw bad(`超出仓库容量:现存 ${inWh},本次 ${qty},容量 ${cap}`);
          }
          const price = C.contractPrice(c, r.data.product) * C.rateOf(c);
          db.prepare("INSERT INTO stock_ledger (record_id, contract_id, product, warehouse_id, qty, amount, biz_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(r.id, c.id, r.data.product, r.data.warehouse, qty, round(qty * price, 2), p.in_date, nowBJ());
          r.data.actual_qty = qty;
          r.data.in_date = p.in_date;
          r.data.state = "已入库";
          E.write(r);
          // 入库释放预付额度:按入库货值 × 预付比例
          if (c.data.payment_method === "预付款") C.release(c.id, "预付额度", qty * price * num(c.data.prepay_ratio) / 100, { recordId: r.id, note: `入库 ${r.no}` });
          E.notify({ role: "biz", title: `已入库:${r.data.product} ${qty}(${r.data.warehouse_name})`, record_id: r.id });
          return { message: `已入库 ${qty}` };
        },
      },
    },
  };

  H.delivery_notice = {
    beforeSave(ctx, d, prev) {
      const c = contractOf(d);
      if (c) d.customer = c.data.partner;
      if (!prev) d.state = "待出库";
      if (prev && prev.data.state !== "待出库") throw bad("已出库的发货通知不能修改");
    },
    validateActive(ctx, rec) {
      const c = E.load(rec.data.contract);
      if (c.data.closed) throw bad("合同已完结");
      if (!(c.data.items || []).some(i => i.product === rec.data.product)) throw bad(`合同中没有物料「${rec.data.product}」`);
      if (rec.data.state !== "待出库") return;
      overfillCheck(c, rec.data.product, num(rec.data.plan_qty), "out");
      if (c.data.payment_method === "款到发货" || c.data.payment_method === "预付款") {
        // 客户资金池:已收款 - 已发货货值 - 其他待出库计划货值 ≥ 本次货值(预付款合同只校验预付部分)
        const price = C.contractPrice(c, rec.data.product) * C.rateOf(c);
        const received = sum(C.claimsFor(c.id, "收款"), x => x.amount);
        const shippedValue = sum(db.prepare("SELECT product, -qty AS q FROM stock_ledger WHERE contract_id = ? AND qty < 0").all(c.id), x => x.q * C.contractPrice(c, x.product) * C.rateOf(c));
        const pending = sum(C.docs("delivery_notice", c.id).filter(x => x.id !== rec.id && x.data.state === "待出库" && x.status === "approved"), x => num(x.data.plan_qty) * price);
        const ratio = c.data.payment_method === "预付款" ? num(c.data.prepay_ratio) / 100 : 1;
        const need = num(rec.data.plan_qty) * price * ratio;
        const avail = received - (shippedValue + pending) * ratio;
        if (avail + 0.005 < need) throw bad(`客户资金池余额不足:可放货 ${fmt(avail)} 元,本次需 ${fmt(need)} 元(已收 ${fmt(received)})`);
      }
    },
    onApproved(ctx, rec, prevData) {
      if (!prevData) E.notify({ partner_id: rec.data.warehouse, title: `发货通知:${rec.data.product} ${rec.data.plan_qty}`, body: `提货 ${rec.data.receiver || ""}`, record_id: rec.id });
    },
    onCancel(ctx, rec) {
      if (rec.data.state !== "待出库") throw bad("已出库的发货通知不能作废,请做库存调整");
    },
    actions: {
      confirm_out: {
        label: "确认出库", portal: true, primary: true,
        show: (r, u) => r.status === "approved" && r.data.state === "待出库" && (internal(u) || u.partner_id === r.data.warehouse),
        inputs: [{ key: "actual_qty", label: "实发数量", type: "qty", required: true }, { key: "out_date", label: "出库日期", type: "date", required: true }],
        run(ctx, r, p) {
          const qty = num(p.actual_qty);
          if (!(qty > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(p.out_date || "")) throw bad("请填写实发数量和出库日期");
          const c = E.load(r.data.contract);
          overfillCheck(c, r.data.product, qty, "out");
          const st = C.stockQty({ product: r.data.product, warehouseId: r.data.warehouse });
          if (st.qty + 1e-6 < qty) throw bad(`库存不足:${r.data.warehouse_name} 的 ${r.data.product} 现存 ${st.qty}`);
          const avg = st.qty ? st.amount / st.qty : 0;
          db.prepare("INSERT INTO stock_ledger (record_id, contract_id, product, warehouse_id, qty, amount, biz_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(r.id, c.id, r.data.product, r.data.warehouse, -qty, -round(qty * avg, 2), p.out_date, nowBJ());
          r.data.actual_qty = qty;
          r.data.out_date = p.out_date;
          r.data.state = "已出库";
          E.write(r);
          E.notify({ partner_id: r.data.customer, title: `货物已出库:${r.data.product} ${qty}`, body: `出库日期 ${p.out_date}`, record_id: r.id });
          return { message: `已出库 ${qty}` };
        },
      },
      sign: {
        label: "确认收货", portal: true, primary: true, show: (r, u) => isPortal(u) && u.partner_id === r.data.customer && r.data.state === "已出库",
        run(ctx, r) {
          r.data.state = "客户已签收";
          E.write(r);
          E.notify({ role: "biz", title: `客户已确认收货:${r.data.product} ${r.data.actual_qty}`, record_id: r.id });
        },
      },
    },
  };

  H.stocktake = {
    beforeSave(ctx, d) {
      for (const it of d.items || []) {
        it.book_qty = C.stockQty({ product: it.product, warehouseId: d.warehouse }).qty;
        it.diff = round(num(it.count_qty) - it.book_qty, 6);
      }
    },
    actions: {
      adjust: {
        label: "生成库存调整", show: (r, u) => internal(u) && r.status === "approved" && (r.data.items || []).some(i => Math.abs(num(i.diff)) > 1e-6) && !r.data.adjusted,
        run(ctx, r) {
          let n = 0;
          for (const it of r.data.items.filter(i => Math.abs(num(i.diff)) > 1e-6)) {
            E.insertRaw("stock_adjust", { warehouse: r.data.warehouse, product: it.product, qty: it.diff, reason: it.diff > 0 ? "盘盈" : "盘亏", date: r.data.date, remark: `盘点 ${r.no}` }, { user: ctx.user });
            n++;
          }
          r.data.adjusted = true;
          E.write(r);
          return { message: `已生成 ${n} 张库存调整单(草稿),请提交审批` };
        },
      },
    },
  };

  H.stock_adjust = {
    validateActive(ctx, rec) {
      if (num(rec.data.qty) < 0) {
        const st = C.stockQty({ product: rec.data.product, warehouseId: rec.data.warehouse });
        if (st.qty + num(rec.data.qty) < -1e-6) throw bad(`调减后库存为负:现存 ${st.qty}`);
      }
    },
    onApproved(ctx, rec) {
      db.prepare("DELETE FROM stock_ledger WHERE record_id = ?").run(rec.id);
      const st = C.stockQty({ product: rec.data.product, warehouseId: rec.data.warehouse });
      const amount = rec.data.amount !== null && rec.data.amount !== undefined ? num(rec.data.amount) : num(rec.data.qty) * (st.qty ? st.amount / st.qty : 0);
      db.prepare("INSERT INTO stock_ledger (record_id, contract_id, product, warehouse_id, qty, amount, biz_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(rec.id, rec.data.contract || null, rec.data.product, rec.data.warehouse, num(rec.data.qty), round(amount, 2), rec.data.date, nowBJ());
    },
    onCancel(ctx, rec) {
      db.prepare("DELETE FROM stock_ledger WHERE record_id = ?").run(rec.id);
    },
  };

  // =========================== 进出口 ===========================
  H.trade_docs = {
    onApproved(ctx, rec) {
      rec.data.missing = missingDocs(rec).join("、") || "齐全";
      E.write(rec);
    },
    onAttachment(ctx, rec) {
      H.trade_docs.onApproved(ctx, rec);
    },
  };

  H.customs = {
    beforeSave(ctx, d) {
      const rate = num(d.exchange_rate) || 1;
      const items = d.items || [];
      const totalValue = sum(items, i => i.value);
      const extra = num(d.freight) + num(d.insurance);
      for (const it of items) {
        const share = totalValue ? num(it.value) / totalValue : 0;
        it.value_cny = round((num(it.value) + extra * share) * rate, 2);
        it.duty = round(it.value_cny * num(it.duty_rate) / 100, 2);
        it.vat = d.direction === "进口" ? round((it.value_cny + it.duty) * num(it.vat_rate) / 100, 2) : 0;
      }
      d.total_value = sum(items, i => i.value_cny);
      d.total_duty = sum(items, i => i.duty);
      d.total_vat = sum(items, i => i.vat);
    },
    validateActive(ctx, rec) {
      const c = E.load(rec.data.contract);
      const lim = C.contractLimits(c);
      const others = sum(C.docs("customs", c.id).filter(x => x.id !== rec.id && x.data.decl_type === rec.data.decl_type), x => sum(x.data.items || [], i => i.qty));
      const mine = sum(rec.data.items || [], i => i.qty);
      if (others + mine > lim.max + 1e-6) throw bad(`累计${rec.data.decl_type}数量 ${round(others + mine, 3)} 超过合同数量上限 ${lim.max}`);
    },
    actions: {
      zero_invoice: {
        label: "开具0税率发票", show: (r, u) => internal(u) && r.status === "approved" && r.data.direction === "出口" && !r.data.zero_invoice,
        confirm: "按报关单商品生成出口 0 税率普通发票登记(实际开票在金蝶/税控系统完成)。",
        run(ctx, r) {
          const c = E.load(r.data.contract);
          const inv = E.insertRaw("invoice", {
            direction: "销项", contract: c.id, partner: c.data.partner, partner_name: c.data.partner_name, invoice_no: `待开-${r.no}`, invoice_kind: "出口0税率普票",
            invoice_date: todayBJ(), state: "已登记", items: (r.data.items || []).map(i => ({ product: i.product, qty: i.qty, unit: i.unit, amount: i.value_cny, tax_rate: 0, tax: 0 })),
          }, { user: ctx.user, status: "approved" });
          H.invoice.beforeSave(ctx, inv.data);
          E.write(inv);
          r.data.zero_invoice = inv.id;
          E.write(r);
          return { message: `已生成发票登记 ${inv.no},开票后请回填发票号码` };
        },
      },
      invoice_notice: {
        label: "通知供应商开票", show: (r, u) => internal(u) && r.status === "approved" && r.data.direction === "出口",
        run(ctx, r) {
          const sale = E.load(r.data.contract);
          const purchases = E.list("match", "status != 'cancelled' AND json_extract(data, '$.active') = 1 AND json_extract(data, '$.sale') = ?", sale.id).map(m => E.load(m.data.purchase));
          if (sale.data.direction === "采购") purchases.push(sale);
          if (!purchases.length) throw bad("没有找到对应的采购合同(请先做采销匹配)");
          const lines = (r.data.items || []).map(i => `${i.product} ${i.qty}${i.unit || ""}`).join(";");
          const seen = new Set();
          for (const pc of purchases) {
            if (seen.has(pc.partner_id)) continue;
            seen.add(pc.partner_id);
            E.notify({ partner_id: pc.partner_id, title: `开票通知:报关单 ${r.data.decl_no || r.no}`, body: `请按报关品名、数量开具增值税专用发票:${lines};发票品名、数量须与报关单一致`, record_id: pc.id });
          }
          return { message: `已通知 ${seen.size} 家供应商开票` };
        },
      },
    },
  };

  H.tax_payment = {
    beforeSave(ctx, d, prev) {
      const cs = E.load(d.customs);
      d.contract = cs.data.contract;
      if (d.duty === null) d.duty = cs.data.total_duty;
      if (d.vat === null) d.vat = cs.data.total_vat;
      d.total = round(num(d.duty) + num(d.vat) + num(d.other_tax), 2);
      if (!d.guarantee) d.guarantee_amount = 0;
      if (num(d.guarantee_amount) > d.total) throw bad("保函抵扣金额不能超过应缴合计");
      if (d.guarantee) {
        const g = E.load(d.guarantee);
        const usedOthers = sum(E.list("tax_payment", "status = 'approved' AND id != ? AND json_extract(data, '$.guarantee') = ?", prev?.id || 0, g.id), t => t.data.guarantee_amount);
        if (usedOthers + num(d.guarantee_amount) > num(g.data.amount) + 0.005) throw bad(`保函余额不足:剩余 ${fmt(num(g.data.amount) - usedOthers)} 元`);
      }
      d.cash_amount = round(d.total - num(d.guarantee_amount), 2);
    },
    onApproved(ctx, rec) {
      if (rec.data.guarantee) refreshGuarantee(rec.data.guarantee);
      const cs = E.load(rec.data.customs);
      if (cs.data.state !== "已放行") {
        cs.data.state = "已申报";
        E.write(cs);
      }
    },
    onCancel(ctx, rec) {
      rec.status = "cancelled";
      E.write(rec);
      if (rec.data.guarantee) refreshGuarantee(rec.data.guarantee);
    },
  };

  H.tax_refund = {
    beforeSave(ctx, d) {
      const cs = E.load(d.customs);
      d.contract = cs.data.contract;
      for (const m of d.matches || []) m.refund = round(num(m.amount) * num(m.refund_rate) / 100, 2);
      d.refund_due = sum(d.matches || [], m => m.refund);
      d.refund_diff = d.refund_actual !== null && d.refund_actual !== undefined ? round(num(d.refund_actual) - d.refund_due, 2) : null;
    },
    validateActive(ctx, rec) {
      const d = rec.data;
      if (!(d.matches || []).length) throw bad("请先「自动匹配」进项发票");
      const cs = E.load(d.customs);
      for (const it of cs.data.items || []) {
        const m = sum(d.matches.filter(x => x.product === it.product), x => x.qty);
        if (m > num(it.qty) + 1e-6) throw bad(`「${it.product}」匹配数量 ${m} 超过报关数量 ${it.qty}`);
      }
      for (const m of d.matches) {
        if (!m.invoice) continue;
        const inv = E.load(m.invoice), ln = inv?.data.items?.[num(m.invoice_line) - 1];
        if (!ln) continue;
        const used = matchedQty(m.invoice, m.invoice_line, rec.id);
        if (used + num(m.qty) > num(ln.qty) + 1e-6) throw bad(`发票 ${m.invoice_no} 第 ${m.invoice_line} 行已被匹配 ${used},可用 ${round(num(ln.qty) - used, 3)}`);
      }
    },
    onApproved(ctx, rec) {
      if (rec.data.state === "已匹配" || rec.data.state === "待匹配") {
        rec.data.state = "已申报";
        if (!rec.data.declare_date) rec.data.declare_date = todayBJ();
        E.write(rec);
      }
    },
    actions: {
      automatch: {
        label: "自动匹配进项发票", show: (r, u) => internal(u) && ["draft", "rejected"].includes(r.status),
        run(ctx, r) {
          const cs = E.load(r.data.customs);
          const invs = E.list("invoice", "status = 'approved' AND json_extract(data, '$.direction') = '进项'");
          const matches = [];
          for (const it of cs.data.items || []) {
            let need = num(it.qty);
            for (const inv of invs) {
              (inv.data.items || []).forEach((ln, idx) => {
                if (need <= 1e-6 || ln.product !== it.product) return;
                const free = num(ln.qty) - matchedQty(inv.id, idx + 1, r.id);
                if (free <= 1e-6) return;
                const q = Math.min(free, need);
                matches.push({ product: it.product, decl_qty: it.qty, invoice: inv.id, invoice_no: inv.data.invoice_no, invoice_line: idx + 1, qty: round(q, 6),
                  amount: round(num(ln.amount) * q / num(ln.qty), 2), refund_rate: num(it.refund_rate), refund: 0 });
                need -= q;
              });
            }
          }
          r.data.matches = matches;
          r.data.state = matches.length ? "已匹配" : "待匹配";
          H.tax_refund.beforeSave(ctx, r.data);
          E.write(r);
          const short = (cs.data.items || []).filter(it => sum(matches.filter(m => m.product === it.product), m => m.qty) + 1e-6 < num(it.qty)).map(i => i.product);
          return { message: `匹配 ${matches.length} 行,应退税 ${fmt(r.data.refund_due)} 元${short.length ? `;以下品名进项发票不足:${short.join("、")}` : ""}` };
        },
      },
      refunded: {
        label: "登记退税到账", show: (r, u) => internal(u) && r.status === "approved" && r.data.state === "已申报",
        inputs: [{ key: "refund_actual", label: "实际退税额", type: "money", required: true }, { key: "refund_date", label: "到账日期", type: "date", required: true }],
        run(ctx, r, p) {
          r.data.refund_actual = num(p.refund_actual);
          r.data.refund_date = p.refund_date;
          r.data.state = "已退税";
          H.tax_refund.beforeSave(ctx, r.data);
          E.write(r);
          return { message: `差额 ${fmt(r.data.refund_diff)} 元` };
        },
      },
    },
  };
  function matchedQty(invoiceId, line, excludeId) {
    return sum(E.list("tax_refund", "status != 'cancelled' AND id != ?", excludeId || 0).flatMap(t => t.data.matches || []).filter(m => m.invoice === invoiceId && num(m.invoice_line) === num(line)), m => m.qty);
  }

  H.expense = {
    beforeSave(ctx, d) {
      for (const a of d.allocs || []) if ((a.amount === null || a.amount === undefined) && a.ratio) a.amount = round(num(d.amount) * num(a.ratio) / 100, 2);
    },
    validateActive(ctx, rec) {
      const a = rec.data.allocs || [];
      if (a.length && Math.abs(sum(a, x => x.amount) - num(rec.data.amount)) > 0.01) throw bad(`分摊合计 ${fmt(sum(a, x => x.amount))} 与费用金额 ${fmt(rec.data.amount)} 不一致`);
    },
  };

  H.fx_lock = {
    beforeSave(ctx, d, prev) {
      d.used = prev ? sum(E.list("payment", "status = 'approved' AND json_extract(data, '$.fx_lock') = ?", prev.id), p => p.data.amount) : 0;
    },
  };

  // =========================== 资金结算 ===========================
  H.invoice = {
    beforeSave(ctx, d, prev) {
      if (isPortal(ctx.user)) {
        if (!prev) d.direction = "进项";
        portalOwnContract(ctx, d.contract);
      }
      for (const it of d.items || []) it.tax = round(num(it.amount) * num(it.tax_rate) / 100, 2);
      d.amount = sum(d.items || [], i => i.amount);
      d.tax = sum(d.items || [], i => i.tax);
      d.total = round(d.amount + d.tax, 2);
      const dup = E.list("invoice", "status != 'cancelled' AND id != ? AND json_extract(data, '$.invoice_no') = ? AND json_extract(data, '$.direction') = ?", prev?.id || 0, d.invoice_no, d.direction)[0];
      if (dup && !String(d.invoice_no).startsWith("待开")) throw bad(`发票号码 ${d.invoice_no} 已登记(${dup.no})`);
    },
    onApproved(ctx, rec, prevData) {
      if (!prevData && isPortal(ctx.user)) E.notify({ role: "finance", title: `供应商上传发票:${rec.data.partner_name} ${rec.data.invoice_no}`, record_id: rec.id });
      if (!prevData && rec.data.direction === "销项" && rec.partner_id) E.notify({ partner_id: rec.partner_id, title: `已开票:${rec.data.invoice_no} 价税合计 ${fmt(rec.data.total)} 元`, record_id: rec.id });
    },
    actions: {
      received: {
        label: "确认收票", portal: true, show: (r, u) => isPortal(u) && r.data.direction === "销项" && r.data.state !== "客户已收票" && r.partner_id === u.partner_id,
        run(ctx, r) {
          r.data.state = "客户已收票";
          E.write(r);
        },
      },
    },
  };

  H.payment = {
    beforeSave(ctx, d, prev) {
      if (isPortal(ctx.user)) {
        const ptypes = ctx.user.ptypes || [];
        if (d.kind === "收款" && !ptypes.includes("客户")) throw bad("只有客户可以上传付款回单");
        if (d.kind === "付款" && !ptypes.some(t => t.startsWith("供应商"))) throw bad("只有供应商可以请款");
        if (d.kind === "换汇") throw bad("门户不能登记换汇");
        if (!prev) d.source = d.kind === "收款" ? "客户付款回单" : "供应商请款";
        for (const cl of d.claims || []) portalOwnContract(ctx, cl.contract);
      }
      if (d.currency === "CNY") d.rate = 1;
      if (d.fx_lock) {
        const l = E.load(d.fx_lock);
        if (l.data.currency !== d.currency) throw bad(`锁汇单币种为 ${l.data.currency},与付款币种不一致`);
        const others = sum(E.list("payment", "status = 'approved' AND id != ? AND json_extract(data, '$.fx_lock') = ?", prev?.id || 0, l.id), p => p.data.amount);
        if (others + num(d.amount) > num(l.data.fx_amount) + 0.005) throw bad(`锁汇额度不足:剩余 ${fmt(num(l.data.fx_amount) - others)} ${l.data.currency}`);
        d.rate = num(l.data.rate);
      }
      d.amount_cny = round(num(d.amount) * (num(d.rate) || 1), 2);
      d.claimed = sum(d.claims || [], c => c.amount);
      if (d.claimed > d.amount_cny + 0.01) throw bad(`认领合计 ${fmt(d.claimed)} 超过收付款金额 ${fmt(d.amount_cny)}`);
    },
    steps(ctx, rec) {
      if (rec.data.kind === "付款") return ["finance", "manager"];
      if (rec.data.kind === "换汇") return ["finance"];
      return rec.data.source === "客户付款回单" ? ["finance"] : [];
    },
    validateActive(ctx, rec) {
      for (const cl of rec.data.claims || []) {
        const c = E.load(cl.contract);
        if (c.status !== "approved") throw bad(`认领的合同 ${c.no} 尚未生效`);
        if (rec.data.kind === "付款" && c.data.direction === "采购" && num(c.data.tolerance) >= 0) {
          const paid = sum(C.claimsFor(c.id, "付款").filter(x => x.payment.id !== rec.id), x => x.amount);
          const cap = num(c.data.amount_cny) * (1 + num(c.data.tolerance) / 100);
          if (paid + num(cl.amount) > cap + 0.01) throw bad(`合同 ${c.no} 累计付款 ${fmt(paid + num(cl.amount))} 超过合同金额溢短装上限 ${fmt(cap)}`);
        }
      }
    },
    onApproved(ctx, rec) {
      paymentRelease(ctx, rec);
      if (rec.data.fx_lock) refreshFxLock(rec.data.fx_lock);
      if (rec.data.kind === "付款" && rec.partner_id) E.notify({ partner_id: rec.partner_id, title: `付款已审批:${fmt(rec.data.amount)} ${rec.data.currency}`, body: `预计付款日 ${rec.data.pay_date}`, record_id: rec.id });
      if (rec.data.kind === "收款" && rec.data.claimed + 0.01 < rec.data.amount_cny) E.notify({ role: "biz", title: `收款待认领:${rec.data.partner_name || ""} ${fmt(rec.data.amount_cny)} 元`, record_id: rec.id });
    },
    onCancel(ctx, rec) {
      rec.status = "cancelled";
      E.write(rec);
      C.undoLedger(rec.id);
      if (rec.data.fx_lock) refreshFxLock(rec.data.fx_lock);
    },
    actions: {
      claim: {
        label: "认领款项", primary: true, show: (r, u) => internal(u) && r.status === "approved" && r.data.kind !== "换汇" && num(r.data.claimed) + 0.01 < num(r.data.amount_cny),
        inputs: [{ key: "contract", label: "合同", type: "ref", ref: "contract", required: true }, { key: "invoice", label: "发票(选填)", type: "ref", ref: "invoice" },
          { key: "claim_type", label: "款项性质", type: "select", options: ["预收/预付", "应收/应付", "保证金", "费用"], required: true }, { key: "amount", label: "认领金额(人民币)", type: "money", required: true }],
        run(ctx, r, p) {
          const c = E.load(p.contract);
          if (!c || c.type !== "contract" || c.status !== "approved") throw bad("请选择已生效的合同");
          const amt = num(p.amount);
          if (!(amt > 0)) throw bad("请填写认领金额");
          if (num(r.data.claimed) + amt > num(r.data.amount_cny) + 0.01) throw bad(`可认领余额 ${fmt(num(r.data.amount_cny) - num(r.data.claimed))} 元`);
          r.data.claims = [...(r.data.claims || []), { contract: c.id, invoice: Number(p.invoice) || null, claim_type: p.claim_type, amount: amt }];
          r.data.claimed = sum(r.data.claims, x => x.amount);
          if (!r.data.partner) {
            r.data.partner = c.data.partner;
            r.data.partner_name = c.data.partner_name;
          }
          const saved = E.write(r);
          H.payment.validateActive(ctx, saved);
          paymentRelease(ctx, saved);
          return { message: `已认领 ${fmt(amt)} 元到 ${c.no}` };
        },
      },
    },
  };

  H.quality = {
    beforeSave(ctx, d) {
      d.penalty_total = sum(d.items || [], i => i.penalty);
    },
    actions: {
      share: {
        label: "发送给对方", show: (r, u) => internal(u) && r.status === "approved" && !r.data.shared,
        run(ctx, r) {
          r.data.shared = true;
          E.write(r);
          const c = E.load(r.data.contract);
          E.notify({ partner_id: c.partner_id, title: `品质检验结果:${r.data.stage}`, body: `扣罚合计 ${fmt(r.data.penalty_total)} 元`, record_id: c.id });
        },
      },
    },
  };

  function settlementData(ctx, c, d) {
    const ex = C.executed(c);
    const isSale = c.data.direction === "销售";
    d.qty = round(isSale ? ex.shipped : ex.received, 6) || ex.arrived || ex.bl || num(c.data.total_qty);
    const qAdj = sum(C.docs("quality", c.id), q => q.data.price_adjust);
    // 点价合同的明细单价已由点价反写为「点价均价 + 升贴水」,这里统一取合同加权单价
    d.price = round((C.contractPrice(c) + qAdj) * C.rateOf(c), 4);
    d.quality_penalty = sum(C.docs("quality", c.id), q => q.data.penalty_total);
    d.fees = sum(E.list("expense", "status = 'approved'").flatMap(e => e.data.allocs || []).filter(a => a.contract === c.id), a => a.amount);
    const flows = C.fundFlows();
    d.interest = C.fundUnit(c.id) === c.id ? C.interestOf(c.id, flows).interest : 0;
    d.paid = sum(C.claimsFor(c.id, isSale ? "收款" : "付款").filter(x => x.claim.claim_type !== "保证金" && x.claim.claim_type !== "费用"), x => x.amount);
    d.weight_diff = `提单 ${ex.bl} / 到港 ${ex.arrived} / 入库 ${ex.received} / 出库 ${ex.shipped}`;
  }

  H.settlement = {
    beforeSave(ctx, d) {
      const c = contractOf(d);
      d.goods_amount = round(num(d.qty) * num(d.price), 2);
      d.invoiced = c ? sum(C.docs("invoice", c.id), i => i.data.total) : 0;
      const extra = d.charge_fees && c?.data.direction === "销售" ? num(d.fees) + num(d.interest) : 0;
      d.balance = round(d.goods_amount - num(d.quality_penalty) + extra - num(d.paid), 2);
    },
    validateActive(ctx, rec) {
      if (!(num(rec.data.qty) > 0) || !(num(rec.data.price) > 0)) throw bad("请先「带出结算数据」或填写结算数量、单价");
    },
    onApproved(ctx, rec) {
      const c = E.load(rec.data.contract);
      if (rec.data.kind === "最终结算" && !c.data.closed) {
        c.data.closed = true;
        E.write(c);
        releaseAllForContract(ctx, c, `合同 ${c.no} 最终结算`);
        E.log(c.id, ctx.user, "最终结算完结", rec.no);
      }
      E.notify({ partner_id: c.partner_id, title: `${rec.data.kind}单:${c.no} 余额 ${fmt(rec.data.balance)} 元`, record_id: rec.id });
    },
    actions: {
      fill: {
        label: "带出结算数据", primary: true, show: (r, u) => internal(u) && ["draft", "rejected"].includes(r.status),
        run(ctx, r) {
          settlementData(ctx, E.load(r.data.contract), r.data);
          H.settlement.beforeSave(ctx, r.data);
          E.write(r);
          return { message: `余额 ${fmt(r.data.balance)} 元` };
        },
      },
    },
  };

  H.feedback = {
    beforeSave(ctx, d) {
      portalOwnContract(ctx, d.contract);
    },
    onApproved(ctx, rec, prevData) {
      if (!prevData) E.notify({ role: "biz", title: `新售后反馈:${rec.data.subject}`, record_id: rec.id });
      else if (prevData.reply !== rec.data.reply && rec.data.reply) E.notify({ partner_id: rec.partner_id, title: `售后反馈已回复:${rec.data.subject}`, record_id: rec.id });
    },
  };

  H.supply_offer = {};

  return { hooks: H, applyBlacklist, marginCall, latestPrice, missingDocs };
}

// 下推:从来源单据生成目标单据的初始数据
export function pushdown(E, C, fromRec, to, user) {
  const d = fromRec.data, c = fromRec;
  const err = m => {
    throw new HttpError(400, m);
  };
  if (fromRec.status !== "approved") err("来源单据尚未生效");
  const items = (d.items || []).map(i => ({ product: i.product, spec: i.spec, unit: i.unit, qty: i.qty, price: i.price }));
  const map = {
    framework: { contract: () => ({ direction: d.direction, kind: "订单", framework: c.id, partner: d.partner, project: d.project, daily_rate: d.daily_rate, account_days: d.account_days }) },
    rfq: {
      contract: () => {
        const q = (d.quotes || []).filter(x => x.supplier === d.winner);
        return { direction: "采购", partner: d.winner, items: q.map(x => ({ product: x.product, qty: x.qty, price: x.price, unit: "吨" })), remark: `来自询价 ${c.no}` };
      },
    },
    pricing: {
      contract: () => {
        if (d.customer_reply !== "已确认") err("客户尚未确认价格");
        return { direction: "销售", partner: d.partner, items: [{ product: d.product, qty: d.qty, unit: d.unit, price: d.price }], remark: `来自定价 ${c.no}` };
      },
    },
    contract: {
      shipment: () => ({ contract: c.id, direction: d.trade_type === "出口" ? "出口" : "进口", product: items[0]?.product }),
      transport: () => ({ contract: c.id, product: items[0]?.product, qty: items[0]?.qty }),
      receipt_notice: () => (d.direction === "采购" ? { contract: c.id, product: items[0]?.product, plan_qty: items[0]?.qty } : err("收货通知只能由采购合同下推")),
      delivery_notice: () => (d.direction === "销售" ? { contract: c.id, product: items[0]?.product, plan_qty: items[0]?.qty } : err("发货通知只能由销售合同下推")),
      invoice: () => ({ direction: d.direction === "采购" ? "进项" : "销项", contract: c.id, partner: d.partner, items: items.map(i => ({ product: i.product, qty: i.qty, unit: i.unit, amount: round(num(i.qty) * num(i.price) * C.rateOf(c) / 1.13, 2), tax_rate: 13 })) }),
      customs: () => ({ contract: c.id, direction: d.trade_type === "出口" ? "出口" : "进口", currency: d.currency, exchange_rate: d.exchange_rate, items: items.map(i => ({ product: i.product, qty: i.qty, unit: i.unit, value: round(num(i.qty) * num(i.price), 2), vat_rate: 13 })) }),
      trade_docs: () => ({ contract: c.id, direction: d.trade_type === "出口" ? "出口" : "进口" }),
      expense: () => ({ allocs: [{ contract: c.id, ratio: 100 }] }),
      quality: () => ({ contract: c.id }),
      settlement: () => ({ contract: c.id, kind: "临时结算" }),
      margin: () => ({ contract: c.id, direction: d.direction === "销售" ? "向客户收取" : "向供应商收取" }),
      pricing_fix: () => ({ contract: c.id }),
      payment: () => ({ kind: d.direction === "销售" ? "收款" : "付款", partner: d.partner, currency: d.currency, claims: [{ contract: c.id, claim_type: "应收/应付" }] }),
      match: () => (d.direction === "采购" ? { purchase: c.id, product: items[0]?.product } : { sale: c.id, product: items[0]?.product }),
    },
    customs: { tax_payment: () => ({ customs: c.id }), tax_refund: () => ({ customs: c.id }) },
    invoice: { payment: () => ({ kind: d.direction === "进项" ? "付款" : "收款", partner: d.partner, amount: d.total, claims: d.contract ? [{ contract: d.contract, invoice: c.id, claim_type: "应收/应付", amount: d.total }] : [] }) },
    stocktake: {},
  };
  const fn = map[fromRec.type]?.[to];
  if (!fn) err("不支持该下推");
  void user;
  return fn();
}

export const PUSHDOWN_TARGETS = {
  framework: ["contract"], rfq: ["contract"], pricing: ["contract"],
  contract: ["pricing_fix", "match", "margin", "shipment", "transport", "receipt_notice", "delivery_notice", "trade_docs", "customs", "expense", "invoice", "payment", "quality", "settlement"],
  customs: ["tax_payment", "tax_refund"], invoice: ["payment"],
};
