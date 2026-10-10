/**
 * 实施管理 · 问题清单(总经理)
 * 路由: /impl/issues(?list=<清单id> 直接打开某份清单)
 * 数字总监每天汇总在实施项目的待整改问题与延期,形成问题清单提交总经理;也可查看全部待整改问题。
 */
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { crm } from "@/lib/crmApi";
import type { ImplIssue, IssueList } from "@/lib/implApi";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Printer } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { toast } from "sonner";
import { docSrc, escapeHtml, exportWord, FilterChips, fmtTime, PageHeader, printDoc } from "../crm/shared";
import { DELAY_STATUS, hasRole, NoAccess, SEVERITY_CLASS, stageName, useImplMeta } from "./shared";

function listHtml(l: IssueList) {
  const c = l.content!;
  const body = c.items
    .map(
      (it, n) => `<h2>${n + 1}. ${escapeHtml(it.name)}(${escapeHtml(it.customer_name)})</h2>
<p>项目编号 ${escapeHtml(it.project_no)} · 实施顾问 ${escapeHtml(it.consultant_name)} · 要求完成 ${escapeHtml(it.planned_end)}</p>
${
  it.delays.length
    ? `<h3>延期情况</h3><table class="modules"><tr><th>阶段</th><th>原要求完成</th><th>超期天数</th><th>状态</th><th>延期方案</th></tr>${it.delays
        .map(
          d =>
            `<tr><td>${escapeHtml(stageName(d.stage_key))}</td><td>${escapeHtml(d.due_date)}</td><td>${d.overdue_days}</td><td>${escapeHtml(DELAY_STATUS[d.status]?.label ?? d.status)}</td><td>${d.plan_new_date ? `延至 ${escapeHtml(d.plan_new_date)}:${escapeHtml(d.plan_reason)}` : "未提交"}</td></tr>`
        )
        .join("")}</table>`
    : ""
}
${
  it.issues.length
    ? `<h3>待整改问题</h3><table class="modules"><tr><th width="6%">级别</th><th width="12%">阶段</th><th>问题</th><th width="22%">依据</th><th width="26%">整改建议</th></tr>${it.issues
        .map(
          i =>
            `<tr><td>${escapeHtml(i.severity)}</td><td>${escapeHtml(stageName(i.stage_key))}</td><td>${escapeHtml(i.problem)}</td><td>${escapeHtml(i.norm)}</td><td>${escapeHtml(i.suggestion)}</td></tr>`
        )
        .join("")}</table>`
    : ""
}`
    )
    .join("\n");
  return `<h1>在实施项目问题清单</h1>
<p style="text-align:center">${escapeHtml(l.list_date)} · ${escapeHtml(c.generated_by)} 提交 · 更新于 ${escapeHtml(fmtTime(l.updated_at))}</p>
<p><b>概要:</b>${escapeHtml(l.summary)}</p>
${body}`;
}

function ListsTab({ initialId }: { initialId: number | null }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["crm", "impl", "issue-lists"], queryFn: () => crm<{ items: IssueList[] }>("/impl/issue-lists") });
  const [selected, setSelected] = useState<number | null>(initialId);
  useEffect(() => {
    if (!selected && data?.items.length) setSelected(data.items[0].id);
  }, [data, selected]);
  const { data: list } = useQuery({
    queryKey: ["crm", "impl", "issue-list", selected],
    queryFn: () => crm<IssueList>(`/impl/issue-lists/${selected}`),
    enabled: !!selected,
  });
  useEffect(() => {
    if (list) qc.invalidateQueries({ queryKey: ["crm", "impl", "issue-lists"] });
  }, [list?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const html = list?.content ? listHtml(list) : "";
  const title = list ? `在实施项目问题清单 ${list.list_date}` : "";
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-4">
      <div className="space-y-2">
        {!data?.items.length && <div className="text-sm text-muted-foreground">还没有问题清单</div>}
        {data?.items.map(l => (
          <button
            key={l.id}
            type="button"
            onClick={() => setSelected(l.id)}
            className={cn("w-full text-left rounded-md border p-3 text-sm", selected === l.id ? "border-primary bg-primary/5" : "hover:bg-accent")}
          >
            <div className="font-medium flex items-center gap-2">
              {l.list_date}
              {!l.read_at && <span className="h-2 w-2 rounded-full bg-red-500" title="未读" />}
            </div>
            <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{l.summary}</div>
          </button>
        ))}
      </div>
      <div className="space-y-3">
        {list && (
          <>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => printDoc(title, html) || toast.error("浏览器拦截了弹出窗口,请允许后重试")}>
                <Printer className="h-4 w-4 mr-2" />
                打印
              </Button>
              <Button variant="outline" onClick={() => exportWord(title, title, html)}>
                <Download className="h-4 w-4 mr-2" />
                导出 Word
              </Button>
            </div>
            <iframe title={title} srcDoc={docSrc(title, html)} className="w-full h-[70vh] rounded border bg-white" />
          </>
        )}
      </div>
    </div>
  );
}

function OpenIssuesTab() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const { data, isLoading } = useQuery({
    queryKey: ["crm", "impl", "issues", status],
    queryFn: () => crm<{ items: ImplIssue[] }>(`/impl/issues?status=${status}`),
  });
  const resolve = useMutation({
    mutationFn: (id: number) => crm(`/impl/issues/${id}/resolve`, { method: "POST", body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["crm", "impl"] }),
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="space-y-3">
      <FilterChips
        value={status}
        onChange={setStatus}
        options={[
          { value: "open", label: "待整改" },
          { value: "resolved", label: "已整改" },
        ]}
      />
      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-14">级别</TableHead>
              <TableHead className="w-48">项目</TableHead>
              <TableHead className="w-20">阶段</TableHead>
              <TableHead>问题与整改建议</TableHead>
              <TableHead className="w-20">顾问</TableHead>
              <TableHead className="w-28">发现时间</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin inline" />
                </TableCell>
              </TableRow>
            )}
            {!isLoading && !data?.items.length && (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                  没有{status === "open" ? "待整改" : "已整改"}的问题
                </TableCell>
              </TableRow>
            )}
            {data?.items.map(i => (
              <TableRow key={i.id}>
                <TableCell>
                  <Badge variant="outline" className={cn("font-normal", SEVERITY_CLASS[i.severity])}>
                    {i.severity}
                  </Badge>
                </TableCell>
                <TableCell>
                  <button type="button" className="text-left hover:underline" onClick={() => navigate(`/impl/projects/${i.project_id}`)}>
                    <div className="font-medium">{i.project_name}</div>
                    <div className="text-xs text-muted-foreground">{i.customer_name}</div>
                  </button>
                </TableCell>
                <TableCell>{stageName(i.stage_key)}</TableCell>
                <TableCell className="text-sm">
                  {i.problem}
                  {i.norm && <div className="text-xs text-muted-foreground">依据:{i.norm}</div>}
                  {i.suggestion && <div className="text-xs text-muted-foreground">建议:{i.suggestion}</div>}
                </TableCell>
                <TableCell>{i.consultant_name}</TableCell>
                <TableCell className="text-xs">{fmtTime(i.created_at)}</TableCell>
                <TableCell>
                  {i.status === "open" ? (
                    <Button variant="ghost" size="sm" onClick={() => resolve.mutate(i.id)}>
                      已整改
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">{i.resolved_by}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export default function ImplIssues() {
  const search = useSearch();
  const { data: meta, isLoading } = useImplMeta();
  const initialId = Number(new URLSearchParams(search).get("list")) || null;
  return (
    <DashboardLayout>
      <div className="space-y-4">
        <PageHeader title="问题清单" description="实施管理数字总监汇总的在实施项目问题与延期情况,每天提交总经理" />
        {isLoading ? null : !hasRole(meta, "gm", "director") ? (
          <NoAccess text="问题清单仅总经理和实施总监可查看" />
        ) : (
          <Tabs defaultValue="lists">
            <TabsList>
              <TabsTrigger value="lists">每日问题清单</TabsTrigger>
              <TabsTrigger value="issues">全部问题</TabsTrigger>
            </TabsList>
            <TabsContent value="lists" className="mt-4">
              <ListsTab key={initialId ?? 0} initialId={initialId} />
            </TabsContent>
            <TabsContent value="issues" className="mt-4">
              <OpenIssuesTab />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </DashboardLayout>
  );
}
