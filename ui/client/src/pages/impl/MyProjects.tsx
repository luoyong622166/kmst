/**
 * 实施管理 · 我的项目(实施顾问)
 * 路由: /impl/my
 * 实施顾问看到分配给自己的全部项目:进度、当前阶段、要求完成时间、是否超期;顶部是延期提醒等待处理消息。
 */
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { crm } from "@/lib/crmApi";
import type { ImplProject } from "@/lib/implApi";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, FileWarning, Loader2 } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { FilterChips, PageHeader } from "../crm/shared";
import { DeadlineBadge, hasRole, NoAccess, NotificationPanel, PROJECT_STATUS, ProgressBar, stageName, Tag, useImplMeta } from "./shared";

function ProjectCard({ p, showConsultant }: { p: ImplProject; showConsultant: boolean }) {
  const [, navigate] = useLocation();
  const danger = p.overdue_days > 0 || p.stage_overdue_days > 0;
  return (
    <Card
      className={cn("cursor-pointer transition-shadow hover:shadow-md", danger && "border-red-200")}
      onClick={() => navigate(`/impl/projects/${p.id}`)}
    >
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-semibold truncate">{p.name}</div>
            <div className="text-xs text-muted-foreground truncate">
              {p.customer_name} · {p.project_no}
              {showConsultant ? ` · ${p.consultant_name}` : ""}
            </div>
          </div>
          <Tag map={PROJECT_STATUS} value={p.status} />
        </div>
        <ProgressBar value={p.progress} danger={p.overdue_days > 0} />
        <div className="flex gap-1">
          {p.stages.map(s => (
            <div key={s.stage_key} className="flex-1 min-w-0">
              <div
                className={cn(
                  "h-1.5 rounded-full",
                  s.status === "done" ? "bg-primary" : s.status === "in_progress" ? "bg-primary/40" : "bg-muted"
                )}
              />
              <div className={cn("text-[11px] mt-1 truncate", s.status === "in_progress" ? "text-foreground font-medium" : "text-muted-foreground")}>
                {stageName(s.stage_key)}
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">
            要求完成 <span className="text-foreground">{p.planned_end}</span>
            {p.current_stage && (
              <>
                {" "}· 本阶段截止 <span className="text-foreground">{p.current_stage_due}</span>
              </>
            )}
          </span>
          <DeadlineBadge p={p} />
        </div>
        {(p.status === "assigned" || p.open_delays > 0 || p.open_issues > 0 || p.last_review_status === "failed") && (
          <div className="flex flex-wrap gap-2 text-xs">
            {p.status === "assigned" && <span className="rounded bg-sky-50 text-sky-700 px-2 py-0.5">新分配,待你接收</span>}
            {p.open_delays > 0 && (
              <span className="rounded bg-red-50 text-red-700 px-2 py-0.5 inline-flex items-center">
                <AlertTriangle className="h-3 w-3 mr-1" />
                延期待处理 {p.open_delays}
              </span>
            )}
            {p.open_issues > 0 && (
              <span className="rounded bg-amber-50 text-amber-700 px-2 py-0.5 inline-flex items-center">
                <FileWarning className="h-3 w-3 mr-1" />
                待整改问题 {p.open_issues}
              </span>
            )}
            {p.last_review_status === "failed" && <span className="rounded bg-red-50 text-red-700 px-2 py-0.5">最近汇报审核不通过</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ImplMyProjects() {
  const { data: meta } = useImplMeta();
  const canSeeAll = hasRole(meta, "director", "gm");
  const [all, setAll] = useState(false);
  const [status, setStatus] = useState("active");
  const { data, isLoading } = useQuery({
    queryKey: ["crm", "impl", "projects", all ? "all" : "mine"],
    queryFn: () => crm<{ items: ImplProject[] }>(`/impl/projects?scope=${all ? "all" : "mine"}`),
    enabled: !!meta,
  });
  const items = (data?.items ?? []).filter(p =>
    status === "all" ? true : status === "active" ? p.status !== "completed" : status === "overdue" ? p.overdue_days > 0 || p.stage_overdue_days > 0 : p.status === status
  );
  const count = (fn: (p: ImplProject) => boolean) => (data?.items ?? []).filter(fn).length;

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <PageHeader
          title="我的项目"
          description="分配给你的实施项目、进度与期限;超期项目请及时提交延期方案"
          action={
            canSeeAll && (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={all} onCheckedChange={setAll} />
                查看全部顾问的项目
              </label>
            )
          }
        />
        {meta && !meta.roles.length ? (
          <NoAccess text="你还不是实施团队成员" />
        ) : (
          <>
            <NotificationPanel />
            <FilterChips
              value={status}
              onChange={setStatus}
              options={[
                { value: "active", label: "进行中", count: count(p => p.status !== "completed") },
                { value: "assigned", label: "待接收", count: count(p => p.status === "assigned") },
                { value: "overdue", label: "超期", count: count(p => p.overdue_days > 0 || p.stage_overdue_days > 0) },
                { value: "completed", label: "已完成", count: count(p => p.status === "completed") },
                { value: "all", label: "全部", count: data?.items.length ?? 0 },
              ]}
            />
            {isLoading ? (
              <div className="py-16 text-center">
                <Loader2 className="h-6 w-6 animate-spin inline" />
              </div>
            ) : !items.length ? (
              <div className="py-16 text-center text-muted-foreground">暂无项目</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {items.map(p => (
                  <ProjectCard key={p.id} p={p} showConsultant={all} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
