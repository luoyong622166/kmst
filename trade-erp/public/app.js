// 进出口贸易管理系统前端(无框架单页应用):内部后台与客商门户共用,菜单按账号角色生成
(function () {
  "use strict";
  var BASE = "/trade/api";
  var ME = null, META = null, ROOT = document.getElementById("root");

  // ================= 工具 =================
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function h(html) { var t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function toast(msg, err) {
    var t = $("#toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.style.display = "block";
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.style.display = "none"; }, err ? 5000 : 3000);
  }
  function fmtNum(v, d) {
    if (v === null || v === undefined || v === "") return "";
    var n = Number(v); if (!isFinite(n)) return esc(v);
    return n.toLocaleString("zh-CN", { minimumFractionDigits: d === 3 ? 0 : d, maximumFractionDigits: d });
  }
  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    var body = opts.body;
    if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) { headers["Content-Type"] = "application/json"; body = JSON.stringify(body); }
    return fetch(BASE + path, { method: opts.method || (body !== undefined ? "POST" : "GET"), headers: headers, body: body, credentials: "same-origin" })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.status === 401 && path !== "/login") { ME = null; renderAuth(); throw new Error(d.error || "请先登录"); }
          if (!r.ok) throw new Error(d.error || "请求失败(" + r.status + ")");
          return d;
        });
      }, function () { throw new Error("网络异常,请稍后重试"); });
  }
  function fail(e) { toast(e.message || String(e), true); }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  var STATUS_TEXT = { draft: "草稿", pending: "审批中", approved: "已生效", rejected: "已驳回", cancelled: "已作废" };
  function badge(st, meta) {
    var txt = STATUS_TEXT[st] || st;
    if (meta && meta.noApproval && st === "approved") txt = "有效";
    return '<span class="badge ' + esc(st) + '">' + esc(txt) + "</span>";
  }
  var isPortal = function () { return ME && ME.roles.indexOf("portal") >= 0; };
  var hasRole = function (r) { return ME && (ME.roles.indexOf("admin") >= 0 || ME.roles.indexOf(r) >= 0); };

  function modal(html, wide) {
    var bg = h('<div class="modal-bg"><div class="modal' + (wide ? " wide" : "") + '">' + html + "</div></div>");
    bg.addEventListener("click", function (e) { if (e.target === bg || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) bg.remove(); });
    document.body.appendChild(bg);
    return bg;
  }

  // ================= 值的展示 =================
  function show(fd, v, refs) {
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return '<span class="muted">-</span>';
    switch (fd.type) {
      case "money": return fmtNum(v, 2);
      case "qty": return fmtNum(v, 3);
      case "number": return fmtNum(v, 4);
      case "percent": return fmtNum(v, 2) + "%";
      case "rate": return esc(v) + (Number(v) ? '<span class="muted">(年化约 ' + (Number(v) * 360 * 100).toFixed(2) + "%)</span>" : "");
      case "bool": return v ? "是" : "否";
      case "multi": return v.map(esc).join("、");
      case "ref": return refLink(v, refs);
      case "refs": return v.map(function (id) { return refLink(id, refs); }).join("、");
      case "changes": return Object.keys(v).map(function (k) {
        var f = META.entities.partner.fields.filter(function (x) { return x.key === k; })[0];
        return esc((f ? f.label : k) + ":" + v[k]);
      }).join("<br>");
      default: return esc(v);
    }
  }
  function refLink(id, refs) {
    var r = refs && refs[id];
    return '<a data-goto="' + Number(id) + '">' + esc(r ? r.label : "#" + id) + "</a>";
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("[data-goto]");
    if (!a) return;
    e.preventDefault();
    api("/goto/" + a.getAttribute("data-goto")).then(function (d) { go("#/r/" + d.type + "/" + d.id); }, fail);
  });

  // ================= 登录 / 注册 =================
  function renderAuth(mode) {
    mode = mode || "login";
    api("/public-meta").then(function (pm) {
      ROOT.innerHTML = '<div class="auth"><h1>' + esc(pm.company) + '</h1><p class="muted" style="text-align:center;margin:0">进出口贸易管理系统 · 客商门户</p>' +
        '<div class="tabs"><a data-m="login" class="' + (mode === "login" ? "on" : "") + '">登录</a><a data-m="reg" class="' + (mode === "reg" ? "on" : "") + '">客户/供应商注册</a></div>' +
        (mode === "login"
          ? '<form id="af"><div class="f"><label>用户名</label><input name="username" autocomplete="username"></div><div class="f"><label>密码</label><input name="password" type="password" autocomplete="current-password"></div><button class="btn" style="width:100%;justify-content:center;padding:9px">登录</button></form>'
          : '<form id="af"><div class="f"><label>企业名称</label><input name="company"></div><div class="f"><label>统一社会信用代码(境外企业可不填)</label><input name="credit_code"></div>' +
            '<div class="f"><label>境内/境外</label><select name="region"><option>国内</option><option>国外</option></select></div>' +
            '<div class="f"><label>客商类型(可多选)</label><div class="checks">' + pm.partnerTypes.map(function (t) { return '<label><input type="checkbox" name="ptype" value="' + esc(t) + '" style="width:auto">' + esc(t) + "</label>"; }).join("") + "</div></div>" +
            '<div class="f"><label>联系人</label><input name="contact"></div><div class="f"><label>联系电话</label><input name="phone"></div>' +
            '<div class="f"><label>登录名</label><input name="username" autocomplete="username"></div><div class="f"><label>密码(至少 8 位)</label><input name="password" type="password" autocomplete="new-password"></div>' +
            '<button class="btn" style="width:100%;justify-content:center;padding:9px">注册并提交建档</button><p class="muted">注册后请补充企业资料、上传营业执照并提交准入审批,审批通过后开通业务功能。</p></form>') + "</div>";
      $$(".tabs a").forEach(function (a) { a.onclick = function () { renderAuth(a.getAttribute("data-m")); }; });
      $("#af").onsubmit = function (e) {
        e.preventDefault();
        var f = e.target, body;
        if (mode === "login") body = { username: f.username.value.trim(), password: f.password.value };
        else body = { company: f.company.value, credit_code: f.credit_code.value, region: f.region.value, contact: f.contact.value, phone: f.phone.value, username: f.username.value.trim(),
          password: f.password.value, ptype: $$('input[name="ptype"]:checked', f).map(function (x) { return x.value; }) };
        api(mode === "login" ? "/login" : "/portal/register", { body: body }).then(function () { boot(); }, fail);
      };
    }, fail);
  }

  // ================= 启动 / 菜单 =================
  function boot() {
    api("/me").then(function (d) {
      ME = d.user;
      return api("/meta");
    }).then(function (m) {
      META = m;
      renderShell();
      route();
    }).catch(function () { if (!ME) renderAuth(); });
  }

  function menuHtml() {
    var html = '<div class="brand">' + esc(META.settings.companyName) + '<div class="small" style="color:#94a3b8;font-weight:400">' + (isPortal() ? "客商门户" : "进出口贸易管理系统") + "</div></div>";
    html += '<a href="#/">工作台</a><a href="#/notices">消息通知</a>';
    if (isPortal()) {
      html += '<div class="grp">我的业务</div>';
      META.portalTypes.forEach(function (t) {
        var e = META.entities[t];
        if (t === "partner") html += '<a href="#/r/partner/' + ME.partner_id + '">' + esc(e.portal.menu) + "</a>";
        else html += '<a href="#/list/' + t + '">' + esc(e.portal.menu || e.label) + "</a>";
      });
    } else {
      var groups = {};
      Object.keys(META.entities).forEach(function (k) { var e = META.entities[k]; (groups[e.group] = groups[e.group] || []).push(k); });
      Object.keys(groups).forEach(function (g) {
        html += '<div class="grp">' + esc(g) + "</div>";
        groups[g].forEach(function (k) { html += '<a href="#/list/' + k + '">' + esc(META.entities[k].label) + "</a>"; });
      });
      html += '<div class="grp">报表台账</div>';
      Object.keys(META.reports).forEach(function (k) { html += '<a href="#/report/' + k + '">' + esc(META.reports[k].label) + "</a>"; });
      html += '<div class="grp">系统</div><a href="#/import">批量导入</a>';
      if (hasRole("admin")) html += '<a href="#/users">用户与角色</a><a href="#/settings">系统设置</a>';
    }
    html += '<div class="grp">账号</div><a href="#/password">修改密码</a><a id="logout">退出登录</a>';
    return html;
  }

  function renderShell() {
    ROOT.innerHTML = '<div class="layout"><nav class="side" id="side">' + menuHtml() + '</nav><main><div class="topbar"><button class="menu-btn" id="menuBtn">☰</button><h2 id="title"></h2>' +
      '<span class="bell" id="bell"></span><span class="user">' + esc(ME.name) + (ME.partner_name ? "(" + esc(ME.partner_name) + ")" : " · " + ME.roles.map(function (r) { return META.roles[r]; }).join("/")) +
      '</span></div><div id="view"></div></main></div>';
    $("#logout").onclick = function () { api("/logout", { body: {} }).then(function () { ME = null; renderAuth(); }); };
    $("#menuBtn").onclick = function () { $("#side").classList.toggle("open"); };
    $("#bell").onclick = function () { go("#/notices"); };
    refreshBell();
  }
  function refreshBell() {
    api("/notifications").then(function (d) { var b = $("#bell"); if (b) b.innerHTML = "🔔" + (d.unread ? "<b>" + d.unread + "</b>" : ""); }, function () {});
  }
  function setTitle(t) { $("#title").textContent = t; document.title = t + " - " + META.settings.companyName; }
  function view() { return $("#view"); }

  function route() {
    if (!ME || !META) return;
    var hsh = location.hash.replace(/^#/, "") || "/", parts = hsh.split("?")[0].split("/").filter(Boolean);
    var qs = new URLSearchParams(hsh.split("?")[1] || "");
    $$("#side a").forEach(function (a) { a.classList.toggle("on", a.getAttribute("href") === "#" + hsh.split("?")[0]); });
    $("#side").classList.remove("open");
    view().innerHTML = '<p class="muted">加载中…</p>';
    window.scrollTo(0, 0);
    var p0 = parts[0];
    if (!p0) return renderDashboard();
    if (p0 === "list") return renderList(parts[1]);
    if (p0 === "new") return renderForm(parts[1], null, qs);
    if (p0 === "r") return renderDetail(parts[1], parts[2]);
    if (p0 === "edit") return renderForm(parts[1], parts[2], qs);
    if (p0 === "report") return renderReport(parts[1], qs);
    if (p0 === "dossier") return renderDossier(parts[1]);
    if (p0 === "notices") return renderNotices();
    if (p0 === "users") return renderUsers();
    if (p0 === "settings") return renderSettings();
    if (p0 === "import") return renderImport();
    if (p0 === "password") return renderPassword();
    view().innerHTML = "<p>页面不存在</p>";
  }
  window.addEventListener("hashchange", route);

  // ================= 工作台 =================
  function renderDashboard() {
    setTitle("工作台");
    api("/dashboard").then(function (d) {
      var html = "";
      if (isPortal() && ME.partner_status !== "approved") {
        html += '<div class="help">您的企业尚未通过准入审批。请到「' + esc(META.entities.partner.portal.menu) + '」补充资料、上传营业执照后点击「提交审批」;审批通过后将开通合同、发票、请款等业务功能。</div>';
      }
      if (d.stats) {
        html += '<div class="stats">' + [["已准入客商", d.stats.partners, "#/list/partner"], ["黑名单锁定", d.stats.locked, "#/list/partner"], ["执行中合同", d.stats.contracts, "#/report/contract_ledger"],
          ["待处理风险", d.stats.risk, "#/list/risk_event"], ["待认领收款", d.stats.unclaimed, "#/list/payment"], ["待我审批", d.todo.length, "#/"]].map(function (s) {
          return '<div class="stat" data-href="' + s[2] + '"><div class="muted">' + s[0] + '</div><div class="v">' + s[1] + "</div></div>";
        }).join("") + "</div>";
      }
      if (!isPortal()) {
        html += '<div class="card"><h3>待我审批(' + d.todo.length + ")</h3>" + (d.todo.length ? '<div class="tbl"><table><tr><th>单据</th><th>编号</th><th>摘要</th><th>审批环节</th><th>更新时间</th></tr>' +
          d.todo.map(function (t) { return '<tr class="click" data-href="#/r/' + t.type + "/" + t.id + '"><td>' + esc(META.entities[t.type].label) + "</td><td>" + esc(t.no) + '</td><td class="wrap">' + esc(t.title) + "</td><td>" + esc(META.roles[t.role]) + "</td><td>" + esc(t.updated_at) + "</td></tr>"; }).join("") +
          "</table></div>" : '<p class="muted">暂无待审批单据</p>') + "</div>";
      }
      html += '<div class="card"><h3>我的未完成单据</h3>' + (d.mine.length ? '<div class="tbl"><table><tr><th>单据</th><th>编号</th><th>摘要</th><th>状态</th><th>更新时间</th></tr>' +
        d.mine.map(function (t) { return '<tr class="click" data-href="#/r/' + t.type + "/" + t.id + '"><td>' + esc(META.entities[t.type].label) + "</td><td>" + esc(t.no) + '</td><td class="wrap">' + esc(t.title) + "</td><td>" + badge(t.status) + "</td><td>" + esc(t.updated_at) + "</td></tr>"; }).join("") +
        "</table></div>" : '<p class="muted">没有草稿或审批中的单据</p>') + "</div>";
      html += '<div class="card"><h3>未读消息<span class="sp"></span><a href="#/notices" class="small">全部消息</a></h3>' + noticeList(d.notifications.items.slice(0, 10)) + "</div>";
      view().innerHTML = html;
      bindHref(view());
      bindNotices(view());
    }, fail);
  }
  function bindHref(root) { $$("[data-href]", root).forEach(function (el) { el.onclick = function () { go(el.getAttribute("data-href")); }; }); }

  function noticeList(items) {
    if (!items.length) return '<p class="muted">暂无消息</p>';
    return items.map(function (n) {
      return '<div class="notice-item' + (n.read_at ? "" : " unread") + '" data-nid="' + n.id + '" data-rid="' + (n.record_id || "") + '"><div class="t">' + esc(n.title) + "</div>" +
        (n.body ? '<div class="muted">' + esc(n.body) + "</div>" : "") + '<div class="muted small">' + esc(n.created_at) + "</div></div>";
    }).join("");
  }
  function bindNotices(root) {
    $$("[data-nid]", root).forEach(function (el) {
      el.onclick = function () {
        api("/notifications/read", { body: { ids: [Number(el.getAttribute("data-nid"))] } }).then(refreshBell, function () {});
        var rid = el.getAttribute("data-rid");
        if (rid) api("/goto/" + rid).then(function (d) { go("#/r/" + d.type + "/" + d.id); }, fail);
      };
    });
  }
  function renderNotices() {
    setTitle("消息通知");
    api("/notifications?all=1").then(function (d) {
      view().innerHTML = '<div class="card"><h3>全部消息<span class="sp"></span><button class="btn sm ghost" id="readAll">全部标为已读</button></h3>' + noticeList(d.items) + "</div>";
      bindNotices(view());
      $("#readAll").onclick = function () { api("/notifications/read", { body: { all: true } }).then(function () { refreshBell(); renderNotices(); }, fail); };
    }, fail);
  }

  // ================= 列表 =================
  function canCreate(type) {
    var e = META.entities[type];
    if (!e || e.systemOnly) return false;
    if (isPortal()) return !!(e.portal && e.portal.create && META.portalTypes.indexOf(type) >= 0);
    return true;
  }
  function renderList(type) {
    var e = META.entities[type];
    if (!e) { view().innerHTML = "<p>单据类型不存在</p>"; return; }
    setTitle(isPortal() && e.portal && e.portal.menu ? e.portal.menu : e.label);
    var state = { page: 1, q: "", status: "" };
    var cols = e.fields.filter(function (f) { return f.list; });
    view().innerHTML = (e.help ? '<div class="help">' + esc(e.help) + "</div>" : "") +
      '<div class="card"><div class="toolbar"><input id="kw" placeholder="搜索编号/名称/内容" style="width:220px"><select id="st"><option value="">全部状态</option>' +
      Object.keys(STATUS_TEXT).map(function (k) { return '<option value="' + k + '">' + STATUS_TEXT[k] + "</option>"; }).join("") + '</select><button class="btn plain" id="sbtn">查询</button>' +
      '<span style="flex:1"></span>' + (canCreate(type) ? '<a class="btn" href="#/new/' + type + '">+ 新建' + esc(e.label) + "</a>" : "") + '</div><div class="tbl" id="tb"></div><div class="pager" id="pg"></div></div>';
    function load() {
      var p = new URLSearchParams({ page: state.page, q: state.q });
      if (state.status) p.set("status", state.status);
      api("/records/" + type + "?" + p).then(function (d) {
        $("#tb").innerHTML = d.items.length ? "<table><tr><th>编号</th>" + cols.map(function (c) { return '<th class="' + (["money", "qty", "number"].indexOf(c.type) >= 0 ? "num" : "") + '">' + esc(c.label) + "</th>"; }).join("") +
          "<th>状态</th><th>更新时间</th></tr>" + d.items.map(function (r) {
            return '<tr class="click" data-href="#/r/' + type + "/" + r.id + '"><td>' + esc(r.no) + "</td>" + cols.map(function (c) {
              var cls = ["money", "qty", "number"].indexOf(c.type) >= 0 ? "num" : c.type === "textarea" ? "wrap" : "";
              var v = c.type === "ref" ? (r.data[c.key] ? esc((d.refs[r.data[c.key]] || {}).label || "#" + r.data[c.key]) : "") : show(c, r.data[c.key], d.refs);
              if (c.key === "locked" && r.data.locked) v = '<span class="badge red">已锁定</span>';
              return '<td class="' + cls + '">' + v + "</td>";
            }).join("") + "<td>" + badge(r.status, e) + (r.version > 1 ? ' <span class="muted small">V' + r.version + "</span>" : "") + "</td><td>" + esc(r.updated_at.slice(0, 16)) + "</td></tr>";
          }).join("") + "</table>" : '<p class="muted">暂无数据</p>';
        bindHref($("#tb"));
        var pages = Math.max(1, Math.ceil(d.total / d.size));
        $("#pg").innerHTML = '<span class="muted">共 ' + d.total + ' 条</span><button class="btn sm plain" id="pv"' + (state.page <= 1 ? " disabled" : "") + ">上一页</button><span>" + state.page + "/" + pages +
          '</span><button class="btn sm plain" id="nx"' + (state.page >= pages ? " disabled" : "") + ">下一页</button>";
        $("#pv").onclick = function () { state.page--; load(); };
        $("#nx").onclick = function () { state.page++; load(); };
      }, fail);
    }
    $("#sbtn").onclick = function () { state.q = $("#kw").value.trim(); state.status = $("#st").value; state.page = 1; load(); };
    $("#kw").onkeydown = function (ev) { if (ev.key === "Enter") $("#sbtn").click(); };
    load();
  }

  // ================= 引用选择器 =================
  // 输入关键字从 /options 搜索,选中后把 id 存在 data-value
  var pickerSeq = 0;
  function refPicker(fd, value, label, opts) {
    opts = opts || {};
    var id = "dl" + (++pickerSeq);
    var wrap = h('<div class="refpick"><input list="' + id + '" placeholder="输入关键字搜索" autocomplete="off"><datalist id="' + id + '"></datalist></div>');
    var input = $("input", wrap), dl = $("datalist", wrap), items = [];
    wrap.dataset.value = value || "";
    input.value = value ? label || "#" + value : "";
    if (opts.readonly) input.readOnly = true;
    var timer;
    function search() {
      var p = new URLSearchParams({ q: input.value.replace(/^#\d+$/, "").slice(0, 30) });
      if (fd.filter) p.set("filter", JSON.stringify(fd.filter));
      if (fd.approvedOnly) p.set("approved", "1");
      api("/options/" + fd.ref + "?" + p).then(function (d) {
        items = d.items;
        dl.innerHTML = items.map(function (it) { return '<option value="' + esc(it.label) + '">' + (it.status !== "approved" ? STATUS_TEXT[it.status] : "") + (it.locked ? " 已锁定" : "") + "</option>"; }).join("");
      }, function () {});
    }
    input.addEventListener("focus", search);
    input.addEventListener("input", function () {
      var hit = items.filter(function (it) { return it.label === input.value; })[0];
      wrap.dataset.value = hit ? hit.id : "";
      if (hit && opts.onChange) opts.onChange(hit.id);
      clearTimeout(timer); timer = setTimeout(search, 250);
    });
    input.addEventListener("change", function () {
      if (!input.value) { wrap.dataset.value = ""; if (opts.onChange) opts.onChange(null); }
    });
    return wrap;
  }

  // ================= 表单 =================
  function inputFor(fd, v, refs, opts) {
    opts = opts || {};
    var ro = fd.ro || opts.readonly;
    var el;
    switch (fd.type) {
      case "textarea":
        el = h("<textarea></textarea>"); el.value = v == null ? "" : v; if (ro) el.readOnly = true; break;
      case "select":
        el = h('<select><option value=""></option>' + (fd.options || []).map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + "</option>"; }).join("") + "</select>");
        el.value = v == null ? "" : v; if (ro) el.disabled = true; break;
      case "multi":
        el = h('<div class="checks">' + (fd.options || []).map(function (o) { return '<label><input type="checkbox" value="' + esc(o) + '"' + ((v || []).indexOf(o) >= 0 ? " checked" : "") + (ro ? " disabled" : "") + ">" + esc(o) + "</label>"; }).join("") + "</div>");
        break;
      case "bool":
        el = h('<label style="display:flex;align-items:center;gap:6px;padding-top:4px"><input type="checkbox" style="width:auto"' + (v ? " checked" : "") + (ro ? " disabled" : "") + ">是</label>"); break;
      case "ref":
        el = refPicker(fd, v, refs && refs[v] && refs[v].label, { readonly: ro, onChange: opts.onChange }); break;
      case "refs":
        el = refsPicker(fd, v || [], refs, ro); break;
      case "date":
        el = h('<input type="date">'); el.value = v || ""; if (ro) el.readOnly = true; break;
      case "money": case "qty": case "number": case "percent": case "rate":
        el = h('<input type="number" step="any">'); el.value = v == null ? "" : v; if (ro) el.readOnly = true; break;
      default:
        el = h('<input type="text">'); el.value = v == null ? "" : v; if (ro) el.readOnly = true;
    }
    el.dataset.key = fd.key;
    el.dataset.type = fd.type;
    return el;
  }
  function refsPicker(fd, ids, refs, ro) {
    var wrap = h('<div><div class="chips"></div></div>');
    var vals = ids.slice(), labels = {};
    ids.forEach(function (id) { labels[id] = refs && refs[id] ? refs[id].label : "#" + id; });
    function paint() {
      $(".chips", wrap).innerHTML = vals.map(function (id) { return '<span class="chip">' + esc(labels[id]) + (ro ? "" : ' <a data-rm="' + id + '">×</a>') + "</span>"; }).join("") || '<span class="muted small">未选择</span>';
      $$("[data-rm]", wrap).forEach(function (a) { a.onclick = function () { vals = vals.filter(function (x) { return String(x) !== a.getAttribute("data-rm"); }); paint(); }; });
      wrap.dataset.value = JSON.stringify(vals);
    }
    if (!ro) {
      var pk = refPicker(fd, null, null, { onChange: function (id) {
        if (id && vals.indexOf(id) < 0) { vals.push(id); labels[id] = $("input", pk).value; $("input", pk).value = ""; paint(); }
      } });
      wrap.appendChild(pk);
    }
    paint();
    return wrap;
  }
  function readInput(el) {
    var t = el.dataset.type;
    if (t === "multi") return $$("input:checked", el).map(function (x) { return x.value; });
    if (t === "bool") return $("input", el).checked;
    if (t === "ref") return el.dataset.value ? Number(el.dataset.value) : null;
    if (t === "refs") return JSON.parse(el.dataset.value || "[]");
    var v = el.value;
    if (["money", "qty", "number", "percent", "rate"].indexOf(t) >= 0) return v === "" ? null : Number(v);
    return v;
  }

  function fieldEditable(fd) {
    if (fd.ro) return false;
    if (isPortal()) return !!fd.portal;
    return true;
  }

  function renderForm(type, id, qs) {
    var e = META.entities[type];
    if (!e) { view().innerHTML = "<p>单据类型不存在</p>"; return; }
    var load = id ? api("/records/" + type + "/" + id) : qs.get("from") ? api("/pushdown?from=" + qs.get("from") + "&to=" + type).then(function (d) { return { record: { data: d.data }, refs: {} }; }) : Promise.resolve({ record: { data: {} }, refs: {} });
    load.then(function (d) {
      var rec = d.record, data = rec.data || {}, refs = d.refs || {};
      if (!id) e.fields.forEach(function (f) { if (data[f.key] === undefined && f.default !== undefined) data[f.key] = f.default; });
      // 下推带入的引用需要显示名称
      var needLabels = [];
      e.fields.forEach(function (f) { if (f.type === "ref" && data[f.key] && !refs[data[f.key]]) needLabels.push(data[f.key]); });
      (e.lines || []).forEach(function (ln) {
        (data[ln.key] || []).forEach(function (row) {
          ln.fields.forEach(function (f) { if (f.type === "ref" && row[f.key] && !refs[row[f.key]] && needLabels.indexOf(row[f.key]) < 0) needLabels.push(row[f.key]); });
        });
      });
      Promise.all(needLabels.map(function (rid) {
        return api("/goto/" + rid).then(function (g) { return api("/records/" + g.type + "/" + rid); }).then(function (x) { refs[rid] = { label: x.record.type === "partner" ? x.record.data.name : x.record.no + " " + x.record.title }; }, function () {});
      })).then(function () { paintForm(e, type, id, rec, data, refs, qs); });
    }, fail);
  }

  function paintForm(e, type, id, rec, data, refs, qs) {
    setTitle((id ? "编辑" : "新建") + e.label + (id ? " " + rec.no : ""));
    var portal = isPortal();
    var fields = e.fields.filter(function (f) { return !f.hidden && (!portal || f.portal || (id && data[f.key] !== null && data[f.key] !== undefined && data[f.key] !== "")); });
    var root = h('<div><div class="help"' + (e.help ? "" : " hidden") + ">" + esc(e.help || "") + '</div><div class="card"><h3>基本信息<span class="sp"></span><span id="lookupBox"></span></h3><div class="grid" id="fg"></div></div><div id="lines"></div>' +
      '<div class="card btns"><button class="btn" id="save">保存</button><button class="btn plain" id="back">取消</button><span class="muted">' +
      (e.approval ? "保存为草稿后,可上传附件并「提交审批」" : "保存后立即生效") + "</span></div></div>");
    var fg = $("#fg", root);
    fields.forEach(function (f) {
      if (f.type === "changes") return;
      var wrap = h('<div class="fld' + (f.type === "textarea" || f.type === "multi" || f.type === "refs" ? " wide" : "") + '"><label>' + esc(f.label) + (f.req && !f.ro ? ' <span class="req">*</span>' : "") + "</label></div>");
      var el = inputFor(f, data[f.key], refs, { readonly: !fieldEditable(f), onChange: f.key === "partner" && type === "partner_change" ? function (pid) { paintChanges(pid); } : null });
      wrap.appendChild(el);
      if (f.help) wrap.appendChild(h('<div class="hint">' + esc(f.help) + "</div>"));
      fg.appendChild(wrap);
    });
    // 客商变更:逐字段填写新值
    var changesBox = null;
    if (type === "partner_change") {
      changesBox = h('<div class="fld wide"><label>变更内容(只填需要变更的字段)</label><div class="tbl"><table class="changes"><tbody></tbody></table></div></div>');
      fg.appendChild(changesBox);
    }
    function paintChanges(pid) {
      if (!changesBox) return;
      var tb = $("tbody", changesBox);
      if (!pid) { tb.innerHTML = '<tr><td class="muted">请先选择客商</td></tr>'; return; }
      api("/records/partner/" + pid).then(function (pd) {
        var cur = pd.record.data, ch = data.changes || {};
        var flds = META.entities.partner.fields.filter(function (f) { return !f.ro && f.key !== "ptype" && f.key !== "internal_org"; });
        tb.innerHTML = "<tr><th>字段</th><th>当前值</th><th>变更为</th></tr>" + flds.map(function (f) {
          return "<tr><td>" + esc(f.label) + (["name", "business_scope", "legal_person", "shareholders"].indexOf(f.key) >= 0 ? ' <span class="badge pending">需审批</span>' : "") + '</td><td class="wrap muted">' + esc(cur[f.key] == null ? "" : cur[f.key]) +
            '</td><td><input data-ck="' + f.key + '" value="' + esc(ch[f.key] || "") + '" style="width:100%;min-width:200px;border:1px solid var(--line);border-radius:5px;padding:4px 6px"></td></tr>';
        }).join("");
      }, fail);
    }
    if (type === "partner_change") paintChanges(portal ? ME.partner_id : data.partner);

    // 工商信息查询
    if (type === "partner" && !portal) {
      var lb = h('<button class="btn sm ghost" type="button">企查查/天眼查查询</button>');
      lb.onclick = function () { lookupDialog(fg); };
      $("#lookupBox", root).appendChild(lb);
    }

    // 明细行
    var linesBox = $("#lines", root);
    (e.lines || []).forEach(function (ln) {
      var editableLine = !ln.ro && (!portal || ln.portal);
      if (portal && !ln.portal && !(data[ln.key] || []).length) return;
      var cols = ln.fields.filter(function (f) { return !f.hidden; });
      var card = h('<div class="card"><h3>' + esc(ln.label) + '<span class="sp"></span>' + (editableLine ? '<button type="button" class="btn sm ghost" data-add>+ 添加行</button>' : "") +
        '</h3><div class="tbl"><table class="lines"><thead><tr>' + cols.map(function (f) { return "<th>" + esc(f.label) + (f.req && !f.ro ? ' <span style="color:var(--danger)">*</span>' : "") + "</th>"; }).join("") +
        (editableLine ? "<th></th>" : "") + "</tr></thead><tbody></tbody></table></div></div>");
      card.dataset.line = ln.key;
      var tb = $("tbody", card);
      function addRow(row) {
        row = row || {};
        var tr = document.createElement("tr");
        cols.forEach(function (f) {
          var td = document.createElement("td");
          if (f.ro || !editableLine) { td.className = "ro"; td.innerHTML = show(f, row[f.key], refs); td.dataset.key = f.key; td.dataset.ro = "1"; }
          else {
            var v = row[f.key];
            if (v === undefined && f.default !== undefined) v = f.default;
            td.appendChild(inputFor(f, v, refs));
          }
          tr.appendChild(td);
        });
        if (editableLine) {
          var del = h('<td><button type="button" class="btn sm danger">删</button></td>');
          $("button", del).onclick = function () { tr.remove(); };
          tr.appendChild(del);
        }
        tr._row = row;
        tb.appendChild(tr);
      }
      (data[ln.key] || []).forEach(addRow);
      if (editableLine && !(data[ln.key] || []).length) addRow();
      var add = $("[data-add]", card);
      if (add) add.onclick = function () { addRow(); };
      linesBox.appendChild(card);
    });

    view().innerHTML = "";
    view().appendChild(root);
    $("#back", root).onclick = function () { history.back(); };
    $("#save", root).onclick = function () {
      var out = {};
      $$(".fld [data-key]", fg).forEach(function (el) {
        if (el.closest(".lines")) return;
        var f = e.fields.filter(function (x) { return x.key === el.dataset.key; })[0];
        if (f && fieldEditable(f)) out[f.key] = readInput(el);
      });
      if (changesBox) {
        out.changes = {};
        $$("[data-ck]", changesBox).forEach(function (i) { if (i.value.trim()) out.changes[i.getAttribute("data-ck")] = i.value.trim(); });
      }
      $$("[data-line]", linesBox).forEach(function (card) {
        var ln = e.lines.filter(function (x) { return x.key === card.dataset.line; })[0];
        if (ln.ro || (portal && !ln.portal)) return;
        out[ln.key] = $$("tbody tr", card).map(function (tr) {
          var row = {};
          $$("td [data-key]", tr).forEach(function (el) { if (!el.closest("td").dataset.ro) row[el.dataset.key] = readInput(el); });
          return row;
        });
      });
      var btn = this; btn.disabled = true;
      api(id ? "/records/" + type + "/" + id : "/records/" + type, { method: id ? "PUT" : "POST", body: { data: out } }).then(function (d) {
        toast("已保存");
        location.replace("#/r/" + type + "/" + d.record.id);
      }, fail).then(function () { btn.disabled = false; });
    };
    void qs;
  }

  function lookupDialog(fg) {
    var m = modal('<h3>工商信息查询</h3><div class="toolbar"><input id="lq" placeholder="企业名称或信用代码" style="flex:1"><button class="btn" id="lgo">查询</button></div><div id="lr" class="muted">' +
      (META.lookup ? "数据来源:" + (META.lookup === "tianyancha" ? "天眼查" : "企查查") : "尚未配置企查查/天眼查密钥(服务器 /etc/trade-erp.env),暂不能自动获取") + '</div><div class="acts"><button class="btn plain" data-close>关闭</button></div>');
    var nameInput = $('[data-key="name"]', fg);
    $("#lq", m).value = nameInput ? nameInput.value : "";
    $("#lgo", m).onclick = function () {
      api("/lookup/search?q=" + encodeURIComponent($("#lq", m).value.trim())).then(function (d) {
        $("#lr", m).innerHTML = d.items.length ? d.items.map(function (it, i) { return '<div class="notice-item" data-i="' + i + '"><b>' + esc(it.name) + '</b><div class="muted">' + esc(it.creditCode) + " · " + esc(it.legalPerson) + " · " + esc(it.regStatus) + "</div></div>"; }).join("") : "未查到";
        $$("[data-i]", m).forEach(function (el) {
          el.onclick = function () {
            var it = d.items[Number(el.getAttribute("data-i"))];
            var map = { name: it.name, credit_code: it.creditCode, legal_person: it.legalPerson, reg_capital: it.regCapital, address: it.address, business_scope: it.businessScope };
            Object.keys(map).forEach(function (k) { var inp = $('[data-key="' + k + '"]', fg); if (inp && map[k]) inp.value = map[k]; });
            m.remove(); toast("已带入工商信息");
          };
        });
      }, fail);
    };
  }

  // ================= 详情 =================
  function renderDetail(type, id) {
    var e = META.entities[type];
    api("/records/" + type + "/" + id).then(function (d) { paintDetail(e, type, d); }, fail);
  }

  function paintDetail(e, type, d) {
    var r = d.record, data = r.data, portal = isPortal();
    setTitle(e.label + " " + r.no);
    var html = '<div class="card"><div class="head"><div style="flex:1;min-width:240px"><div class="no">' + esc(r.no) + (r.version > 1 ? " · V" + r.version : "") + " · 创建于 " + esc(r.created_at) + '</div><div class="t">' + esc(r.title || e.label) + " " + badge(r.status, e) +
      (data.locked ? ' <span class="badge red">黑名单锁定</span>' : "") + "</div>";
    if (r.steps && r.steps.length && (r.status === "pending" || r.status === "approved")) {
      html += '<div class="steps">' + r.steps.map(function (s, i) {
        var cls = r.status === "approved" || i < r.step ? "done" : i === r.step && r.status === "pending" ? "cur" : "";
        return '<span class="' + cls + '">' + (i + 1) + ". " + esc(META.roles[s]) + "</span>";
      }).join("") + "</div>";
    }
    html += '</div><div class="btns" id="acts"></div></div></div>';
    if (e.help && !portal) html += '<div class="help">' + esc(e.help) + "</div>";

    // 合同执行概况
    if (d.extra && d.extra.executed) {
      var x = d.extra.executed;
      html += '<div class="card"><h3>执行概况<span class="sp"></span><a class="btn sm ghost" href="#/dossier/' + r.id + '">业务卷宗</a></h3><div class="kpis">' +
        [["合同数量", data.total_qty], ["已点价", x.fixed], ["提单", x.bl], ["到港", x.arrived], ["入库", x.received], ["出库", x.shipped], ["报关", x.declared], ["已匹配", x.matched], ["已开/收票", fmtNum(x.invoiced, 2)]].map(function (k) {
          return "<span>" + k[0] + " <b>" + (typeof k[1] === "number" ? fmtNum(k[1], 3) : esc(k[1] == null ? "-" : k[1])) + "</b></span>";
        }).join("") + "</div>" + (d.extra.credit.length ? '<div class="muted" style="margin-top:6px">额度占用:' + d.extra.credit.map(function (c) { return esc(c.label) + " " + fmtNum(c.remain, 2) + " 元"; }).join(";") + "</div>" : "") + "</div>";
    }

    html += '<div class="card"><h3>基本信息</h3><div class="grid">' + e.fields.filter(function (f) { return !f.hidden; }).map(function (f) {
      var v = data[f.key];
      if (portal && (v === null || v === undefined || v === "")) return "";
      return '<div class="fld' + (f.type === "textarea" || f.type === "changes" ? " wide" : "") + '"><label>' + esc(f.label) + '</label><div class="val">' + show(f, v, d.refs) + "</div></div>";
    }).join("") + "</div>" + (d.extra && d.extra.portalUser ? '<p class="muted">门户账号:' + esc(d.extra.portalUser) + "</p>" : "") + "</div>";

    (e.lines || []).forEach(function (ln) {
      var rows = data[ln.key] || [];
      var cols = ln.fields.filter(function (f) { return !f.hidden; });
      html += '<div class="card"><h3>' + esc(ln.label) + ' <span class="muted">(' + rows.length + ')</span></h3>' + (rows.length ? '<div class="tbl"><table><tr><th>#</th>' +
        cols.map(function (f) { return '<th class="' + (["money", "qty", "number", "percent"].indexOf(f.type) >= 0 ? "num" : "") + '">' + esc(f.label) + "</th>"; }).join("") + "</tr>" +
        rows.map(function (row, i) {
          return "<tr><td>" + (i + 1) + "</td>" + cols.map(function (f) {
            var cls = ["money", "qty", "number", "percent"].indexOf(f.type) >= 0 ? "num" : f.type === "textarea" ? "wrap" : "";
            var extra = ln.key === "clauses" && f.key === "content" && row.origin && String(row.origin).trim() !== String(row.content || "").trim() ? ' <span class="badge pending">已修改</span>' : "";
            return '<td class="' + cls + '">' + show(f, row[f.key], d.refs) + extra + "</td>";
          }).join("") + "</tr>";
        }).join("") + "</table></div>" : '<p class="muted">无</p>') + "</div>";
    });

    // 附件
    var cats = (e.attachments && e.attachments.categories) || ["其他"];
    var reqCats = (e.attachments && e.attachments.required) || [];
    html += '<div class="card"><h3>附件' + (reqCats.length ? ' <span class="muted small">必传:' + esc(reqCats.join("、")) + "</span>" : "") + '<span class="sp"></span>' +
      (r.status !== "cancelled" ? '<select id="upCat" style="border:1px solid var(--line);border-radius:6px;padding:3px 6px">' + cats.map(function (c) { return "<option>" + esc(c) + "</option>"; }).join("") +
        '</select><label class="btn sm ghost">上传文件<input type="file" id="upFile" hidden multiple></label>' : "") + "</h3>" +
      (d.attachments.length ? d.attachments.map(function (a) {
        return '<div class="att"><span class="badge">' + esc(a.category) + '</span><a href="' + BASE + "/attachments/" + a.id + '" target="_blank" rel="noopener">' + esc(a.filename) + '</a><span class="muted small">' +
          Math.ceil(a.size / 1024) + "KB · " + esc(a.uploader_name) + " · " + esc(a.created_at) + '</span><span style="flex:1"></span><a class="small" data-del-att="' + a.id + '">删除</a></div>';
      }).join("") : '<p class="muted">暂无附件</p>') + "</div>";

    // 关联单据
    d.related.forEach(function (rl) {
      if (!rl.count) return;
      html += '<div class="card"><h3>' + esc(rl.label) + ' <span class="muted">(' + rl.count + ")</span></h3>" + '<div class="tbl"><table>' + rl.items.map(function (it) {
        return '<tr class="click" data-href="#/r/' + rl.type + "/" + it.id + '"><td>' + esc(it.no) + '</td><td class="wrap">' + esc(it.title) + "</td><td>" + badge(it.status, META.entities[rl.type]) + "</td></tr>";
      }).join("") + "</table></div></div>";
    });

    // 操作记录
    html += '<div class="card"><h3>操作记录' + (d.versions.length > 1 ? '<span class="sp"></span><button class="btn sm ghost" id="cmpBtn">版本对比</button>' : "") + '</h3><ul class="timeline">' +
      d.logs.map(function (l) {
        return "<li><b>" + esc(l.action) + "</b> · " + esc(l.user_name) + ' <span class="muted small">' + esc(l.created_at) + "</span>" + (l.comment ? '<div class="muted">' + esc(l.comment) + "</div>" : "") +
          (l.diff && l.diff.length ? '<div class="diff">' + l.diff.map(function (df) { return esc(df.label) + ":" + esc(shortVal(df.from)) + " → " + esc(shortVal(df.to)); }).join("<br>") + "</div>" : "") + "</li>";
      }).join("") + "</ul></div>";

    view().innerHTML = html;
    bindHref(view());
    paintActions(e, type, d);

    var up = $("#upFile");
    if (up) up.onchange = function () {
      var files = Array.prototype.slice.call(up.files), cat = $("#upCat").value;
      if (!files.length) return;
      var chain = Promise.resolve();
      files.forEach(function (f) {
        chain = chain.then(function () {
          if (f.size > 30 * 1024 * 1024) throw new Error(f.name + " 超过 30MB");
          return fetch(BASE + "/records/" + type + "/" + r.id + "/attachments?category=" + encodeURIComponent(cat) + "&name=" + encodeURIComponent(f.name), { method: "POST", body: f, credentials: "same-origin" })
            .then(function (res) { return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || "上传失败"); }); });
        });
      });
      chain.then(function () { toast("已上传"); renderDetail(type, r.id); }, function (err) { fail(err); renderDetail(type, r.id); });
    };
    $$("[data-del-att]").forEach(function (a) {
      a.onclick = function () {
        if (!confirm("删除该附件?")) return;
        api("/attachments/" + a.getAttribute("data-del-att"), { method: "DELETE" }).then(function () { renderDetail(type, r.id); }, fail);
      };
    });
    var cmp = $("#cmpBtn");
    if (cmp) cmp.onclick = function () { compareVersions(e, type, r.id); };
  }
  function shortVal(v) {
    if (v === null || v === undefined) return "空";
    if (typeof v === "object") v = JSON.stringify(v);
    v = String(v);
    return v.length > 80 ? v.slice(0, 80) + "…" : v;
  }

  function paintActions(e, type, d) {
    var r = d.record, box = $("#acts");
    if (d.editable) box.appendChild(btnEl("编辑", "ghost", function () { go("#/edit/" + type + "/" + r.id); }));
    d.actions.forEach(function (a) {
      box.appendChild(btnEl(a.label, a.primary ? "" : a.danger ? "danger" : "ghost", function () { runAction(type, r, a); }));
    });
    if (d.pushdown && d.pushdown.length) {
      var dd = h('<div class="dropdown"><button class="btn ghost">下推生成 ▾</button><div class="menu" hidden>' + d.pushdown.map(function (t) {
        return '<a data-to="' + t + '">' + esc(META.entities[t].label) + "</a>";
      }).join("") + "</div></div>");
      $("button", dd).onclick = function (ev) { ev.stopPropagation(); $(".menu", dd).hidden = !$(".menu", dd).hidden; };
      $$("[data-to]", dd).forEach(function (a) { a.onclick = function () { go("#/new/" + a.getAttribute("data-to") + "?from=" + r.id); }; });
      document.addEventListener("click", function () { var m = $(".menu", dd); if (m) m.hidden = true; }, { once: true });
      box.appendChild(dd);
    }
    if (type === "partner" && !isPortal() && r.status !== "cancelled") {
      box.appendChild(btnEl("工商风险扫描", "ghost", function () {
        api("/lookup/scan/" + r.id, { body: {} }).then(function (x) {
          toast(x.events.length ? "发现 " + x.events.length + " 项风险,已生成风险预警" : "未发现异常");
          renderDetail(type, r.id);
        }, fail);
      }));
    }
    if (type === "partner" && !isPortal()) box.appendChild(btnEl("发起信息变更", "ghost", function () { go("#/new/partner_change?partner=" + r.id); }));
    if (type === "contract" && !isPortal()) box.appendChild(btnEl("打印", "plain", function () { window.print(); }));
    if (["draft", "rejected"].indexOf(r.status) >= 0 && r.created_by === ME.id && r.version === 1) {
      box.appendChild(btnEl("删除草稿", "danger", function () {
        if (!confirm("确定删除该草稿?")) return;
        api("/records/" + type + "/" + r.id, { method: "DELETE" }).then(function () { toast("已删除"); go("#/list/" + type); }, fail);
      }));
    }
  }
  function btnEl(label, cls, fn) { var b = h('<button class="btn ' + (cls || "") + '">' + esc(label) + "</button>"); b.onclick = fn; return b; }

  function runAction(type, r, a) {
    var needDialog = a.comment || (a.inputs && a.inputs.length) || a.confirm;
    function exec(payload) {
      return api("/records/" + type + "/" + r.id + "/actions/" + a.key, { body: payload }).then(function (d) {
        if (d.message) { if (/密码/.test(d.message)) alert(d.message); else toast(d.message); } else toast(a.label + "成功");
        refreshBell();
        if (d.record) paintDetail(META.entities[type], type, d); else go("#/list/" + type);
      });
    }
    if (!needDialog) { exec({}).catch(fail); return; }
    var m = modal("<h3>" + esc(a.label) + "</h3>" + (a.confirm ? '<p class="muted">' + esc(a.confirm) + "</p>" : "") + '<div id="ins"></div>' +
      (a.comment ? '<div class="fld"><label>' + esc(a.comment) + (a.commentRequired ? ' <span class="req" style="color:var(--danger)">*</span>' : "") + '</label><textarea id="cmt"></textarea></div>' : "") +
      '<div class="acts"><button class="btn plain" data-close>取消</button><button class="btn" id="ok">确定</button></div>');
    var ins = $("#ins", m);
    (a.inputs || []).forEach(function (fd) {
      var w = h('<div class="fld"><label>' + esc(fd.label) + (fd.required ? ' <span style="color:var(--danger)">*</span>' : "") + "</label></div>");
      w.appendChild(inputFor(fd, fd.type === "date" ? new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) : null, {}));
      ins.appendChild(w);
    });
    $("#ok", m).onclick = function () {
      var payload = {};
      $$("[data-key]", ins).forEach(function (el) { if (!el.closest(".refpick") || el.classList.contains("refpick")) payload[el.dataset.key] = readInput(el); });
      var miss = (a.inputs || []).filter(function (fd) { return fd.required && (payload[fd.key] === null || payload[fd.key] === ""); })[0];
      if (miss) return toast("请填写" + miss.label, true);
      if (a.comment) payload.comment = $("#cmt", m).value.trim();
      if (a.commentRequired && !payload.comment) return toast("请填写" + a.comment, true);
      var ok = this; ok.disabled = true;
      exec(payload).then(function () { m.remove(); }, function (err) { ok.disabled = false; fail(err); });
    };
  }

  function compareVersions(e, type, id) {
    api("/records/" + type + "/" + id + "/versions").then(function (d) {
      var vs = d.versions;
      var opts = vs.map(function (v) { return '<option value="' + v.version + '">V' + v.version + " · " + esc(v.created_at) + "</option>"; }).join("") + '<option value="cur">当前内容</option>';
      var m = modal('<h3>版本对比</h3><div class="toolbar"><select id="va">' + opts + '</select> 对比 <select id="vb">' + opts + '</select></div><div id="vd" class="tbl"></div><div class="acts"><button class="btn plain" data-close>关闭</button></div>', true);
      $("#va", m).value = String(vs[Math.max(0, vs.length - 2)].version);
      $("#vb", m).value = "cur";
      function paint() {
        var get = function (v) { return v === "cur" ? d.current : vs.filter(function (x) { return String(x.version) === v; })[0].data; };
        var a = get($("#va", m).value), b = get($("#vb", m).value);
        var rows = [];
        e.fields.forEach(function (f) { if (JSON.stringify(a[f.key] == null ? null : a[f.key]) !== JSON.stringify(b[f.key] == null ? null : b[f.key])) rows.push([f.label, shortVal(a[f.key]), shortVal(b[f.key])]); });
        (e.lines || []).forEach(function (ln) {
          var x = a[ln.key] || [], y = b[ln.key] || [];
          for (var i = 0; i < Math.max(x.length, y.length); i++) {
            ln.fields.forEach(function (f) {
              if (f.hidden) return;
              var p = x[i] ? x[i][f.key] : undefined, q = y[i] ? y[i][f.key] : undefined;
              if (JSON.stringify(p == null ? null : p) !== JSON.stringify(q == null ? null : q)) rows.push([ln.label + " 第" + (i + 1) + "行 · " + f.label, x[i] ? shortVal(p) : "(无此行)", y[i] ? shortVal(q) : "(已删除)"]);
            });
          }
        });
        $("#vd", m).innerHTML = rows.length ? '<table><tr><th>字段</th><th>旧值</th><th>新值</th></tr>' + rows.map(function (r) { return "<tr><td>" + esc(r[0]) + '</td><td class="wrap">' + esc(r[1]) + '</td><td class="wrap" style="color:var(--danger)">' + esc(r[2]) + "</td></tr>"; }).join("") + "</table>" : '<p class="muted">两个版本没有差异</p>';
      }
      $("#va", m).onchange = paint; $("#vb", m).onchange = paint; paint();
    }, fail);
  }

  // ================= 报表 =================
  function renderReport(name, qs) {
    var meta = META.reports[name];
    if (!meta) { view().innerHTML = "<p>报表不存在</p>"; return; }
    setTitle(meta.label);
    api("/reports/" + name + "?" + qs.toString()).then(function (d) {
      var params = d.params || [];
      var html = (d.note ? '<div class="help">' + esc(d.note) + "</div>" : "") + '<div class="card">' + (params.length ? '<div class="toolbar" id="rp"></div>' : "") +
        '<div class="toolbar"><span class="muted">共 ' + d.rows.length + ' 行</span><span style="flex:1"></span><button class="btn sm ghost" id="csv">导出 CSV</button></div><div class="tbl">' +
        (d.rows.length ? "<table><tr>" + d.columns.map(function (c) { return '<th class="' + (c.type ? "num" : "") + '">' + esc(c.label) + "</th>"; }).join("") + "</tr>" +
          d.rows.map(function (r) {
            return "<tr" + (r._link ? ' class="click" data-goto-row="' + r._link + '"' : "") + ">" + d.columns.map(function (c) {
              var v = r[c.key];
              return '<td class="' + (c.type ? "num" : "") + '">' + (c.type === "money" ? fmtNum(v, 2) : c.type === "qty" ? fmtNum(v, 3) : esc(v == null ? "" : v)) + "</td>";
            }).join("") + "</tr>";
          }).join("") + "</table>" : '<p class="muted">暂无数据</p>') + "</div></div>";
      view().innerHTML = html;
      var rp = $("#rp");
      params.forEach(function (pm) {
        var w = h('<label class="muted" style="display:flex;align-items:center;gap:4px">' + esc(pm.label) + "</label>");
        var el = inputFor({ key: pm.key, type: pm.type, ref: pm.ref, options: pm.options, label: pm.label }, qs.get(pm.key) || pm.value || null, {});
        w.appendChild(el); rp.appendChild(w);
      });
      if (rp) {
        var b = btnEl("查询", "plain", function () {
          var p = new URLSearchParams();
          $$("[data-key]", rp).forEach(function (el) { var v = readInput(el); if (v !== null && v !== "") p.set(el.dataset.key, v); });
          go("#/report/" + name + "?" + p);
        });
        rp.appendChild(b);
      }
      $$("[data-goto-row]").forEach(function (tr) { tr.onclick = function () { api("/goto/" + tr.getAttribute("data-goto-row")).then(function (g) { go("#/r/" + g.type + "/" + g.id); }, fail); }; });
      $("#csv").onclick = function () {
        var cell = function (v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; };
        var csv = "﻿" + [d.columns.map(function (c) { return cell(c.label); }).join(",")].concat(d.rows.map(function (r) { return d.columns.map(function (c) { return cell(r[c.key]); }).join(","); })).join("\r\n");
        var a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        a.download = meta.label + ".csv"; a.click();
      };
    }, fail);
  }

  // ================= 业务卷宗 =================
  function renderDossier(id) {
    api("/dossier/" + id).then(function (d) {
      var c = d.contract, x = d.executed;
      setTitle("业务卷宗 " + c.no);
      var html = '<div class="card"><h3>' + esc(c.no) + " " + esc(c.title) + " " + badge(c.status) + '<span class="sp"></span><a class="btn sm ghost" href="#/r/contract/' + c.id + '">查看合同</a>' +
        '<a class="btn sm" href="' + BASE + "/archive/" + c.id + '">附件归档下载(ZIP)</a></h3><div class="kpis">' +
        [["合同数量", c.data.total_qty], ["合同金额(元)", c.data.amount_cny], ["已点价", x.fixed], ["提单", x.bl], ["入库", x.received], ["出库", x.shipped], ["报关", x.declared], ["已开/收票", x.invoiced]].map(function (k) {
          return "<span>" + k[0] + " <b>" + fmtNum(k[1], 3) + "</b></span>";
        }).join("") + "</div></div>";
      Object.keys(d.groups).forEach(function (t) {
        html += '<div class="card"><h3>' + esc(META.entities[t].label) + ' <span class="muted">(' + d.groups[t].length + ')</span></h3><div class="tbl"><table>' + d.groups[t].map(function (it) {
          return '<tr class="click" data-href="#/r/' + t + "/" + it.id + '"><td>' + esc(it.no) + '</td><td class="wrap">' + esc(it.title) + "</td><td>" + badge(it.status, META.entities[t]) + "</td><td>" + esc(it.updated_at) + "</td></tr>";
        }).join("") + "</table></div></div>";
      });
      html += '<div class="card"><h3>全部附件(' + d.attachments.length + ")</h3>" + (d.attachments.length ? d.attachments.map(function (a) {
        return '<div class="att"><span class="badge">' + esc(META.entities[a.type].label) + '</span><span class="muted">' + esc(a.no) + '</span><span class="badge">' + esc(a.category) + '</span><a href="' + BASE + "/attachments/" + a.id + '" target="_blank" rel="noopener">' + esc(a.filename) + "</a></div>";
      }).join("") : '<p class="muted">暂无附件</p>') + "</div>";
      view().innerHTML = html;
      bindHref(view());
    }, fail);
  }

  // ================= 系统 =================
  function renderUsers() {
    setTitle("用户与角色");
    api("/users").then(function (d) {
      view().innerHTML = '<div class="help">内部员工账号在此创建并分配角色;外部客商的门户账号在客商档案上「开通门户账号」,或由客商在登录页自助注册。</div><div class="card"><div class="toolbar"><button class="btn" id="addU">+ 新建用户</button></div><div class="tbl"><table><tr><th>登录名</th><th>姓名</th><th>角色</th><th>部门</th><th>绑定客商</th><th>状态</th><th></th></tr>' +
        d.items.map(function (u) {
          return "<tr><td>" + esc(u.username) + "</td><td>" + esc(u.name) + "</td><td>" + u.roles.map(function (r) { return esc(META.roles[r]); }).join("、") + "</td><td>" + esc(u.dept) + "</td><td>" + esc(u.partner_name || "") + "</td><td>" + (u.enabled ? "启用" : '<span class="badge red">停用</span>') +
            '</td><td><button class="btn sm ghost" data-u="' + u.id + '">编辑</button></td></tr>';
        }).join("") + "</table></div></div>";
      $("#addU").onclick = function () { userDialog(null); };
      $$("[data-u]").forEach(function (b) { b.onclick = function () { userDialog(d.items.filter(function (u) { return String(u.id) === b.getAttribute("data-u"); })[0]); }; });
    }, fail);
  }
  function userDialog(u) {
    var portalUser = u && u.roles.indexOf("portal") >= 0;
    var roles = Object.keys(META.roles).filter(function (r) { return r !== "portal"; });
    var m = modal("<h3>" + (u ? "编辑用户 " + esc(u.username) : "新建用户") + "</h3>" +
      (u ? "" : '<div class="fld"><label>登录名</label><input id="uu"></div>') + '<div class="fld"><label>姓名</label><input id="un" value="' + esc(u ? u.name : "") + '"></div>' +
      (portalUser ? '<p class="muted">门户账号(' + esc(u.partner_name || "") + ")</p>" : '<div class="fld"><label>角色</label><div class="checks">' + roles.map(function (r) { return '<label><input type="checkbox" value="' + r + '"' + (u && u.roles.indexOf(r) >= 0 ? " checked" : "") + ">" + esc(META.roles[r]) + "</label>"; }).join("") + "</div></div>" +
        '<div class="fld"><label>部门</label><select id="ud"><option value=""></option>' + META.settings.depts.map(function (x) { return "<option" + (u && u.dept === x ? " selected" : "") + ">" + esc(x) + "</option>"; }).join("") + "</select></div>") +
      '<div class="fld"><label>' + (u ? "重置密码(不改留空)" : "初始密码(至少 8 位)") + '</label><input id="up" type="text" autocomplete="new-password"></div>' +
      (u ? '<div class="fld"><label><input type="checkbox" id="ue"' + (u.enabled ? " checked" : "") + ' style="width:auto"> 启用</label></div>' : "") +
      '<div class="acts"><button class="btn plain" data-close>取消</button><button class="btn" id="us">保存</button></div>');
    $("#us", m).onclick = function () {
      var body = { name: $("#un", m).value.trim(), password: $("#up", m).value, roles: $$(".checks input:checked", m).map(function (x) { return x.value; }), dept: $("#ud", m) ? $("#ud", m).value : "" };
      if (u) { body.enabled = $("#ue", m).checked; if (portalUser) body.roles = ["portal"]; } else body.username = $("#uu", m).value.trim();
      if (u && !body.password) delete body.password;
      api(u ? "/users/" + u.id : "/users", { method: u ? "PUT" : "POST", body: body }).then(function () { m.remove(); toast("已保存"); renderUsers(); }, fail);
    };
  }

  function renderSettings() {
    setTitle("系统设置");
    api("/settings").then(function (d) {
      var s = d.settings;
      var rules = { creditCode: "统一社会信用代码", name: "企业名称", bankAccount: "收款账号", phone: "联系电话" };
      var attTypes = Object.keys(META.entities).filter(function (t) { return META.entities[t].attachments; });
      view().innerHTML = '<div class="card"><div class="grid">' +
        '<div class="fld"><label>公司名称</label><input id="s_company" value="' + esc(s.companyName) + '"></div>' +
        '<div class="fld"><label>签约主体/组织(逗号分隔,用于跨境联动)</label><input id="s_orgs" value="' + esc(s.orgs.join(",")) + '"></div>' +
        '<div class="fld"><label>事业部(逗号分隔)</label><input id="s_depts" value="' + esc(s.depts.join(",")) + '"></div>' +
        '<div class="fld"><label>默认资金占用日利率</label><input id="s_rate" type="number" step="any" value="' + esc(s.defaultDailyRate) + '"></div>' +
        '<div class="fld"><label>追保阈值(缺口超过多少元才追保)</label><input id="s_th" type="number" step="any" value="' + esc(s.marginCallThreshold) + '"></div>' +
        '<div class="fld wide"><label>客户查重标准(新建客商时任一项相同即判为重复)</label><div class="checks">' + Object.keys(rules).map(function (k) { return '<label><input type="checkbox" class="s_rule" value="' + k + '"' + (s.dedupRules.indexOf(k) >= 0 ? " checked" : "") + ">" + rules[k] + "</label>"; }).join("") + "</div></div>" +
        '</div></div><div class="card"><h3>必传附件配置</h3><p class="muted">勾选的附件类别在提交审批前必须上传。</p><div class="tbl"><table>' + attTypes.map(function (t) {
          var e = META.entities[t], cur = s.requiredAttachments[t] || e.attachments.required || [];
          return "<tr><td>" + esc(e.label) + '</td><td class="wrap"><div class="checks" data-att="' + t + '">' + e.attachments.categories.map(function (c) { return '<label><input type="checkbox" value="' + esc(c) + '"' + (cur.indexOf(c) >= 0 ? " checked" : "") + ">" + esc(c) + "</label>"; }).join("") + "</div></td></tr>";
        }).join("") + '</table></div></div><div class="card"><button class="btn" id="ss">保存设置</button></div>';
      $("#ss").onclick = function () {
        var ra = {};
        $$("[data-att]").forEach(function (el) { ra[el.getAttribute("data-att")] = $$("input:checked", el).map(function (x) { return x.value; }); });
        api("/settings", { method: "PUT", body: { settings: {
          companyName: $("#s_company").value, orgs: $("#s_orgs").value, depts: $("#s_depts").value, defaultDailyRate: Number($("#s_rate").value), marginCallThreshold: Number($("#s_th").value),
          dedupRules: $$(".s_rule:checked").map(function (x) { return x.value; }), requiredAttachments: ra } } })
          .then(function () { toast("已保存"); return api("/meta"); }).then(function (m) { META = m; renderShell(); route(); }, fail);
      };
    }, fail);
  }

  function renderImport() {
    setTitle("批量导入");
    view().innerHTML = '<div class="card"><div class="toolbar"><select id="it"><option value="blacklist">黑名单</option><option value="market_price">市场行情</option></select></div>' +
      '<p class="muted" id="ih"></p><textarea id="ix" style="width:100%;min-height:240px;border:1px solid var(--line);border-radius:6px;padding:8px"></textarea>' +
      '<div class="btns" style="margin-top:10px"><button class="btn" id="ig">导入</button></div><div id="ir" style="margin-top:10px"></div></div>';
    function hint() {
      $("#ih").textContent = $("#it").value === "blacklist" ? "每行一条:企业名称,统一社会信用代码,原因,来源(集团下发/外部数据/内部认定)。可直接从 Excel 复制粘贴。导入后自动比对并锁定命中的客商。"
        : "每行一条:品种,日期(YYYY-MM-DD),类型(期货/现货/指数),价格,期货合约,来源。导入后自动检查保证金追保。";
    }
    $("#it").onchange = hint; hint();
    $("#ig").onclick = function () {
      api("/import", { body: { type: $("#it").value, text: $("#ix").value } }).then(function (d) {
        $("#ir").innerHTML = "<p>成功导入 " + d.ok + " 条</p>" + (d.errors.length ? '<div class="muted">' + d.errors.map(esc).join("<br>") + "</div>" : "");
      }, fail);
    };
  }

  function renderPassword() {
    setTitle("修改密码");
    view().innerHTML = '<div class="card" style="max-width:420px"><div class="fld"><label>原密码</label><input id="po" type="password"></div><div class="fld" style="margin-top:8px"><label>新密码(至少 8 位)</label><input id="pn" type="password"></div>' +
      '<div class="btns" style="margin-top:12px"><button class="btn" id="pg">修改</button></div></div>';
    $("#pg").onclick = function () { api("/password", { body: { old: $("#po").value, new: $("#pn").value } }).then(function () { toast("密码已修改"); }, fail); };
  }

  // 新建客商变更时带入客商
  var origRenderForm = renderForm;
  renderForm = function (type, id, qs) {
    if (type === "partner_change" && !id && qs.get("partner")) {
      return api("/records/partner/" + qs.get("partner")).then(function (d) {
        var refs = {}; refs[d.record.id] = { label: d.record.data.name };
        paintForm(META.entities.partner_change, type, null, { data: {} }, { partner: d.record.id }, refs, qs);
      }, fail);
    }
    return origRenderForm(type, id, qs);
  };

  boot();
})();
