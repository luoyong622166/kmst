/**
 * 实施管理接口类型(服务同 sales-crm,请求用 crmApi 的 crm())
 */
import type { ContractModule, Stage } from "./crmApi";

export type ImplRole = "admin" | "director" | "consultant" | "gm";

export type ImplMeta = {
  me: { id: number; name: string };
  roles: ImplRole[];
  stages: Stage[];
  directorName: string;
  agentReady: boolean;
  lastPatrol: string | null;
};

export type ImplStage = {
  id: number;
  stage_key: string;
  seq: number;
  planned_end: string;
  status: "pending" | "in_progress" | "done";
  progress: number;
  started_at: string | null;
  completed_at: string | null;
};

export type ImplProject = {
  id: number;
  project_no: string;
  handover_id: number;
  name: string;
  customer_name: string;
  consultant_id: number;
  consultant_name: string;
  assigned_by: string | null;
  planned_start: string;
  planned_end: string;
  status: "assigned" | "in_progress" | "completed";
  remark: string | null;
  assigned_at: string;
  accepted_at: string | null;
  completed_at: string | null;
  stages: ImplStage[];
  progress: number;
  current_stage: string | null;
  current_stage_due: string | null;
  days_left: number | null;
  overdue_days: number;
  stage_overdue_days: number;
  open_delays: number;
  open_issues: number;
  last_report_date: string | null;
  last_review_status: string | null;
};

export type ReviewIssue = { problem: string; norm: string; suggestion: string; severity: "高" | "中" | "低" };

export type ImplReport = {
  id: number;
  project_id: number;
  stage_key: string;
  report_date: string;
  progress: number;
  work_content: string;
  completed_items: string | null;
  problems: string | null;
  next_plan: string | null;
  request_complete: number;
  created_by: string | null;
  created_at: string;
  review_status: "pending" | "passed" | "failed" | "error";
  review_score: number | null;
  review_summary: string | null;
  review_issues: ReviewIssue[];
  reviewed_by: string | null;
  reviewed_at: string | null;
  project_name?: string;
  customer_name?: string;
};

export type ImplFile = { id: number; stage_key: string | null; filename: string; size: number; uploaded_by: string | null; created_at: string };

export type ImplDelay = {
  id: number;
  project_id: number;
  stage_key: string | null;
  stage_label: string;
  due_date: string;
  overdue_days: number;
  detected_at: string;
  status: "awaiting_plan" | "submitted" | "approved" | "rejected" | "resolved";
  plan_reason: string | null;
  plan_new_date: string | null;
  plan_measures: string | null;
  submitted_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  project: { name: string; customer_name: string; consultant_name: string; consultant_id: number };
};

export type ImplIssue = {
  id: number;
  project_id: number;
  stage_key: string | null;
  report_id: number | null;
  problem: string;
  norm: string | null;
  suggestion: string | null;
  severity: "高" | "中" | "低";
  status: "open" | "resolved";
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  project_name?: string;
  customer_name?: string;
  consultant_name?: string;
};

export type ImplProjectDetail = ImplProject & {
  handover: {
    handover_no: string;
    modules: ContractModule[];
    main_requirements: string;
    value_points: string;
    risk_points: string;
    remark: string | null;
    sales_name: string | null;
    contract_no: string;
    amount: number;
    start_date: string | null;
    end_date: string | null;
    contact_name: string | null;
    contact_phone: string | null;
  } | null;
  reports: ImplReport[];
  files: ImplFile[];
  delays: ImplDelay[];
  issues: ImplIssue[];
  canWrite: boolean;
};

export type ImplNotification = {
  id: number;
  type: string;
  title: string;
  content: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

export type ImplMember = { user_id: number; name: string; role: "director" | "consultant" | "gm"; created_at: string };

export type HandoverToAssign = {
  id: number;
  handover_no: string;
  status: string;
  handover_date: string;
  impl_owner: string | null;
  modules: ContractModule[];
  contract_no: string;
  project_name: string;
  amount: number;
  start_date: string | null;
  end_date: string | null;
  customer_name: string;
};

export type IssueListItem = {
  project_id: number;
  project_no: string;
  name: string;
  customer_name: string;
  consultant_name: string;
  planned_end: string;
  issues: (Pick<ImplIssue, "id" | "stage_key" | "problem" | "norm" | "suggestion" | "severity" | "created_at">)[];
  delays: { id: number; stage_key: string | null; due_date: string; status: string; plan_reason: string | null; plan_new_date: string | null; overdue_days: number }[];
};

export type IssueList = {
  id: number;
  list_date: string;
  summary: string;
  read_at: string | null;
  updated_at: string;
  content?: { generated_at: string; generated_by: string; items: IssueListItem[] };
};

/** 上传文件(原始字节,文件名放查询参数) */
export async function uploadFile(path: string, file: File, params: Record<string, string> = {}) {
  const q = new URLSearchParams({ ...params, name: file.name });
  const res = await fetch(`/sales-api${path}?${q}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `上传失败(${res.status})`);
  return data;
}

export function fileUrl(id: number) {
  return `/sales-api/impl/files/${id}`;
}
