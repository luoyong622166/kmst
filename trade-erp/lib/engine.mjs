// 通用单据引擎:权限、字段清洗与校验、保存留痕、审批流(提交/审批/驳回/撤回/变更/作废)、版本快照、通知。
// 各单据的业务规则写在 hooks.mjs,引擎在固定时机调用:
//   beforeSave(ctx, data, prev)       计算只读字段、保存前校验
//   validateActive(ctx, rec)          生效前校验(无审批单据每次保存时,有审批单据提交时)
//   steps(ctx, rec)                   动态审批步骤
//   onApproved(ctx, rec, prevData)    生效后(无审批单据每次保存后也调用)
//   onCancel(ctx, rec)                作废时回滚台账
//   actions                           单据上的自定义按钮
import { ENTITIES, STATUS, PORTAL_ACCESS } from "./meta.mjs";
import { HttpError, bad, nowBJ } from "./util.mjs";
import { nextNo, getSettings } from "./db.mjs";

const NUMERIC = new Set(["number", "money", "qty", "percent", "rate"]);
const PARTNER_FREE = new Set(["partner", "partner_change", "partner_rating", "credit_line", "risk_event", "blacklist"]);

export const hasRole = (user, role) => user.roles.includes("admin") || user.roles.includes(role);
export const isPortal = user => user.roles.includes("portal");

export function createEngine(db, hooksRef) {
  const H = type => hooksRef.current[type] || {};

  const parse = row => row && { ...row, data: JSON.parse(row.data), steps: JSON.parse(row.steps) };
  const load = id => parse(db.prepare("SELECT * FROM records WHERE id = ?").get(Number(id) || 0));
  const must = (id, type) => {
    const r = load(id);
    if (!r || (type && r.type !== type)) throw new HttpError(404, "单据不存在");
    return r;
  };
  const list = (type, where = "", ...args) =>
    db.prepare(`SELECT * FROM records WHERE type = ? ${where ? "AND " + where : ""} ORDER BY id`).all(type, ...args).map(parse);
  const label = r => (r ? `${r.no} ${r.title}`.trim() : "");

  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  function log(recId, user, action, comment = "", diff = null) {
    db.prepare("INSERT INTO record_logs (record_id, user_id, user_name, action, comment, diff, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(recId, user?.id ?? null, user?.name ?? "系统", action, comment, diff ? JSON.stringify(diff) : null, nowBJ());
  }

  function notify({ partner_id = null, role = null, title, body = "", record_id = null }) {
    db.prepare("INSERT INTO notifications (partner_id, role, title, body, record_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(partner_id, role, title, body, record_id, nowBJ());
  }

  // ---------- 选项解析 ----------
  function options(field) {
    if (typeof field.options === "string" && field.options.startsWith("@")) return getSettings(db)[field.options.slice(1)] || [];
    return field.options || [];
  }

  // ---------- 门户可见范围 ----------
  function portalTypes(user) {
    const types = new Set(["partner"]); // 本企业资料始终可见(准入前也要能补资料)
    for (const t of user.ptypes || []) for (const e of PORTAL_ACCESS[t] || []) types.add(e);
    return types;
  }
  function portalCanSee(user, rec) {
    const p = ENTITIES[rec.type]?.portal;
    if (!p || !portalTypes(user).has(rec.type)) return false;
    if (p.approvedOnly && rec.status !== "approved") return false;
    const pid = user.partner_id;
    return [].concat(p.scope).some(scope => {
      switch (scope) {
        case "self": return rec.id === pid;
        case "partner_id": return rec.partner_id === pid;
        case "carrier": return rec.data.carrier === pid;
        case "warehouse": return rec.data.warehouse === pid;
        case "invited": {
          if (rec.status === "cancelled") return false;
          if ((rec.data.invited || []).includes(pid)) return true;
          const cat = { 货物: "供应商-货物", 物流: "供应商-物流", 仓储: "供应商-仓储", 报关: "供应商-报关", 其他: "供应商-其他" }[rec.data.category];
          return !!rec.data.public && (user.ptypes || []).includes(cat);
        }
        default: return false;
      }
    });
  }
  function canSee(user, rec) {
    return isPortal(user) ? portalCanSee(user, rec) : true;
  }

  function editable(user, rec) {
    const meta = ENTITIES[rec.type];
    if (rec.status === "cancelled" || rec.status === "pending") return false;
    if (meta.approval && rec.status === "approved") return false;
    if (isPortal(user)) {
      if (!portalCanSee(user, rec)) return false;
      // 门户只能改自己建的单据,或明确允许门户维护的单据(企业资料、运输反馈、货盘);入出库确认走按钮
      return meta.portal?.edit === true || rec.created_by === user.id;
    }
    if (meta.systemOnly) return hasRole(user, "risk");
    return true;
  }

  // ---------- 字段清洗 ----------
  function cleanValue(fd, v, prevV, user) {
    if (fd.ro) return prevV ?? fd.default ?? null;
    if (isPortal(user) && !fd.portal) return prevV ?? fd.default ?? null;
    if (v === undefined) return prevV ?? fd.default ?? null;
    if (v === null || v === "") return fd.type === "multi" || fd.type === "refs" ? [] : fd.type === "bool" ? false : null;
    switch (fd.type) {
      case "bool": return v === true || v === "true" || v === 1;
      case "date":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw bad(`「${fd.label}」日期格式不正确`);
        return String(v);
      case "select": {
        const opts = options(fd);
        if (!opts.includes(String(v))) throw bad(`「${fd.label}」选项不正确`);
        return String(v);
      }
      case "multi": {
        const opts = options(fd);
        return [...new Set((Array.isArray(v) ? v : [v]).map(String).filter(x => opts.includes(x)))];
      }
      case "ref": {
        const id = Number(v);
        if (!Number.isInteger(id) || id <= 0) throw bad(`「${fd.label}」选择不正确`);
        return id;
      }
      case "refs": return [...new Set((Array.isArray(v) ? v : [v]).map(Number).filter(n => Number.isInteger(n) && n > 0))];
      case "changes": return v && typeof v === "object" && !Array.isArray(v) ? v : {};
      case "textarea": return String(v).slice(0, 20000);
      default:
        if (NUMERIC.has(fd.type)) {
          const n = Number(v);
          if (!Number.isFinite(n)) throw bad(`「${fd.label}」需填写数字`);
          return n;
        }
        return String(v).trim().slice(0, 500);
    }
  }

  function clean(meta, input, prevData, user) {
    const out = { ...(prevData || {}) };
    for (const fd of meta.fields) out[fd.key] = cleanValue(fd, input?.[fd.key], prevData?.[fd.key], user);
    for (const ln of meta.lines || []) {
      const prevRows = prevData?.[ln.key] || [];
      const lineLocked = ln.ro || (isPortal(user) && !ln.portal);
      if (lineLocked || !Array.isArray(input?.[ln.key])) {
        out[ln.key] = prevRows;
        continue;
      }
      out[ln.key] = input[ln.key].slice(0, 500).map((row, i) => {
        const r = {};
        for (const fd of ln.fields) {
          // 明细里的只读字段由 hooks 计算;门户可编辑的明细不再逐字段限制
          const sub = isPortal(user) ? { ...fd, portal: true } : fd;
          r[fd.key] = fd.ro ? prevRows[i]?.[fd.key] ?? null : cleanValue(sub, row?.[fd.key], undefined, user);
        }
        return r;
      }).filter(r => ln.fields.some(fd => !fd.ro && r[fd.key] !== null && r[fd.key] !== "" && !(Array.isArray(r[fd.key]) && !r[fd.key].length)));
    }
    return out;
  }

  // 引用校验 + 自动带出名称(xxx_name / xxx_title)
  function resolveRefs(meta, data) {
    const check = (fd, id) => {
      const r = load(id);
      if (!r || r.type !== fd.ref || r.status === "cancelled") throw bad(`「${fd.label}」引用的单据不存在或已作废`);
      if (fd.filter) {
        for (const [k, v] of Object.entries(fd.filter)) {
          const val = r.data[k];
          const ok = Array.isArray(v) ? (Array.isArray(val) ? val.some(x => v.includes(x)) : v.includes(val)) : val === v;
          if (!ok) throw bad(`「${fd.label}」选择的「${label(r)}」不符合要求`);
        }
      }
      return r;
    };
    for (const fd of meta.fields) {
      if (fd.type === "ref" && data[fd.key]) {
        const r = check(fd, data[fd.key]);
        if (`${fd.key}_name` in data || meta.fields.some(x => x.key === `${fd.key}_name`)) data[`${fd.key}_name`] = r.type === "partner" ? r.data.name : label(r);
        if (meta.fields.some(x => x.key === `${fd.key}_title`)) data[`${fd.key}_title`] = label(r);
      }
      if (fd.type === "refs") for (const id of data[fd.key] || []) check(fd, id);
    }
    for (const ln of meta.lines || []) for (const row of data[ln.key] || []) for (const fd of ln.fields) if (fd.type === "ref" && row[fd.key]) check(fd, row[fd.key]);
  }

  const empty = v => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

  // 生效前的通用校验:必填、引用单据已生效、客商准入与黑名单、必传附件
  function validateActive(rec, { attachments = true } = {}) {
    const meta = ENTITIES[rec.type];
    for (const fd of meta.fields) if (fd.req && !fd.ro && empty(rec.data[fd.key])) throw bad(`请填写「${fd.label}」`);
    for (const ln of meta.lines || []) {
      (rec.data[ln.key] || []).forEach((row, i) => {
        for (const fd of ln.fields) if (fd.req && !fd.ro && empty(row[fd.key])) throw bad(`「${ln.label}」第 ${i + 1} 行请填写「${fd.label}」`);
      });
    }
    const refIds = [];
    for (const fd of meta.fields) if (fd.type === "ref" && rec.data[fd.key]) refIds.push([fd, rec.data[fd.key]]);
    for (const ln of meta.lines || []) for (const row of rec.data[ln.key] || []) for (const fd of ln.fields) if (fd.type === "ref" && row[fd.key]) refIds.push([fd, row[fd.key]]);
    for (const [fd, id] of refIds) {
      const r = load(id);
      if (fd.ref === "partner" && !PARTNER_FREE.has(rec.type)) {
        if (r.data.locked) throw bad(`客商「${r.data.name}」已被列入黑名单锁定,不可业务往来`);
        if (r.status !== "approved") throw bad(`客商「${r.data.name}」尚未通过准入审批`);
      }
      if (fd.approvedOnly && r.status !== "approved") throw bad(`「${fd.label}」引用的「${label(r)}」尚未生效`);
    }
    if (attachments) {
      const req = getSettings(db).requiredAttachments[rec.type] || meta.attachments?.required || [];
      if (req.length) {
        const have = new Set(db.prepare("SELECT DISTINCT category FROM attachments WHERE record_id = ?").all(rec.id).map(a => a.category));
        const missing = req.filter(c => !have.has(c));
        if (missing.length) throw bad(`请先上传必传附件:${missing.join("、")}`);
      }
    }
  }

  function diffData(meta, a = {}, b = {}) {
    const out = [];
    for (const fd of meta.fields) {
      const x = JSON.stringify(a[fd.key] ?? null), y = JSON.stringify(b[fd.key] ?? null);
      if (x !== y) out.push({ field: fd.key, label: fd.label, from: a[fd.key] ?? null, to: b[fd.key] ?? null });
    }
    for (const ln of meta.lines || []) {
      if (JSON.stringify(a[ln.key] || []) !== JSON.stringify(b[ln.key] || [])) out.push({ field: ln.key, label: ln.label, from: `${(a[ln.key] || []).length} 行`, to: `${(b[ln.key] || []).length} 行(已修改)` });
    }
    return out;
  }

  function titleOf(meta, data) {
    return (meta.titleKeys || []).map(k => data[k]).filter(v => v !== null && v !== undefined && v !== "").join(" · ").slice(0, 200);
  }

  function cols(meta, data) {
    const c = { partner_id: null, project_id: null, contract_id: null };
    for (const fd of meta.fields) if (fd.col) c[fd.col] = data[fd.key] || null;
    return c;
  }

  // 把内存中的 rec 写回(hooks 修改 data 后用)
  function write(rec) {
    const meta = ENTITIES[rec.type];
    const c = cols(meta, rec.data);
    db.prepare(`UPDATE records SET data = ?, title = ?, partner_id = ?, project_id = ?, contract_id = ?, status = ?, step = ?, steps = ?, version = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(rec.data), titleOf(meta, rec.data), c.partner_id, c.project_id, c.contract_id, rec.status, rec.step, JSON.stringify(rec.steps), rec.version, nowBJ(), rec.id);
    return load(rec.id);
  }

  // 系统内部创建单据(审批生成授信档案、下推等)
  function insertRaw(type, data, { user = null, status = "draft" } = {}) {
    const meta = ENTITIES[type];
    const now = nowBJ(), c = cols(meta, data);
    const { lastInsertRowid } = db.prepare(`INSERT INTO records (type, no, title, status, partner_id, project_id, contract_id, owner_id, dept, data, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(type, nextNo(db, meta.prefix), titleOf(meta, data), status, c.partner_id, c.project_id, c.contract_id,
      user?.id ?? null, user?.dept ?? "", JSON.stringify(data), user?.id ?? null, now, now);
    return load(lastInsertRowid);
  }

  function ctxFor(user) {
    return { db, user, engine: api, now: nowBJ() };
  }

  // 生效:写版本快照、调用 onApproved
  function finalize(ctx, rec, prevData) {
    rec.status = "approved";
    rec.step = 0;
    rec = write(rec);
    db.prepare("INSERT OR REPLACE INTO record_versions (record_id, version, data, created_at) VALUES (?, ?, ?, ?)").run(rec.id, rec.version, JSON.stringify(rec.data), nowBJ());
    const h = H(rec.type);
    if (h.onApproved) {
      h.onApproved(ctx, rec, prevData);
      rec = load(rec.id);
    }
    return rec;
  }

  function save(user, type, id, input) {
    const meta = ENTITIES[type];
    if (!meta) throw new HttpError(404, "单据类型不存在");
    return tx(() => {
      const ctx = ctxFor(user);
      const prev = id ? must(id, type) : null;
      if (prev && !canSee(user, prev)) throw new HttpError(404, "单据不存在");
      if (prev && !editable(user, prev)) throw new HttpError(403, "当前状态不能修改");
      if (!prev) {
        if (meta.systemOnly) throw new HttpError(403, "该单据由系统生成");
        if (isPortal(user) && !(meta.portal?.create && portalTypes(user).has(type))) throw new HttpError(403, "无权新建");
      }
      const data = clean(meta, input, prev?.data, user);
      // 门户新建的单据强制归属到本客商
      if (isPortal(user) && !prev) {
        const scope = [].concat(meta.portal?.scope)[0];
        if (scope === "partner_id") {
          const pf = meta.fields.find(fd => fd.col === "partner_id");
          if (pf) data[pf.key] = user.partner_id;
        } else if (scope === "carrier" || scope === "warehouse") data[scope] = user.partner_id;
      }
      resolveRefs(meta, data);
      const h = H(type);
      if (h.beforeSave) h.beforeSave(ctx, data, prev);
      const now = nowBJ();
      let rec;
      if (prev) {
        const diff = diffData(meta, prev.data, data);
        rec = write({ ...prev, data });
        if (diff.length) log(rec.id, user, "修改", "", diff);
      } else {
        rec = insertRaw(type, data, { user });
        log(rec.id, user, "新建");
      }
      if (meta.noApproval) {
        validateActive(rec, { attachments: false });
        if (h.validateActive) h.validateActive(ctx, rec, prev);
        rec = finalize(ctx, rec, prev?.data);
      }
      void now;
      return rec;
    });
  }

  function submit(user, rec, comment) {
    const meta = ENTITIES[rec.type];
    if (meta.noApproval) throw bad("该单据无需审批");
    if (!["draft", "rejected"].includes(rec.status)) throw bad("当前状态不能提交");
    if (!editable(user, rec)) throw new HttpError(403, "无权提交");
    const ctx = ctxFor(user);
    validateActive(rec);
    const h = H(rec.type);
    if (h.validateActive) h.validateActive(ctx, rec);
    const steps = h.steps ? h.steps(ctx, rec) : meta.approval;
    const prevData = rec.version > 1 ? JSON.parse(db.prepare("SELECT data FROM record_versions WHERE record_id = ? AND version = ?").get(rec.id, rec.version - 1)?.data || "null") : null;
    log(rec.id, user, "提交审批", comment);
    if (!steps.length) return finalize(ctx, rec, prevData);
    rec.status = "pending";
    rec.step = 0;
    rec.steps = steps;
    rec = write(rec);
    notify({ role: steps[0], title: `待审批:${meta.label} ${label(rec)}`, record_id: rec.id });
    return rec;
  }

  function approve(user, rec, comment) {
    if (rec.status !== "pending") throw bad("单据不在审批中");
    const role = rec.steps[rec.step];
    if (!hasRole(user, role)) throw new HttpError(403, "您不是当前审批环节的审批人");
    const meta = ENTITIES[rec.type];
    log(rec.id, user, `审批通过(${role})`, comment);
    if (rec.step + 1 < rec.steps.length) {
      rec.step += 1;
      rec = write(rec);
      notify({ role: rec.steps[rec.step], title: `待审批:${meta.label} ${label(rec)}`, record_id: rec.id });
      return rec;
    }
    const ctx = ctxFor(user);
    const h = H(rec.type);
    if (h.validateActive) h.validateActive(ctx, rec); // 审批期间额度等可能已变化,终审再校验一次
    const prevData = rec.version > 1 ? JSON.parse(db.prepare("SELECT data FROM record_versions WHERE record_id = ? AND version = ?").get(rec.id, rec.version - 1)?.data || "null") : null;
    rec = finalize(ctx, rec, prevData);
    if (rec.partner_id && meta.portal) notify({ partner_id: rec.partner_id, title: `${meta.label}已生效:${label(rec)}`, record_id: rec.id });
    return rec;
  }

  function reject(user, rec, comment) {
    if (rec.status !== "pending") throw bad("单据不在审批中");
    if (!hasRole(user, rec.steps[rec.step])) throw new HttpError(403, "您不是当前审批环节的审批人");
    if (!comment) throw bad("请填写驳回原因");
    log(rec.id, user, "驳回", comment);
    rec.status = "rejected";
    rec.step = 0;
    return write(rec);
  }

  function withdraw(user, rec) {
    if (rec.status !== "pending") throw bad("单据不在审批中");
    if (rec.created_by !== user.id && !hasRole(user, "admin")) throw new HttpError(403, "只有提交人可以撤回");
    log(rec.id, user, "撤回");
    rec.status = "draft";
    rec.step = 0;
    return write(rec);
  }

  function change(user, rec, comment) {
    const meta = ENTITIES[rec.type];
    if (!meta.approval || rec.status !== "approved") throw bad("只有已生效的单据可以发起变更");
    if (isPortal(user)) throw new HttpError(403, "无权变更");
    if (!comment) throw bad("请填写变更原因");
    log(rec.id, user, `发起变更(V${rec.version} → V${rec.version + 1})`, comment);
    rec.status = "draft";
    rec.version += 1;
    return write(rec);
  }

  function cancel(user, rec, comment) {
    if (rec.status === "cancelled") throw bad("已作废");
    if (rec.status === "pending") throw bad("请先撤回审批");
    if (isPortal(user) && rec.created_by !== user.id) throw new HttpError(403, "无权作废");
    const ctx = ctxFor(user);
    const h = H(rec.type);
    if (rec.status === "approved" && h.onCancel) h.onCancel(ctx, rec);
    log(rec.id, user, "作废", comment);
    rec.status = "cancelled";
    return write(rec);
  }

  function runAction(user, rec, action, payload = {}) {
    if (!canSee(user, rec)) throw new HttpError(404, "单据不存在");
    const comment = String(payload.comment ?? "").trim().slice(0, 500);
    // 返回 { record, message };message 只回给操作人,不写日志(可能含门户初始密码)
    return tx(() => {
      switch (action) {
        case "submit": return { record: submit(user, rec, comment) };
        case "approve": return { record: approve(user, rec, comment) };
        case "reject": return { record: reject(user, rec, comment) };
        case "withdraw": return { record: withdraw(user, rec) };
        case "change": return { record: change(user, rec, comment) };
        case "cancel": return { record: cancel(user, rec, comment) };
      }
      const a = H(rec.type).actions?.[action];
      if (!a || (isPortal(user) && !a.portal) || !a.show(rec, user, api)) throw bad("当前不能执行该操作");
      if (a.commentRequired && !comment) throw bad(`请填写${a.comment || "说明"}`);
      const ctx = ctxFor(user);
      const out = a.run(ctx, rec, payload);
      log(rec.id, user, a.label, comment);
      return { record: load(rec.id), message: typeof out?.message === "string" ? out.message : "" };
    });
  }

  function availableActions(user, rec) {
    const meta = ENTITIES[rec.type], acts = [];
    const portal = isPortal(user);
    if (meta.approval) {
      if (["draft", "rejected"].includes(rec.status) && editable(user, rec)) acts.push({ key: "submit", label: "提交审批", primary: true });
      if (rec.status === "pending" && hasRole(user, rec.steps[rec.step]) && !portal) {
        acts.push({ key: "approve", label: "审批通过", primary: true, comment: "审批意见(选填)" });
        acts.push({ key: "reject", label: "驳回", danger: true, comment: "驳回原因", commentRequired: true });
      }
      if (rec.status === "pending" && (rec.created_by === user.id || hasRole(user, "admin"))) acts.push({ key: "withdraw", label: "撤回" });
      if (rec.status === "approved" && !portal && ["contract", "framework", "project"].includes(rec.type)) acts.push({ key: "change", label: "变更", comment: "变更原因", commentRequired: true });
    }
    for (const [key, a] of Object.entries(H(rec.type).actions || {})) {
      if (portal && !a.portal) continue;
      if (a.show(rec, user, api)) {
        const inputs = (a.inputs || []).map(i => (typeof i.options === "string" ? { ...i, options: options(i) } : i));
        acts.push({ key, label: a.label, primary: a.primary, danger: a.danger, confirm: a.confirm, inputs, comment: a.comment, commentRequired: a.commentRequired });
      }
    }
    if (rec.status !== "cancelled" && rec.status !== "pending" && (!portal || rec.created_by === user.id) && !meta.systemOnly) {
      acts.push({ key: "cancel", label: "作废", danger: true, comment: "作废原因", commentRequired: true });
    }
    return acts;
  }

  function refsOf(rec) {
    const meta = ENTITIES[rec.type], ids = new Set();
    for (const fd of meta.fields) {
      if (fd.type === "ref" && rec.data[fd.key]) ids.add(rec.data[fd.key]);
      if (fd.type === "refs") for (const id of rec.data[fd.key] || []) ids.add(id);
    }
    for (const ln of meta.lines || []) for (const row of rec.data[ln.key] || []) for (const fd of ln.fields) if (fd.type === "ref" && row[fd.key]) ids.add(row[fd.key]);
    const out = {};
    for (const id of ids) {
      const r = load(id);
      if (r) out[id] = { label: r.type === "partner" ? r.data.name : label(r), type: r.type, status: r.status };
    }
    return out;
  }

  const api = {
    db, load, must, list, label, tx, log, notify, write, insertRaw, finalize, save, runAction, availableActions, refsOf,
    canSee, editable, portalTypes, validateActive, options, STATUS,
  };
  return api;
}
