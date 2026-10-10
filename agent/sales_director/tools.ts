// 数字销售总监的工具:只读查询销售管理服务(sales-crm)的统计数据。
// 凭内部令牌访问,令牌在平台 .env 的 CRM_INTERNAL_TOKEN(由 kmst/deploy/deploy.sh 生成)。
const CRM = "http://127.0.0.1:3100/sales-api/agent/sales";

const PERIOD = {
  type: "string",
  enum: ["week", "last_week", "month", "last_month", "quarter", "year", "all", "custom"],
  description: "统计区间:本周/上周/本月/上月/本季度/本年/全部/自定义(custom 时填 from、to);不填默认本月",
};

export const tools = [
  {
    name: "get_sales_stats",
    description: "按销售人员统计商机数量、跟进次数、成交率、签约与收款金额。问到销售业绩、排名、谁跟进得少、回款情况时调用。",
    parameters: {
      type: "object",
      properties: {
        period: PERIOD,
        from: { type: "string", description: "自定义开始日期 YYYY-MM-DD" },
        to: { type: "string", description: "自定义结束日期 YYYY-MM-DD" },
      },
    },
  },
  {
    name: "get_salesperson_detail",
    description: "查询某位销售的明细:名下商机(阶段、跟进次数、未跟进天数、签约与收款)、区间内的跟进记录原文、收款记录。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "销售姓名(商机负责人),先用 get_sales_stats 查到准确姓名" },
        period: PERIOD,
        from: { type: "string", description: "自定义开始日期 YYYY-MM-DD" },
        to: { type: "string", description: "自定义结束日期 YYYY-MM-DD" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_sales_alerts",
    description: "查询当前的销售风险:久未跟进的商机、下次跟进已逾期的商机、签约后应收未收的合同。",
    parameters: { type: "object", properties: {} },
  },
];

async function get(path: string) {
  const token = process.env.CRM_INTERNAL_TOKEN;
  if (!token) return { error: "数字销售总监还没接通销售数据(缺少 CRM_INTERNAL_TOKEN),请告诉用户联系管理员重新部署" };
  try {
    const res = await fetch(`${CRM}${path}`, { headers: { "x-crm-internal": token }, signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (!res.ok) return { error: `查询失败:${data?.error ?? res.status},请告诉用户稍后再试` };
    return data;
  } catch {
    return { error: "销售管理服务暂时连不上,请告诉用户稍后再试" };
  }
}

function query(args: Record<string, any>, keys: string[]) {
  const q = new URLSearchParams();
  for (const k of keys) if (args[k]) q.set(k, String(args[k]));
  return q.toString();
}

export async function executeTool(name: string, args: Record<string, any>, ctx: any): Promise<string | object> {
  if (name === "get_sales_stats") return get(`/stats?${query(args, ["period", "from", "to"])}`);
  if (name === "get_salesperson_detail") return get(`/person?${query(args, ["name", "period", "from", "to"])}`);
  if (name === "get_sales_alerts") return get("/alerts");
  return { error: `未知工具 ${name}` };
}
