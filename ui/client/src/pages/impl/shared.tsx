/**
 * 实施管理公共组件:元数据/角色、状态徽标、进度条、阶段日期、通知面板
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { crm } from "@/lib/crmApi";
import type { ImplMeta, ImplNotification, ImplProject, ImplRole } from "@/lib/implApi";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bell, CheckCircle2, Clock, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { useLocation } from "wouter";

export function useImplMeta() {
  return useQuery({ queryKey: ["crm", "impl", "meta"], queryFn: () => crm<ImplMeta>("/impl/meta"), staleTime: 60_000 });
}

export function hasRole(meta: ImplMeta | undefined, ...roles: ImplRole[]) {
  return !!meta && roles.some(r => meta.roles.includes(r));
}

export const IMPL_STAGE_LABEL: Record<string, string> = {
  prepare: "前期准备",
  blueprint: "蓝图设计",
  golive: "项目上线",
  acceptance: "验收交付",
};
export const stageName = (k: string | null | undefined) => (k ? IMPL_STAGE_LABEL[k] ?? k : "项目整体");

export const PROJECT_STATUS: Record<string, { label: string; className: string }> = {
  assigned: { label: "待接收", className: "bg-sky-50 text-sky-700 border-sky-200" },
  in_progress: { label: "实施中", className: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  completed: { label: "已完成", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
};

export const DELAY_STATUS: Record<string, { label: string; className: string }> = {
  awaiting_plan: { label: "待提交延期方案", className: "bg-red-50 text-red-700 border-red-200" },
  submitted: { label: "方案待审批", className: "bg-amber-50 text-amber-700 border-amber-200" },
  approved: { label: "已批准延期", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  rejected: { label: "方案被驳回", className: "bg-red-50 text-red-700 border-red-200" },
  resolved: { label: "已完成", className: "bg-zinc-100 text-zinc-500 border-zinc-200" },
};

export function Tag({ map, value }: { map: Record<string, { label: string; className: string }>; value: string }) {
  const s = map[value] ?? { label: value, className: "" };
  return (
    <Badge variant="outline" className={cn("font-normal", s.className)}>
      {s.label}
    </Badge>
  );
}

/** 超期/剩余天数提示 */
export function DeadlineBadge({ p }: { p: Pick<ImplProject, "status" | "overdue_days" | "stage_overdue_days" | "days_left" | "current_stage"> }) {
  if (p.status === "completed") return <span className="text-xs text-muted-foreground">已完成</span>;
  if (p.overdue_days > 0)
    return (
      <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 font-normal">
        <AlertTriangle className="h-3 w-3 mr-1" />
        项目超期 {p.overdue_days} 天
      </Badge>
    );
  if (p.stage_overdue_days > 0)
    return (
      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 font-normal">
        <Clock className="h-3 w-3 mr-1" />
        {stageName(p.current_stage)}超期 {p.stage_overdue_days} 天
      </Badge>
    );
  if (p.days_left !== null && p.days_left <= 7)
    return (
      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 font-normal">
        剩 {p.days_left} 天
      </Badge>
    );
  return <span className="text-xs text-muted-foreground">剩 {p.days_left} 天</span>;
}

export function ProgressBar({ value, danger }: { value: number; danger?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", danger ? "bg-red-500" : "bg-primary")} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="text-xs tabular-nums w-9 text-right">{value}%</span>
    </div>
  );
}

export function ReviewBadge({ status, score }: { status: string; score?: number | null }) {
  if (status === "pending")
    return (
      <Badge variant="outline" className="bg-sky-50 text-sky-700 border-sky-200 font-normal">
        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
        数字总监审核中
      </Badge>
    );
  if (status === "passed")
    return (
      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 font-normal">
        <CheckCircle2 className="h-3 w-3 mr-1" />
        审核通过{score != null ? ` · ${score}分` : ""}
      </Badge>
    );
  if (status === "failed")
    return (
      <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 font-normal">
        <XCircle className="h-3 w-3 mr-1" />
        审核不通过{score != null ? ` · ${score}分` : ""}
      </Badge>
    );
  return (
    <Badge variant="outline" className="bg-zinc-100 text-zinc-600 border-zinc-200 font-normal">
      审核出错
    </Badge>
  );
}

export const SEVERITY_CLASS: Record<string, string> = {
  高: "bg-red-50 text-red-700 border-red-200",
  中: "bg-amber-50 text-amber-700 border-amber-200",
  低: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

export function NoAccess({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-2">
      <ShieldAlert className="h-10 w-10" />
      <div>{text}</div>
      <div className="text-xs">如需开通,请联系实施总监在「项目分配 → 团队成员」中设置你的角色</div>
    </div>
  );
}

function addDays(d: string, n: number) {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** 按开始/结束日期均分四个阶段的要求完成日期 */
export function splitStageDue(start: string, end: string): Record<string, string> {
  const total = Math.max(4, Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000));
  const weights = [0.15, 0.3, 0.3, 0.25]; // 前期准备 / 蓝图设计 / 项目上线 / 验收交付
  const keys = Object.keys(IMPL_STAGE_LABEL);
  let acc = 0;
  const out: Record<string, string> = {};
  keys.forEach((k, i) => {
    acc += weights[i];
    out[k] = i === keys.length - 1 ? end : addDays(start, Math.round(total * acc));
  });
  return out;
}

export function StageDueEditor({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {Object.entries(IMPL_STAGE_LABEL).map(([k, label], i) => (
        <div key={k} className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            {i + 1}. {label}
          </Label>
          <Input type="date" value={value[k] ?? ""} onChange={e => onChange({ ...value, [k]: e.target.value })} />
        </div>
      ))}
    </div>
  );
}

/** 未读通知面板(延期提醒、审核结果、分配通知等) */
export function NotificationPanel() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { data } = useQuery({
    queryKey: ["crm", "impl", "notifications"],
    queryFn: () => crm<{ items: ImplNotification[] }>("/impl/notifications?unread=1"),
    refetchInterval: 60_000,
  });
  const read = useMutation({
    mutationFn: (ids?: number[]) => crm("/impl/notifications/read", { method: "POST", body: { ids } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["crm", "impl", "notifications"] }),
  });
  const items = data?.items ?? [];
  if (!items.length) return null;
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="font-medium flex items-center gap-2 text-amber-900">
          <Bell className="h-4 w-4" />
          待处理消息({items.length})
        </div>
        <Button variant="ghost" size="sm" onClick={() => read.mutate(undefined)}>
          全部标为已读
        </Button>
      </div>
      <div className="space-y-1.5 max-h-64 overflow-y-auto">
        {items.map(n => (
          <button
            key={n.id}
            type="button"
            className="w-full text-left rounded bg-background border p-2 hover:bg-accent"
            onClick={() => {
              read.mutate([n.id]);
              if (n.link) navigate(n.link);
            }}
          >
            <div className={cn("text-sm font-medium", n.type === "delay_reminder" || n.type === "review_failed" ? "text-red-700" : "")}>{n.title}</div>
            {n.content && <div className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-3 mt-0.5">{n.content}</div>}
            <div className="text-[11px] text-muted-foreground mt-1">{new Date(n.created_at).toLocaleString("zh-CN", { hour12: false })}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
