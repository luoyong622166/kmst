/**
 * 销售管理(独立服务 sales-crm)接口封装。
 * nginx 把 /sales-api/ 转发到 sales-crm,登录态沿用后台 Cookie,无需额外鉴权。
 */

export type Stage = { key: string; label: string };

export type CrmMeta = {
  user: { id: number; name: string; role: string };
  stages: Stage[];
  followStages: Stage[];
  lookupProvider: "tianyancha" | "qichacha" | null;
  placeholders: { key: string; desc: string }[];
};

export type CompanyInfo = {
  name: string;
  creditCode: string;
  legalPerson: string;
  regStatus: string;
  regCapital: string;
  establishDate: string;
  address: string;
  businessScope: string;
  industry: string;
  existing?: { id: number; name: string; owner: string | null } | null;
};

export type Opportunity = {
  id: number;
  credit_code: string;
  name: string;
  legal_person: string | null;
  reg_status: string | null;
  reg_capital: string | null;
  establish_date: string | null;
  address: string | null;
  business_scope: string | null;
  industry: string | null;
  info_source: string;
  contact_name: string | null;
  contact_title: string | null;
  contact_phone: string | null;
  lead_source: string | null;
  owner: string | null;
  stage: string;
  expected_amount: number | null;
  expected_close: string | null;
  remark: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  followup_count?: number;
  last_follow_date?: string | null;
  followups?: Followup[];
  contracts?: Pick<Contract, "id" | "contract_no" | "project_name" | "amount" | "status" | "sign_date">[];
};

export type Followup = {
  id: number;
  opportunity_id: number;
  opportunity_name?: string;
  stage: string;
  follow_date: string;
  method: string | null;
  contact_name: string | null;
  content: string;
  next_plan: string | null;
  next_date: string | null;
  created_by: string | null;
  created_at: string;
};

export type ContractModule = { name: string; description: string; amount?: number | string };

export type Contract = {
  id: number;
  contract_no: string;
  opportunity_id: number;
  template_id: number | null;
  customer_name?: string;
  project_name: string;
  amount: number;
  sign_date: string | null;
  start_date: string | null;
  end_date: string | null;
  payment_terms: string | null;
  modules: ContractModule[];
  extra_terms: string | null;
  content: string;
  status: "draft" | "signed" | "void";
  created_by: string | null;
  created_at: string;
  handover_id?: number | null;
  handover_status?: string | null;
  handover?: { id: number; handover_no: string; status: string } | null;
  opportunity?: Pick<Opportunity, "id" | "name" | "credit_code" | "contact_name" | "contact_phone" | "owner" | "stage">;
};

export type ContractTemplate = {
  id: number;
  name: string;
  body: string;
  is_default: number;
  updated_by: string | null;
  updated_at: string;
};

export type CompanySettings = {
  name: string;
  credit_code: string;
  address: string;
  contact: string;
  phone: string;
  bank_name: string;
  bank_account: string;
};

export type Handover = {
  id: number;
  handover_no: string;
  contract_id: number;
  contract_no: string;
  project_name: string;
  amount: number;
  sign_date: string | null;
  start_date: string | null;
  end_date: string | null;
  opportunity_id: number;
  customer_name: string;
  contact_name: string | null;
  contact_phone: string | null;
  sales_owner: string | null;
  modules: ContractModule[];
  main_requirements: string;
  value_points: string;
  risk_points: string;
  impl_owner: string | null;
  handover_date: string;
  remark: string | null;
  status: "pending" | "received";
  received_by: string | null;
  received_at: string | null;
  received_note: string | null;
  created_by: string | null;
  created_at: string;
};

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };

export async function crm<T = unknown>(
  path: string,
  opts: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(`/sales-api${path}`, {
    method: opts.method ?? "GET",
    credentials: "same-origin",
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `请求失败(${res.status})`);
  return data as T;
}

export function qs(params: Record<string, string | number | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}
