// 实施管理数字总监的工具:只读查询销售/实施管理服务(sales-crm)的项目数据。
// 凭内部令牌访问,令牌在平台 .env 的 CRM_INTERNAL_TOKEN(由 kmst/deploy/deploy.sh 生成)。
const CRM = "http://127.0.0.1:3100/sales-api/agent";

export const tools = [
  {
    name: "list_impl_projects",
    description: "查询实施项目列表(含进度、当前阶段、是否超期、延期与问题数)。问到项目概况、谁的项目、哪些超期时调用。",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["assigned", "in_progress", "completed"], description: "assigned 待接收 / in_progress 实施中 / completed 已完成;不填查全部" },
        keyword: { type: "string", description: "按项目名、客户、实施顾问、项目编号筛选" },
      },
    },
  },
  {
    name: "get_impl_project",
    description: "查询单个实施项目详情:各阶段计划与状态、最近汇报及审核结论、待整改问题、延期记录。",
    parameters: {
      type: "object",
      properties: { id: { type: "number", description: "项目 id(先用 list_impl_projects 查到)" } },
      required: ["id"],
    },
  },
  {
    name: "list_open_issues",
    description: "查询所有待整改的实施问题(审核不通过时发现的问题)。",
    parameters: { type: "object", properties: {} },
  },
];

async function get(path: string) {
  const token = process.env.CRM_INTERNAL_TOKEN;
  if (!token) return { error: "数字总监还没接通实施管理数据(缺少 CRM_INTERNAL_TOKEN),请告诉用户联系管理员重新部署" };
  try {
    const res = await fetch(`${CRM}${path}`, { headers: { "x-crm-internal": token }, signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (!res.ok) return { error: `查询失败:${data?.error ?? res.status},请告诉用户稍后再试` };
    return data;
  } catch {
    return { error: "实施管理服务暂时连不上,请告诉用户稍后再试" };
  }
}

export async function executeTool(name: string, args: Record<string, any>, ctx: any): Promise<string | object> {
  if (name === "list_impl_projects") {
    const q = new URLSearchParams();
    if (args.status) q.set("status", String(args.status));
    if (args.keyword) q.set("keyword", String(args.keyword));
    return get(`/projects?${q}`);
  }
  if (name === "get_impl_project") return get(`/projects/${Number(args.id)}`);
  if (name === "list_open_issues") return get("/issues");
  return { error: `未知工具 ${name}` };
}
