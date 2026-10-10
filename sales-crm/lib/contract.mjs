// 合同模板:正文为 HTML,用 {{占位符}} 标记要填的字段;生成合同时按商机/合同/我方信息渲染。
import { amountToChinese, escapeHtml, formatMoney } from "./util.mjs";

export const PLACEHOLDERS = [
  { key: "合同编号", desc: "系统自动生成,如 HT20261010001" },
  { key: "项目名称", desc: "合同中的项目名称" },
  { key: "甲方名称", desc: "客户企业名称(来自商机)" },
  { key: "甲方信用代码", desc: "客户统一社会信用代码" },
  { key: "甲方法定代表人", desc: "客户法定代表人" },
  { key: "甲方地址", desc: "客户注册地址" },
  { key: "甲方联系人", desc: "商机联系人" },
  { key: "甲方电话", desc: "商机联系电话" },
  { key: "乙方名称", desc: "我方公司名称(在「我方信息」中设置)" },
  { key: "乙方信用代码", desc: "我方统一社会信用代码" },
  { key: "乙方地址", desc: "我方地址" },
  { key: "乙方联系人", desc: "我方联系人" },
  { key: "乙方电话", desc: "我方电话" },
  { key: "乙方开户行", desc: "我方开户银行" },
  { key: "乙方账号", desc: "我方银行账号" },
  { key: "合同金额", desc: "小写金额,如 128,000.00" },
  { key: "合同金额大写", desc: "大写金额,如 壹拾贰万捌仟元整" },
  { key: "签订日期", desc: "合同签订日期" },
  { key: "服务开始日期", desc: "服务期开始" },
  { key: "服务结束日期", desc: "服务期结束" },
  { key: "付款方式", desc: "付款条款" },
  { key: "模块清单", desc: "自动生成的模块明细表格" },
  { key: "补充条款", desc: "本合同的补充约定" },
];

export const DEFAULT_TEMPLATE_HTML = `<h1 style="text-align:center">{{项目名称}} 销售合同</h1>
<p style="text-align:right">合同编号:{{合同编号}}</p>

<table class="parties">
  <tr><td width="50%"><b>甲方(买方):</b>{{甲方名称}}</td><td><b>乙方(卖方):</b>{{乙方名称}}</td></tr>
  <tr><td>统一社会信用代码:{{甲方信用代码}}</td><td>统一社会信用代码:{{乙方信用代码}}</td></tr>
  <tr><td>法定代表人:{{甲方法定代表人}}</td><td>联系人:{{乙方联系人}}</td></tr>
  <tr><td>联系人:{{甲方联系人}}</td><td>联系电话:{{乙方电话}}</td></tr>
  <tr><td>联系电话:{{甲方电话}}</td><td>地址:{{乙方地址}}</td></tr>
  <tr><td>地址:{{甲方地址}}</td><td></td></tr>
</table>

<p>甲乙双方本着平等互利、诚实信用的原则,经友好协商,就甲方向乙方采购「{{项目名称}}」相关产品及服务事宜,达成如下协议,共同遵守。</p>

<h3>第一条 合同标的</h3>
<p>乙方向甲方提供以下产品模块及相应服务:</p>
{{模块清单}}

<h3>第二条 合同金额</h3>
<p>本合同总金额为人民币 <b>{{合同金额}}</b> 元(大写:<b>{{合同金额大写}}</b>),含税。</p>

<h3>第三条 付款方式</h3>
<p>{{付款方式}}</p>
<p>乙方收款账户:开户行 {{乙方开户行}},账号 {{乙方账号}},户名 {{乙方名称}}。</p>

<h3>第四条 服务期限</h3>
<p>服务期自 {{服务开始日期}} 起至 {{服务结束日期}} 止。</p>

<h3>第五条 双方权利与义务</h3>
<p>1. 乙方应按约定交付合同标的,并提供必要的安装、培训及技术支持服务。</p>
<p>2. 甲方应按约定及时支付合同款项,并为乙方实施工作提供必要的配合与条件。</p>
<p>3. 双方对在合作过程中知悉的对方商业秘密负有保密义务,保密期限不因本合同终止而终止。</p>

<h3>第六条 验收</h3>
<p>乙方完成交付后通知甲方验收,甲方应在收到通知后 7 个工作日内完成验收;逾期未提出书面异议的,视为验收合格。</p>

<h3>第七条 违约责任</h3>
<p>任何一方违反本合同约定,应承担相应违约责任,并赔偿由此给对方造成的直接经济损失。</p>

<h3>第八条 争议解决</h3>
<p>因本合同引起的争议,双方应友好协商解决;协商不成的,任何一方均可向乙方所在地人民法院提起诉讼。</p>

<h3>第九条 补充条款</h3>
<p>{{补充条款}}</p>

<h3>第十条 其他</h3>
<p>本合同一式贰份,甲乙双方各执壹份,具有同等法律效力,自双方签字盖章之日起生效。</p>

<table class="sign">
  <tr><td width="50%">甲方(盖章):{{甲方名称}}</td><td>乙方(盖章):{{乙方名称}}</td></tr>
  <tr><td>授权代表(签字):</td><td>授权代表(签字):</td></tr>
  <tr><td>日期:{{签订日期}}</td><td>日期:{{签订日期}}</td></tr>
</table>`;

function modulesTable(modules) {
  if (!modules.length) return "<p>(无)</p>";
  const rows = modules
    .map(
      (m, i) =>
        `<tr><td style="text-align:center">${i + 1}</td><td>${escapeHtml(m.name)}</td><td>${escapeHtml(m.description)}</td><td style="text-align:right">${m.amount === "" || m.amount == null ? "" : formatMoney(m.amount)}</td></tr>`
    )
    .join("");
  return `<table class="modules" border="1" cellspacing="0" cellpadding="6" width="100%"><tr><th width="8%">序号</th><th width="25%">模块名称</th><th>功能说明</th><th width="18%">金额(元)</th></tr>${rows}</table>`;
}

// 文本字段保留换行
function text(v) {
  return escapeHtml(v ?? "").replace(/\n/g, "<br/>");
}

export function renderContract(templateBody, { contractNo, contract, opportunity, company }) {
  const values = {
    合同编号: text(contractNo),
    项目名称: text(contract.project_name),
    甲方名称: text(opportunity.name),
    甲方信用代码: text(opportunity.credit_code),
    甲方法定代表人: text(opportunity.legal_person),
    甲方地址: text(opportunity.address),
    甲方联系人: text(opportunity.contact_name),
    甲方电话: text(opportunity.contact_phone),
    乙方名称: text(company.name),
    乙方信用代码: text(company.credit_code),
    乙方地址: text(company.address),
    乙方联系人: text(company.contact),
    乙方电话: text(company.phone),
    乙方开户行: text(company.bank_name),
    乙方账号: text(company.bank_account),
    合同金额: formatMoney(contract.amount),
    合同金额大写: amountToChinese(contract.amount),
    签订日期: text(contract.sign_date),
    服务开始日期: text(contract.start_date),
    服务结束日期: text(contract.end_date),
    付款方式: text(contract.payment_terms),
    模块清单: modulesTable(contract.modules),
    补充条款: text(contract.extra_terms || "无"),
  };
  return templateBody.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (all, key) => (key in values ? values[key] : all));
}
