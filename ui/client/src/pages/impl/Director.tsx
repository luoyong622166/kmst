/**
 * 实施管理 · 实施管理数字总监
 * 路由: /impl/director
 * 数字员工工作台:自动巡检超期并发延期提醒、按项目管理规范审核汇报、生成问题清单提交总经理;
 * 实施总监在此审批延期方案、维护公司项目管理规范,也可以直接向数字总监提问。
 */
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { crm } from "@/lib/crmApi";
import { fileUrl, uploadFile, type ImplDelay, type ImplProject, type ImplReport } from "@/lib/implApi";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, ClipboardList, Download, Loader2, Radar, Save, Send, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { fmtTime } from "../crm/shared";
import { DeadlineBadge, fmtSize, hasRole, NoAccess, NotificationPanel, ProgressBar, ReviewBadge, SEVERITY_CLASS, stageName, useImplMeta } from "./shared";

type Overview = {
  lastPatrol: string | null;
  agentReady: boolean;
  counts: { active: number; assigned: number; overdue: number; pendingPlans: number; awaitingPlans: number; openIssues: number; reviewing: number };
  overdueProjects: ImplProject[];
  recentReviews: ImplReport[];
};

function Stat({ label, value, tone }: { label: string; value: number; tone?: "red" | "amber" }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("text-2xl font-semibold tabular-nums mt-1", tone === "red" && value > 0 && "text-red-600", tone === "amber" && value > 0 && "text-amber-600")}>{value}</div>
    </div>
  );
}

function PendingPlans() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["crm", "impl", "delays", "submitted"], queryFn: () => crm<{ items: ImplDelay[] }>("/impl/delays?status=submitted") });
  const [notes, setNotes] = useState<Record<number, string>>({});
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: number; approve: boolean }) => crm(`/impl/delays/${id}/decide`, { method: "POST", body: { approve, note: notes[id] } }),
    onSuccess: () => {
      toast.success("已处理,已通知实施顾问");
      qc.invalidateQueries({ queryKey: ["crm", "impl"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!data?.items.length) return <div className="text-sm text-muted-foreground py-4 text-center">没有待审批的延期方案</div>;
  return (
    <div className="space-y-2">
      {data.items.map(d => (
        <div key={d.id} className="rounded-md border p-3 text-sm space-y-1.5">
          <div className="font-medium">
            {d.project.name} · {d.stage_label}
            <span className="text-muted-foreground font-normal"> · {d.project.consultant_name}</span>
          </div>
          <div className="text-muted-foreground">
            原要求 {d.due_date}(已超期 {d.overdue_days} 天)→ 申请延至 <b className="text-foreground">{d.plan_new_date}</b>
          </div>
          <div>延期原因:{d.plan_reason}</div>
          <div>补救措施:{d.plan_measures}</div>
          <div className="flex gap-2 pt-1">
            <Input className="h-8" placeholder="审批意见(可选)" value={notes[d.id] ?? ""} onChange={e => setNotes({ ...notes, [d.id]: e.target.value })} />
            <Button size="sm" onClick={() => decide.mutate({ id: d.id, approve: true })} disabled={decide.isPending}>
              批准
            </Button>
            <Button size="sm" variant="outline" onClick={() => decide.mutate({ id: d.id, approve: false })} disabled={decide.isPending}>
              驳回
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function NormsEditor({ editable }: { editable: boolean }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const { data } = useQuery({
    queryKey: ["crm", "impl", "norms"],
    queryFn: () => crm<{ text: string; updated_at: string | null; files: { id: number; filename: string; size: number; has_text: number; created_at: string }[] }>("/impl/norms"),
  });
  const [text, setText] = useState("");
  useEffect(() => {
    if (data) setText(data.text);
  }, [data]);
  const save = useMutation({
    mutationFn: () => crm("/impl/norms", { method: "PUT", body: { text } }),
    onSuccess: () => {
      toast.success("项目管理规范已保存,之后的汇报按新规范审核");
      qc.invalidateQueries({ queryKey: ["crm", "impl", "norms"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const upload = useMutation({
    mutationFn: (f: File) => uploadFile("/impl/norms/upload", f),
    onSuccess: (r: any) => {
      toast.success(r.extracted ? `已上传并提取 ${r.extracted} 字加入规范` : "已上传。该格式无法自动提取文字,请把规范要点粘贴到下方文本框");
      qc.invalidateQueries({ queryKey: ["crm", "impl", "norms"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        数字总监按这里的规范审核每份阶段汇报。可上传规范文档(Word .docx / .txt / .md 会自动提取文字),也可以直接编辑。建议写清每个阶段的必交文档与验收标准。
      </p>
      {editable && (
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".docx,.txt,.md,.pdf,.doc"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
              e.target.value = "";
            }}
          />
          <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={upload.isPending}>
            {upload.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}
            上传规范文档
          </Button>
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            <Save className="h-4 w-4 mr-1" />
            保存规范
          </Button>
          {data?.updated_at && <span className="text-xs text-muted-foreground">更新于 {fmtTime(data.updated_at)}</span>}
        </div>
      )}
      <Textarea
        rows={12}
        value={text}
        onChange={e => setText(e.target.value)}
        readOnly={!editable}
        placeholder={"例:\n一、前期准备:须召开项目启动会并上传《项目启动会纪要》《项目实施计划》……\n二、蓝图设计:须上传《业务调研报告》《蓝图设计方案》,并取得客户书面确认……\n三、项目上线:……\n四、验收交付:须上传客户签字的《项目验收报告》……"}
        className="font-mono text-xs"
      />
      {!!data?.files.length && (
        <div className="divide-y rounded-md border text-sm">
          {data.files.map(f => (
            <div key={f.id} className="flex items-center gap-2 p-2">
              <span className="flex-1 truncate">{f.filename}</span>
              {!f.has_text && <Badge variant="outline" className="font-normal">未提取文字</Badge>}
              <span className="text-xs text-muted-foreground">{fmtSize(f.size)}</span>
              <a href={fileUrl(f.id)}>
                <Button variant="ghost" size="icon">
                  <Download className="h-4 w-4" />
                </Button>
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AskDirector() {
  const [q, setQ] = useState("");
  const [log, setLog] = useState<{ role: "me" | "bot"; text: string }[]>([]);
  const ask = useMutation({
    mutationFn: (question: string) => crm<{ reply: string }>("/impl/director/ask", { method: "POST", body: { question } }),
    onSuccess: d => setLog(l => [...l, { role: "bot", text: d.reply }]),
    onError: (e: Error) => setLog(l => [...l, { role: "bot", text: `(${e.message})` }]),
  });
  const send = (text: string) => {
    if (!text.trim() || ask.isPending) return;
    setLog(l => [...l, { role: "me", text }]);
    setQ("");
    ask.mutate(text);
  };
  return (
    <div className="space-y-3">
      <div className="max-h-80 overflow-y-auto space-y-2">
        {!log.length && (
          <div className="flex flex-wrap gap-2">
            {["现在有哪些项目超期了?", "每位实施顾问手上有几个项目,进度怎么样?", "最近审核不通过的问题主要集中在哪些方面?"].map(s => (
              <button key={s} type="button" className="rounded-full border px-3 py-1 text-xs hover:bg-accent" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {log.map((m, i) => (
          <div key={i} className={cn("rounded-lg px-3 py-2 text-sm whitespace-pre-wrap max-w-[90%]", m.role === "me" ? "ml-auto bg-primary text-primary-foreground" : "bg-muted")}>
            {m.text}
          </div>
        ))}
        {ask.isPending && (
          <div className="text-sm text-muted-foreground inline-flex items-center">
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            数字总监正在查询数据……
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <Input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === "Enter" && send(q)} placeholder="向数字总监提问,例如:张三的项目进度如何?" />
        <Button onClick={() => send(q)} disabled={ask.isPending || !q.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">每次提问会消耗平台大模型额度。</p>
    </div>
  );
}

export default function ImplDirector() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { data: meta, isLoading: metaLoading } = useImplMeta();
  const allowed = hasRole(meta, "director", "gm");
  const isDirector = hasRole(meta, "director");
  const { data } = useQuery({
    queryKey: ["crm", "impl", "overview"],
    queryFn: () => crm<Overview>("/impl/director/overview"),
    enabled: allowed,
    refetchInterval: 30_000,
  });
  const patrol = useMutation({
    mutationFn: () => crm<{ checked: number; created: number; reminded: number }>("/impl/director/patrol", { method: "POST", body: {} }),
    onSuccess: r => {
      toast.success(`巡检完成:检查 ${r.checked} 个实施中项目,新发现延期 ${r.created} 项,再次提醒 ${r.reminded} 项`);
      qc.invalidateQueries({ queryKey: ["crm", "impl"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const issueList = useMutation({
    mutationFn: () => crm<{ id: number | null; summary: string }>("/impl/director/issue-list", { method: "POST", body: {} }),
    onSuccess: r => {
      if (r.id) {
        toast.success("问题清单已提交总经理");
        navigate(`/impl/issues?list=${r.id}`);
      } else toast.info(r.summary);
      qc.invalidateQueries({ queryKey: ["crm", "impl"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Bot className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">{meta?.directorName ?? "实施管理数字总监"}</h1>
              <p className="text-muted-foreground text-sm">
                每小时自动巡检项目期限并发送延期提醒;按公司项目管理规范审核每份汇报;每天 18:00 汇总问题清单提交总经理
                {data?.lastPatrol ? ` · 最近巡检 ${fmtTime(data.lastPatrol)}` : ""}
              </p>
            </div>
          </div>
          {allowed && (
            <div className="flex gap-2">
              {isDirector && (
                <Button variant="outline" onClick={() => patrol.mutate()} disabled={patrol.isPending}>
                  {patrol.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Radar className="h-4 w-4 mr-2" />}
                  立即巡检
                </Button>
              )}
              <Button onClick={() => issueList.mutate()} disabled={issueList.isPending}>
                {issueList.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ClipboardList className="h-4 w-4 mr-2" />}
                生成问题清单
              </Button>
            </div>
          )}
        </div>

        {metaLoading ? null : !allowed ? (
          <NoAccess text="数字总监工作台仅实施总监和总经理可用" />
        ) : (
          <>
            {data && !data.agentReady && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                数字总监尚未接通平台大模型,汇报会停在"审核出错"。请在服务器执行 <code>bash /root/kmst/deploy/deploy.sh</code> 重新部署。
              </div>
            )}
            <NotificationPanel />
            {data && (
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                <Stat label="实施中项目" value={data.counts.active} />
                <Stat label="待顾问接收" value={data.counts.assigned} />
                <Stat label="超期项目" value={data.counts.overdue} tone="red" />
                <Stat label="待提交延期方案" value={data.counts.awaitingPlans} tone="red" />
                <Stat label="延期方案待审批" value={data.counts.pendingPlans} tone="amber" />
                <Stat label="待整改问题" value={data.counts.openIssues} tone="amber" />
                <Stat label="审核中汇报" value={data.counts.reviewing} />
              </div>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">超期项目</CardTitle>
                </CardHeader>
                <CardContent>
                  {!data?.overdueProjects.length ? (
                    <div className="text-sm text-muted-foreground py-4 text-center">没有超期项目</div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>项目</TableHead>
                          <TableHead className="w-20">顾问</TableHead>
                          <TableHead className="w-36">进度</TableHead>
                          <TableHead className="w-36">期限</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.overdueProjects.map(p => (
                          <TableRow key={p.id} className="cursor-pointer" onClick={() => navigate(`/impl/projects/${p.id}`)}>
                            <TableCell>
                              <div className="font-medium">{p.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {p.customer_name} · {stageName(p.current_stage)}
                              </div>
                            </TableCell>
                            <TableCell>{p.consultant_name}</TableCell>
                            <TableCell>
                              <ProgressBar value={p.progress} danger />
                            </TableCell>
                            <TableCell>
                              <DeadlineBadge p={p} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">延期方案待审批</CardTitle>
                </CardHeader>
                <CardContent>
                  {isDirector ? <PendingPlans /> : <div className="text-sm text-muted-foreground">由实施总监审批</div>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">最近审核记录</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 max-h-[520px] overflow-y-auto">
                  {!data?.recentReviews.length && <div className="text-sm text-muted-foreground py-4 text-center">还没有汇报</div>}
                  {data?.recentReviews.map(r => (
                    <button
                      key={r.id}
                      type="button"
                      className="w-full text-left rounded-md border p-2.5 text-sm hover:bg-accent space-y-1"
                      onClick={() => navigate(`/impl/projects/${r.project_id}`)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{r.project_name}</span>
                        <span className="text-muted-foreground shrink-0">
                          {stageName(r.stage_key)} · {r.created_by} · {r.report_date}
                        </span>
                        <span className="ml-auto shrink-0">
                          <ReviewBadge status={r.review_status} score={r.review_score} />
                        </span>
                      </div>
                      {r.review_summary && <div className="text-muted-foreground">{r.review_summary}</div>}
                      {r.review_issues.slice(0, 3).map((i, n) => (
                        <div key={n} className="text-xs">
                          <Badge variant="outline" className={cn("mr-1 font-normal", SEVERITY_CLASS[i.severity])}>
                            {i.severity}
                          </Badge>
                          {i.problem}
                        </div>
                      ))}
                    </button>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Bot className="h-4 w-4" />
                    问数字总监
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <AskDirector />
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">公司项目管理规范</CardTitle>
              </CardHeader>
              <CardContent>
                <NormsEditor editable={isDirector} />
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
