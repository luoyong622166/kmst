// 电子培训合同:付款成功时用当时的学员信息、课程价格、合同条款渲染成 HTML 快照存库。
import { esc, rmbUpper, yuan } from "./util.mjs";
import { PAY_MODES } from "./db.mjs";

const PAY_LABEL = { mock: "在线支付", offline: "线下缴费" };

export function termVars(r, s) {
  return {
    学校名称: s.schoolName,
    学员姓名: r.name,
    课程名称: r.course_name,
    准驾车型: r.license_class,
    金额: yuan(r.price_fen),
    金额大写: rmbUpper(r.price_fen),
    付款时间: r.paid_at || "付款完成时",
    合同编号: r.contract_no || "付款后生成",
  };
}

// 条款模板:每行一段,「第X条」开头的行作为小标题,{{变量}} 替换为实际值
export function renderTerms(terms, vars) {
  return String(terms)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const h = esc(line).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, k) => (k in vars ? `<u>${esc(vars[k])}</u>` : m));
      return /^第[一二三四五六七八九十百零]+条/.test(line) ? `<h3>${h}</h3>` : `<p>${h}</p>`;
    })
    .join("\n");
}

function sealSvg(name) {
  const len = [...name].length || 1;
  const fs = Math.min(26, Math.max(14, Math.floor(280 / len)));
  const adjust = len * fs < 290 ? "spacing" : "spacingAndGlyphs";
  const star = Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? 10 : 25, a = -Math.PI / 2 + (i * Math.PI) / 5;
    return `${(100 + r * Math.cos(a)).toFixed(1)},${(100 + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
  return `<svg class="seal" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-label="${esc(name)} 合同专用章">
  <defs><path id="sealArc" d="M 37.6 136 A 72 72 0 1 1 162.4 136"/></defs>
  <circle cx="100" cy="100" r="93" fill="none" stroke="#d1202a" stroke-width="5"/>
  <text fill="#d1202a" font-size="${fs}" font-weight="bold"><textPath href="#sealArc" startOffset="50%" text-anchor="middle" textLength="290" lengthAdjust="${adjust}">${esc(name)}</textPath></text>
  <polygon points="${star}" fill="#d1202a"/>
  <text x="100" y="158" fill="#d1202a" font-size="17" text-anchor="middle" font-weight="bold">合同专用章</text>
</svg>`;
}

export function renderContract(r, s) {
  const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const payDesc = r.pay_method === "mock" ? `${PAY_LABEL.mock}(${esc(PAY_MODES.mock)})` : PAY_LABEL[r.pay_method] || esc(r.pay_method);
  const date = esc((r.paid_at || "").slice(0, 10));
  return `<article class="contract">
<h1>机动车驾驶培训合同</h1>
<div class="contract-no">合同编号:${esc(r.contract_no)}</div>
<table class="parties">
${row("甲方(培训机构)", esc(s.schoolName))}
${s.schoolAddress ? row("甲方地址", esc(s.schoolAddress)) : ""}
${s.schoolPhone ? row("甲方电话", esc(s.schoolPhone)) : ""}
${row("乙方(学员)", esc(r.name))}
${row("性别 / 出生日期", `${esc(r.gender)} / ${esc(r.birth_date)}`)}
${row("身份证号", esc(r.id_card))}
${row("手机号", esc(r.phone))}
${row("住址", esc(r.address))}
${row("报名课程", `${esc(r.course_name)}(${esc(r.license_class)})`)}
${row("培训费用", `¥${yuan(r.price_fen)}(${rmbUpper(r.price_fen)})`)}
${row("付款信息", `${payDesc} · 流水号 ${esc(r.pay_no)} · ${esc(r.paid_at)}`)}
</table>
<section class="terms">
${renderTerms(s.contractTerms, termVars(r, s))}
</section>
<div class="signs">
  <div class="sign-box">
    <div>甲方(盖章):${esc(s.schoolName)}</div>
    ${sealSvg(s.schoolName)}
    <div>日期:${date}</div>
  </div>
  <div class="sign-box">
    <div>乙方(签名):</div>
    <img class="signature" src="${esc(r.signature)}" alt="${esc(r.name)} 的手写签名">
    <div>日期:${date}</div>
  </div>
</div>
</article>`;
}

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#eef1f5;color:#1a1a1a;font:15px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.bar{position:sticky;top:0;display:flex;gap:8px;justify-content:center;padding:10px 16px;background:#fff;border-bottom:1px solid #e3e6eb;z-index:2}
.bar button,.bar a{border:0;border-radius:8px;padding:8px 18px;font-size:14px;background:#1d6fe0;color:#fff;cursor:pointer;text-decoration:none}
.bar a{background:#f1f3f6;color:#333}
.contract{max-width:820px;margin:16px auto;padding:40px 48px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h1{text-align:center;font-size:24px;letter-spacing:4px;margin:0 0 6px}
.contract-no{text-align:right;color:#555;font-size:13px;margin-bottom:14px}
.parties{width:100%;border-collapse:collapse;margin-bottom:18px;font-size:14px}
.parties th,.parties td{border:1px solid #cfd4db;padding:6px 10px;text-align:left;vertical-align:top}
.parties th{width:9em;background:#f6f7f9;font-weight:600;white-space:nowrap}
.terms h3{font-size:15px;margin:14px 0 4px}
.terms p{margin:0 0 4px;text-indent:2em}
.terms u{text-decoration:none;border-bottom:1px solid #333;padding:0 2px}
.signs{display:flex;gap:24px;margin-top:36px}
.sign-box{flex:1;position:relative;min-height:170px}
.seal{position:absolute;left:30px;top:-6px;width:150px;height:150px;opacity:.85;mix-blend-mode:multiply}
.signature{display:block;max-width:220px;height:90px;object-fit:contain;margin:6px 0}
.sign-box>div:last-child{position:absolute;bottom:0}
@media (max-width:600px){.contract{margin:0;padding:22px 16px;box-shadow:none}.signs{flex-direction:column}.parties th{width:6.5em;white-space:normal}}
@media print{body{background:#fff}.bar{display:none}.contract{margin:0;box-shadow:none;padding:0}}
`;

export function renderContractPage(fragment, title) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="bar"><button type="button" onclick="window.print()">打印 / 保存为 PDF</button><a href="/driving/">返回报名首页</a></div>
${fragment}</body></html>`;
}

export function renderMessagePage(title, msg) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}
.msg{max-width:420px;margin:80px auto;padding:32px 24px;background:#fff;border-radius:12px;text-align:center}</style></head>
<body><div class="msg"><h2>${esc(title)}</h2><p>${esc(msg)}</p><p><a href="/driving/">返回报名首页</a></p></div></body></html>`;
}
