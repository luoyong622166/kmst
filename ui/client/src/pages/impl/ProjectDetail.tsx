/**
 * 实施管理 · 项目实施
 * 路由: /impl/projects/:id
 * 四个阶段(前期准备 → 蓝图设计 → 项目上线 → 验收交付):选阶段 → 填写工作汇报 + 上传阶段文档;
 * 汇报提交后由「实施管理数字总监」按公司项目管理规范自动审核,申请阶段完成且审核通过时进入下一阶段。
 */
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { crm } from "@/lib/crmApi";
import { fileUrl, uploadFile, type ImplDelay, type ImplProjectDetail, type ImplReport } from "@/lib/implApi";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, Check, Download, FileText, Loader2, RotateCcw, Send, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { Field, fmtMoney, today } from "../crm/shared";
import {
  DeadlineBadge,
  DELAY_STATUS,
  fmtSize,
  hasRole,
  PROJECT_STATUS,
  ProgressBar,
  ReviewBadge,
  SEVERITY_CLASS,
  stageName,
  Tag,
  useImplMeta,
} from "./shared";

const STAGE_HINT: Record<string, string> = {
  prepare: "项目启动会、组建双方项目组、确认实施范围与计划、收集基础资料……",
  blueprint: "业务调研、现状与需求分析、蓝图方案设计与客户确认……",
  golive: "系统配置与开发、数据准备与导入、用户培训、上线切换与保障……",
  acceptance: "上线后运行支持、问题收口、验收材料整理、客户签署验收……",
};

function ReportForm({ project, stageKey }: { project: ImplProjectDetail; stageKey: string }) {
  const qc = useQueryClient();
  const stage = project.stages.find(s => s.stage_key === stageKey)!;
  const blank = { report_date: today(), progress: stage.progress, work_content: "", completed_items: "", problems: "", next_plan: "", request_complete: false };
  const [form, setForm] = useState(blank);
  useEffect(() => setForm({ ...blank, progress: stage.progress }), [stageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<typeof form>) => setForm(f => ({ ...f, ...patch }));
  const submit = useMutation({
    mutationFn: () => crm(`/impl/projects/${project.id}/reports`, { method: "POST", body: { ...form, stage_key: stageKey } }),
    onSuccess: () => {
      toast.success("汇报已提交,数字总监正在审核(约 30 秒)");
      setForm({ ...blank, progress: form.request_complete ? 100 : form.progress });
      qc.invalidateQueries({ queryKey: ["crm", "impl"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const stageFiles = project.files.filter(f => f.stage_key === stageKey);
  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="font-medium">填写「{stageName(stageKey)}」工作汇报</div>
      <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-3 items-end">
        <Field label="汇报日期" required>
          <Input type="date" value={form.report_date} onChange={e => set({ report_date: e.target.value })} />
        </Field>
        <Field label={`本阶段进度:${form.request_complete ? 100 : form.progress}%`}>
          <Slider value={[form.request_complete ? 100 : form.progress]} min={0} max={100} step={5} onValueChange={v => set({ progress: v[0] })} disabled={form.request_complete} />
        </Field>
      </div>
      <Field label="本阶段工作内容" required>
        <Textarea rows={4} value={form.work_content} onChange={e => set({ work_content: e.target.value })} placeholder={STAGE_HINT[stageKey]} />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="已完成事项 / 交付成果">
          <Textarea rows={3} value={form.completed_items} onChange={e => set({ completed_items: e.target.value })} placeholder="逐条列出,写清交付物名称" />
        </Field>
        <Field label="存在问题与风险">
          <Textarea rows={3} value={form.problems} onChange={e => set({ problems: e.target.value })} placeholder="问题、影响、需要谁配合、应对措施" />
        </Field>
      </div>
      <Field label="下一步计划">
        <Textarea rows={2} value={form.next_plan} onChange={e => set({ next_plan: e.target.value })} />
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={form.request_complete} onCheckedChange={v => set({ request_complete: !!v })} className="mt-0.5" />
        <span>
          申请「{stageName(stageKey)}」阶段完成
          <span className="block text-xs text-muted-foreground">
            数字总监审核通过后进入下一阶段。请先在「阶段文档」上传本阶段交付物(当前已上传 {stageFiles.length} 份)
          </span>
        </span>
      </label>
      <div className="flex justify-end">
        <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
          {submit.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
          提交汇报
        </Button>
      </div>
    </div>
  );
}

function ReportItem({ r, isDirector }: { r: ImplReport; isDirector: boolean }) {
  const qc = useQueryClient();
  const [manual, setManual] = useState<null | boolean>(null);
  const [note, setNote] = useState("");
  const retry = useMutation({
    mutationFn: () => crm(`/impl/reports/${r.id}/retry-review`, { method: "POST", body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["crm", "impl"] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const manualReview = useMutation({
    mutationFn: () => crm(`/impl/reports/${r.id}/manual-review`, { method: "POST", body: { passed: manual, summary: note } }),
    onSuccess: () => {
      toast.success("已人工审核");
      setManual(null);
      qc.invalidateQueries({ queryKey: ["crm", "impl"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{r.report_date}</span>
        <span className="text-muted-foreground">进度 {r.progress}%</span>
        {!!r.request_complete && <Badge variant="outline">申请阶段完成</Badge>}
        <span className="text-muted-foreground">· {r.created_by}</span>
        <span className="ml-auto">
          <ReviewBadge status={r.review_status} score={r.review_score} />
        </span>
      </div>
      <div className="text-sm whitespace-pre-wrap">{r.work_content}</div>
      {r.completed_items && <div className="text-sm whitespace-pre-wrap"><span className="text-muted-foreground">已完成:</span>{r.completed_items}</div>}
      {r.problems && <div className="text-sm whitespace-pre-wrap"><span className="text-muted-foreground">问题:</span>{r.problems}</div>}
      {r.next_plan && <div className="text-sm whitespace-pre-wrap"><span className="text-muted-foreground">下一步:</span>{r.next_plan}</div>}
      {r.review_status !== "pending" && r.review_summary && (
        <div className={cn("rounded p-2.5 text-sm space-y-1.5", r.review_status === "passed" ? "bg-emerald-50" : r.review_status === "failed" ? "bg-red-50" : "bg-muted")}>
          <div className="flex items-center gap-1.5 font-medium">
            <Bot className="h-4 w-4" />
            {r.reviewed_by}:{r.review_summary}
          </div>
          {r.review_issues.map((i, n) => (
            <div key={n} className="pl-5 text-sm">
              <Badge variant="outline" className={cn("mr-1.5 font-normal", SEVERITY_CLASS[i.severity])}>
                {i.severity}
              </Badge>
              {i.problem}
              {i.norm && <span className="text-muted-foreground">(依据:{i.norm})</span>}
              {i.suggestion && <div className="text-xs text-muted-foreground mt-0.5">整改建议:{i.suggestion}</div>}
            </div>
          ))}
        </div>
      )}
      {(r.review_status === "error" || (isDirector && r.review_status !== "passed" && r.review_status !== "pending")) && (
        <div className="flex flex-wrap gap-2">
          {r.review_status === "error" && (
            <Button size="sm" variant="outline" onClick={() => retry.mutate()} disabled={retry.isPending}>
              <RotateCcw className="h-3.5 w-3.5 mr-1" />
              重新审核
            </Button>
          )}
          {isDirector && (
            <>
              <Button size="sm" variant="outline" onClick={() => setManual(true)}>
                人工审核通过
              </Button>
              {r.review_status === "error" && (
                <Button size="sm" variant="outline" onClick={() => setManual(false)}>
                  人工判定不通过
                </Button>
              )}
            </>
          )}
        </div>
      )}
      <Dialog open={manual !== null} onOpenChange={v => !v && setManual(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{manual ? "人工审核通过" : "人工判定不通过"}</DialogTitle>
          </DialogHeader>
          <Field label={manual ? "审核意见" : "不通过的问题"} required>
            <Textarea rows={3} value={note} onChange={e => setNote(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button onClick={() => manualReview.mutate()} disabled={manualReview.isPending || !note.trim()}>
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StageFiles({ project, stageKey }: { project: ImplProjectDetail; stageKey: string }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const files = project.files.filter(f => f.stage_key === stageKey);
  const remove = useMutation({
    mutationFn: (id: number) => crm(`/impl/files/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["crm", "impl", "project", project.id] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const onPick = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(list)) {
        if (f.size > 50 * 1024 * 1024) {
          toast.error(`${f.name} 超过 50MB`);
          continue;
        }
        await uploadFile(`/impl/projects/${project.id}/files`, f, { stage: stageKey });
      }
      toast.success("上传完成");
      qc.invalidateQueries({ queryKey: ["crm", "impl", "project", project.id] });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };
  return (
    <div className="space-y-3">
      {project.canWrite && (
        <div className="flex items-center gap-3">
          <input ref={inputRef} type="file" multiple className="hidden" onChange={e => onPick(e.target.files)} />
          <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
            上传「{stageName(stageKey)}」文档
          </Button>
          <span className="text-xs text-muted-foreground">单个文件不超过 50MB;Word(.docx)/文本文档的内容会提供给数字总监审核</span>
        </div>
      )}
      {!files.length ? (
        <div className="text-sm text-muted-foreground py-6 text-center">本阶段还没有上传文档</div>
      ) : (
        <div className="divide-y rounded-md border">
          {files.map(f => (
            <div key={f.id} className="flex items-center gap-3 p-2.5 text-sm">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="flex-1 truncate">{f.filename}</span>
              <span className="text-xs text-muted-foreground">{fmtSize(f.size)}</span>
              <span className="text-xs text-muted-foreground w-36 text-right">
                {f.uploaded_by} · {new Date(f.created_at).toLocaleDateString("zh-CN")}
              </span>
              <a href={fileUrl(f.id)} className="inline-flex">
                <Button variant="ghost" size="icon">
                  <Download className="h-4 w-4" />
                </Button>
              </a>
              {project.canWrite && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (window.confirm(`删除 ${f.filename}?`)) remove.mutate(f.id);
                  }}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DelayCard({ d, canWrite, isDirector }: { d: ImplDelay; canWrite: boolean; isDirector: boolean }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ plan_reason: "", plan_new_date: "", plan_measures: "" });
  const [note, setNote] = useState("");
  const submit = useMutation({
    mutationFn: () => crm(`/impl/delays/${d.id}/plan`, { method: "POST", body: form }),
    onSuccess: () => {
      toast.success("延期方案已提交,等待实施总监审批");
      qc.invalidateQueries({ queryKey: ["crm", "impl"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const decide = useMutation({
    mutationFn: (approve: boolean) => crm(`/impl/delays/${d.id}/decide`, { method: "POST", body: { approve, note } }),
    onSuccess: () => {
      toast.success("已处理");
      qc.invalidateQueries({ queryKey: ["crm", "impl"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const needPlan = ["awaiting_plan", "rejected"].includes(d.status);
  return (
    <div className={cn("rounded-md border p-3 space-y-2 text-sm", needPlan && "border-red-200 bg-red-50/40")}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {d.stage_label}要求 {d.due_date} 完成
          {["awaiting_plan", "submitted", "rejected"].includes(d.status) && <span className="text-red-600">,已超期 {d.overdue_days} 天</span>}
        </span>
        <Tag map={DELAY_STATUS} value={d.status} />
      </div>
      {d.plan_reason && (
        <div className="space-y-1 text-muted-foreground">
          <div>延期原因:{d.plan_reason}</div>
          <div>预计完成:{d.plan_new_date}</div>
          <div>补救措施:{d.plan_measures}</div>
        </div>
      )}
      {d.decision_note && (
        <div className="text-muted-foreground">
          审批意见({d.decided_by}):{d.decision_note}
        </div>
      )}
      {needPlan && canWrite && (
        <div className="space-y-2 pt-1">
          <Textarea rows={2} placeholder="延期原因" value={form.plan_reason} onChange={e => setForm({ ...form, plan_reason: e.target.value })} />
          <div className="flex items-center gap-2">
            <span className="shrink-0">预计完成日期</span>
            <Input type="date" value={form.plan_new_date} onChange={e => setForm({ ...form, plan_new_date: e.target.value })} />
          </div>
          <Textarea rows={2} placeholder="补救措施(加派人手、调整计划、需要客户配合的事项……)" value={form.plan_measures} onChange={e => setForm({ ...form, plan_measures: e.target.value })} />
          <Button size="sm" onClick={() => submit.mutate()} disabled={submit.isPending}>
            提交延期方案
          </Button>
        </div>
      )}
      {d.status === "submitted" && isDirector && (
        <div className="space-y-2 pt-1">
          <Input placeholder="审批意见(可选)" value={note} onChange={e => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => decide.mutate(true)} disabled={decide.isPending}>
              批准延期
            </Button>
            <Button size="sm" variant="outline" onClick={() => decide.mutate(false)} disabled={decide.isPending}>
              驳回
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ImplProjectDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { data: meta } = useImplMeta();
  const isDirector = hasRole(meta, "director");
  const { data: p, error } = useQuery({
    queryKey: ["crm", "impl", "project", id],
    queryFn: () => crm<ImplProjectDetail>(`/impl/projects/${id}`),
    // 有汇报在审核时自动刷新结果
    refetchInterval: q => ((q.state.data as ImplProjectDetail | undefined)?.reports.some(r => r.review_status === "pending") ? 5000 : false),
  });
  const [stageKey, setStageKey] = useState<string | null>(null);
  useEffect(() => {
    if (p && !stageKey) setStageKey(p.current_stage ?? p.stages[p.stages.length - 1].stage_key);
  }, [p, stageKey]);
  const accept = useMutation({
    mutationFn: () => crm(`/impl/projects/${id}/accept`, { method: "POST", body: {} }),
    onSuccess: () => {
      toast.success("已接收项目,进入「前期准备」阶段");
      qc.invalidateQueries({ queryKey: ["crm", "impl"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const resolve = useMutation({
    mutationFn: (issueId: number) => crm(`/impl/issues/${issueId}/resolve`, { method: "POST", body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["crm", "impl"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  if (error) {
    return (
      <DashboardLayout>
        <div className="py-20 text-center text-muted-foreground">{(error as Error).message}</div>
      </DashboardLayout>
    );
  }
  if (!p || !stageKey) {
    return (
      <DashboardLayout>
        <div className="py-20 text-center">
          <Loader2 className="h-6 w-6 animate-spin inline" />
        </div>
      </DashboardLayout>
    );
  }

  const stage = p.stages.find(s => s.stage_key === stageKey)!;
  const stageReports = p.reports.filter(r => r.stage_key === stageKey);
  const openDelays = p.delays.filter(d => ["awaiting_plan", "submitted", "rejected"].includes(d.status));
  const openIssues = p.issues.filter(i => i.status === "open");
  const todayStr = today();

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <button type="button" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center" onClick={() => window.history.length > 1 ? window.history.back() : navigate("/impl/my")}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          返回
        </button>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              {p.name}
              <Tag map={PROJECT_STATUS} value={p.status} />
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {p.customer_name} · {p.project_no} · 实施顾问 {p.consultant_name} · 计划 {p.planned_start} 至 <b className="text-foreground">{p.planned_end}</b>
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-48">
              <ProgressBar value={p.progress} danger={p.overdue_days > 0} />
            </div>
            <DeadlineBadge p={p} />
            {p.status === "assigned" && p.canWrite && (
              <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
                <Check className="h-4 w-4 mr-2" />
                接收项目
              </Button>
            )}
          </div>
        </div>

        {/* 阶段步骤条 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {p.stages.map((s, i) => {
            const overdue = s.status !== "done" && s.planned_end < todayStr && p.status === "in_progress";
            return (
              <button
                key={s.stage_key}
                type="button"
                onClick={() => setStageKey(s.stage_key)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors",
                  stageKey === s.stage_key ? "border-primary ring-1 ring-primary bg-primary/5" : "hover:bg-accent",
                  overdue && "border-red-300"
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium",
                      s.status === "done" ? "bg-primary text-primary-foreground" : s.status === "in_progress" ? "border-2 border-primary text-primary" : "bg-muted text-muted-foreground"
                    )}
                  >
                    {s.status === "done" ? <Check className="h-3.5 w-3.5" /> : i + 1}
                  </span>
                  <span className="font-medium">{stageName(s.stage_key)}</span>
                </div>
                <div className={cn("text-xs mt-1.5", overdue ? "text-red-600" : "text-muted-foreground")}>
                  要求 {s.planned_end} 完成{overdue ? " · 已超期" : ""}
                </div>
                <div className="text-xs text-muted-foreground">
                  {s.status === "done" ? `已完成 ${s.completed_at ? new Date(s.completed_at).toLocaleDateString("zh-CN") : ""}` : s.status === "in_progress" ? `进行中 ${s.progress}%` : "未开始"}
                </div>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{stageName(stageKey)}</CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="reports">
                <TabsList>
                  <TabsTrigger value="reports">工作汇报({stageReports.length})</TabsTrigger>
                  <TabsTrigger value="files">阶段文档({p.files.filter(f => f.stage_key === stageKey).length})</TabsTrigger>
                </TabsList>
                <TabsContent value="reports" className="mt-3 space-y-3">
                  {p.canWrite && p.status === "in_progress" && stage.status === "in_progress" && <ReportForm project={p} stageKey={stageKey} />}
                  {p.status === "assigned" && <div className="text-sm text-muted-foreground">项目接收后开始填写汇报</div>}
                  {stage.status === "pending" && p.status === "in_progress" && <div className="text-sm text-muted-foreground">完成前面的阶段后才能汇报本阶段</div>}
                  {stageReports.map(r => (
                    <ReportItem key={r.id} r={r} isDirector={isDirector} />
                  ))}
                  {!stageReports.length && stage.status !== "pending" && <div className="text-sm text-muted-foreground">本阶段还没有汇报</div>}
                </TabsContent>
                <TabsContent value="files" className="mt-3">
                  <StageFiles project={p} stageKey={stageKey} />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          <div className="space-y-4">
            {!!p.delays.length && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">延期记录{openDelays.length ? `(待处理 ${openDelays.length})` : ""}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {p.delays.map(d => (
                    <DelayCard key={d.id} d={d} canWrite={p.canWrite} isDirector={isDirector} />
                  ))}
                </CardContent>
              </Card>
            )}
            {!!openIssues.length && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">待整改问题({openIssues.length})</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {openIssues.map(i => (
                    <div key={i.id} className="rounded-md border p-2.5 text-sm space-y-1">
                      <div>
                        <Badge variant="outline" className={cn("mr-1.5 font-normal", SEVERITY_CLASS[i.severity])}>
                          {i.severity}
                        </Badge>
                        <span className="text-muted-foreground">[{stageName(i.stage_key)}]</span> {i.problem}
                      </div>
                      {i.suggestion && <div className="text-xs text-muted-foreground">建议:{i.suggestion}</div>}
                      {p.canWrite && (
                        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => resolve.mutate(i.id)}>
                          <Check className="h-3.5 w-3.5 mr-1" />
                          已整改
                        </Button>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
            {p.handover && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">销售交接信息</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="text-muted-foreground">
                    交接单 {p.handover.handover_no} · 合同 {p.handover.contract_no} · {fmtMoney(p.handover.amount)} · 销售 {p.handover.sales_name}
                  </div>
                  <div className="text-muted-foreground">
                    客户联系人:{p.handover.contact_name || "-"} {p.handover.contact_phone}
                  </div>
                  {!!p.handover.modules.length && (
                    <div>
                      <div className="font-medium">模块信息</div>
                      <ul className="list-disc pl-5">
                        {p.handover.modules.map((m, n) => (
                          <li key={n}>
                            {m.name}
                            {m.description ? `:${m.description}` : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div>
                    <div className="font-medium">主要需求</div>
                    <div className="whitespace-pre-wrap text-muted-foreground">{p.handover.main_requirements}</div>
                  </div>
                  <div>
                    <div className="font-medium">交接价值点</div>
                    <div className="whitespace-pre-wrap text-muted-foreground">{p.handover.value_points}</div>
                  </div>
                  <div>
                    <div className="font-medium">风险点</div>
                    <div className="whitespace-pre-wrap text-muted-foreground">{p.handover.risk_points}</div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
