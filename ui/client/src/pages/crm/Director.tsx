/**
 * 销售管理 · 数字销售总监
 * 路由: /crm/director(?report=<报告id> 打开指定分析报告)
 * 从销售填写的商机、跟进记录、合同、收款登记中抽取数据,按销售统计商机数量、跟进过程、成交率、收款情况;
 * 规则预警久未跟进/跟进逾期/应收未收;大模型生成分析报告(每周一自动出上周报告),也可以直接向它提问。
 */
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { crm, qs } from "@/lib/crmApi";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Download, FileBarChart, Loader2, Printer, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { toast } from "sonner";
import { hasRole, NoAccess, NotificationPanel, useImplMeta } from "../impl/shared";
import { escapeHtml, exportWord, FilterChips, fmtMoney, fmtTime, printDoc, StageBadge, useCrmMeta } from "./shared";

type PersonStats = {
  name: string;
  opps: { total: number; active: number; won: number; lost: number; new_in_period: number; pipeline_amount: number; by_stage: Record<string, number> };
  follow: { count: number; opportunities: number; by_stage: Record<string, number>; last_date: string | null; stale: number; overdue_next: number };
  deal: { close_rate: number | null; win_rate: number | null; signed_count: number; signed_amount: number; signed_count_all: number; signed_amount_all: number };
  pay: { received: number; received_all: number; receivable: number; collection_rate: number | null };
};
type Range = { period: string; from: string | null; to: string | null; label: string };
type ActiveOpp = { id: number; name: string; stage: string; stage_label: string; owner: string; idle_days: number; last_follow: string | null; next_date: string | null; next_plan: string | null; next_overdue_days: number };
type Receivable = { id: number; contract_no: string; project_name: string; customer_name: string; owner: string; amount: number; received: number; unpaid: number; sign_date: string | null; days_since_sign: number | null; last_pay_date: string | null };
type ReportBrief = { id: number; period_from: string | null; period_to: string | null; status: "generating" | "done" | "error"; summary: string | null; created_by: string; created_at: string; finished_at: string | null };
type Analysis = {
  summary: string;
  team_problems: string[];
  people: { name: string; score: number | null; rating: string; highlights: string; problems: string[]; suggestions: string[] }[];
};
type Report = ReportBrief & { content: { stats: { range: Range; team: PersonStats; people: PersonStats[] }; analysis: Analysis | null } | null };
type Overview = {
  name: string;
  agentReady: boolean;
  latestReport: ReportBrief | null;
  today: string;
  range: Range;
  staleDays: number;
  team: PersonStats;
  people: PersonStats[];
  alerts: { stale: ActiveOpp[]; overdueNext: ActiveOpp[]; receivables: Receivable[] };
};
type PersonDetail = {
  name: string;
  range: Range;
  stats: PersonStats;
  opportunities: {
    id: number; name: string; stage: string; expected_amount: number | null; followup_count: number; last_follow: string | null;
    idle_days: number | null; stale: boolean; next_date: string | null; next_overdue_days: number; signed_amount: number; received: number;
  }[];
  followups: { id: number; opportunity_name: string; stage: string; stage_label: string; follow_date: string; method: string | null; contact_name: string | null; content: string; next_plan: string | null; next_date: string | null }[];
  payments: { id: number; amount: number; pay_date: string; method: string | null; remark: string | null; contract_no: string; customer_name: string }[];
};

const PERIODS = [
  { value: "week", label: "本周" },
  { value: "last_week", label: "上周" },
  { value: "month", label: "本月" },
  { value: "last_month", label: "上月" },
  { value: "quarter", label: "本季度" },
  { value: "year", label: "本年" },
  { value: "all", label: "全部" },
  { value: "custom", label: "自定义" },
];

const rate = (v: number | null) => (v == null ? "-" : `${v}%`);
const wan = (n: number) => (Math.abs(n) >= 10000 ? `${(n / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}万` : n.toLocaleString("zh-CN", { maximumFractionDigits: 2 }));

function Stat({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: "red" | "amber" | "green" }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("text-2xl font-semibold tabular-nums mt-1", tone === "red" && "text-red-600", tone === "amber" && "text-amber-600", tone === "green" && "text-emerald-600")}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-sm text-muted-foreground py-6 text-center">{text}</div>;
}

function PeopleTable({ people, onOpen }: { people: PersonStats[]; onOpen: (name: string) => void }) {
  if (!people.length) return <Empty text="还没有商机数据。销售在「商机管理」录入商机、在「客户跟进」填写跟进后,这里自动统计" />;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>销售</TableHead>
            <TableHead className="text-right">商机(在跟/成交/流失)</TableHead>
            <TableHead className="text-right">新增</TableHead>
            <TableHead className="text-right">跟进次数</TableHead>
            <TableHead>最近跟进</TableHead>
            <TableHead className="text-right">跟进预警</TableHead>
            <TableHead className="text-right">成交率</TableHead>
            <TableHead className="text-right">赢单率</TableHead>
            <TableHead className="text-right">签约金额</TableHead>
            <TableHead className="text-right">收款</TableHead>
            <TableHead className="text-right">累计未收</TableHead>
            <TableHead className="text-right">回款率</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {people.map(p => (
            <TableRow key={p.name} className="cursor-pointer" onClick={() => onOpen(p.name)}>
              <TableCell className="font-medium text-primary">{p.name}</TableCell>
              <TableCell className="text-right tabular-nums">
                <b>{p.opps.total}</b>
                <span className="text-muted-foreground">
                  {" "}
                  ({p.opps.active}/{p.opps.won}/{p.opps.lost})
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums">{p.opps.new_in_period}</TableCell>
              <TableCell className="text-right tabular-nums">
                {p.follow.count}
                <span className="text-xs text-muted-foreground"> · {p.follow.opportunities}个商机</span>
              </TableCell>
              <TableCell className="text-sm">{p.follow.last_date ?? "-"}</TableCell>
              <TableCell className="text-right">
                {p.follow.stale + p.follow.overdue_next === 0 ? (
                  <span className="text-xs text-muted-foreground">无</span>
                ) : (
                  <div className="flex flex-col items-end gap-0.5">
                    {p.follow.stale > 0 && (
                      <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 font-normal">
                        久未跟进 {p.follow.stale}
                      </Badge>
                    )}
                    {p.follow.overdue_next > 0 && (
                      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 font-normal">
                        跟进逾期 {p.follow.overdue_next}
                      </Badge>
                    )}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{rate(p.deal.close_rate)}</TableCell>
              <TableCell className="text-right tabular-nums">{rate(p.deal.win_rate)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {fmtMoney(p.deal.signed_amount)}
                <div className="text-xs text-muted-foreground">{p.deal.signed_count} 份</div>
              </TableCell>
              <TableCell className="text-right tabular-nums">{fmtMoney(p.pay.received)}</TableCell>
              <TableCell className={cn("text-right tabular-nums", p.pay.receivable > 0 && "text-amber-700")}>{fmtMoney(p.pay.receivable)}</TableCell>
              <TableCell className="text-right tabular-nums">{rate(p.pay.collection_rate)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function PersonDialog({ name, periodQuery, onClose }: { name: string | null; periodQuery: string; onClose: () => void }) {
  const { data: meta } = useCrmMeta();
  const [, navigate] = useLocation();
  const { data, isLoading } = useQuery({
    queryKey: ["crm", "sales-director", "person", name, periodQuery],
    queryFn: () => crm<PersonDetail>(`/sales/director/person${periodQuery ? periodQuery + "&" : "?"}name=${encodeURIComponent(name!)}`),
    enabled: !!name,
  });
  const s = data?.stats;
  return (
    <Dialog open={!!name} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-5xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {name} 的销售明细
            {data && <span className="text-sm font-normal text-muted-foreground ml-2">{data.range.label}</span>}
          </DialogTitle>
        </DialogHeader>
        {isLoading || !data || !s ? (
          <div className="py-10 text-center">
            <Loader2 className="h-5 w-5 animate-spin inline" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="商机(累计)" value={s.opps.total} sub={`在跟 ${s.opps.active} · 成交 ${s.opps.won} · 流失 ${s.opps.lost}`} />
              <Stat label="区间跟进" value={s.follow.count} sub={`覆盖 ${s.follow.opportunities} 个商机`} />
              <Stat label="成交率 / 赢单率" value={rate(s.deal.close_rate)} sub={`赢单率 ${rate(s.deal.win_rate)}`} />
              <Stat label="区间收款" value={wan(s.pay.received)} sub={`累计未收 ${wan(s.pay.receivable)} · 回款率 ${rate(s.pay.collection_rate)}`} />
            </div>
            <Tabs defaultValue="opps">
              <TabsList>
                <TabsTrigger value="opps">名下商机({data.opportunities.length})</TabsTrigger>
                <TabsTrigger value="follow">跟进记录({data.followups.length})</TabsTrigger>
                <TabsTrigger value="pay">收款记录({data.payments.length})</TabsTrigger>
              </TabsList>
              <TabsContent value="opps" className="mt-3">
                {!data.opportunities.length ? (
                  <Empty text="没有商机" />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>客户</TableHead>
                        <TableHead className="w-24">阶段</TableHead>
                        <TableHead className="w-20 text-right">跟进</TableHead>
                        <TableHead className="w-40">最近跟进</TableHead>
                        <TableHead className="w-32">下次跟进</TableHead>
                        <TableHead className="w-32 text-right">签约</TableHead>
                        <TableHead className="w-32 text-right">已收</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.opportunities.map(o => (
                        <TableRow key={o.id} className="cursor-pointer" onClick={() => navigate(`/crm/opportunities?view=${o.id}`)}>
                          <TableCell className="font-medium">{o.name}</TableCell>
                          <TableCell>
                            <StageBadge stage={o.stage} meta={meta} />
                          </TableCell>
                          <TableCell className="text-right">{o.followup_count}</TableCell>
                          <TableCell>
                            {o.last_follow ?? "未跟进"}
                            {o.stale && <span className="text-xs text-red-600 ml-1">{o.idle_days}天未跟进</span>}
                          </TableCell>
                          <TableCell className={cn(o.next_overdue_days > 0 && "text-amber-700")}>
                            {o.next_date ?? "-"}
                            {o.next_overdue_days > 0 && <span className="text-xs ml-1">逾期{o.next_overdue_days}天</span>}
                          </TableCell>
                          <TableCell className="text-right">{o.signed_amount ? fmtMoney(o.signed_amount) : "-"}</TableCell>
                          <TableCell className="text-right">{o.signed_amount ? fmtMoney(o.received) : "-"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </TabsContent>
              <TabsContent value="follow" className="mt-3 space-y-2">
                {!data.followups.length && <Empty text="这个区间没有跟进记录" />}
                {data.followups.map(f => (
                  <div key={f.id} className="rounded-md border p-2.5 text-sm space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{f.opportunity_name}</span>
                      <StageBadge stage={f.stage} meta={meta} />
                      <span className="text-muted-foreground">
                        {f.follow_date} · {f.method || "-"}
                        {f.contact_name ? ` · ${f.contact_name}` : ""}
                      </span>
                    </div>
                    <div className="whitespace-pre-wrap">{f.content}</div>
                    {f.next_plan && (
                      <div className="text-xs text-muted-foreground">
                        下一步:{f.next_plan}
                        {f.next_date ? `(${f.next_date})` : ""}
                      </div>
                    )}
                  </div>
                ))}
              </TabsContent>
              <TabsContent value="pay" className="mt-3">
                {!data.payments.length ? (
                  <Empty text="这个区间没有收款。收款在「销售合同」打开已签订合同后登记" />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-28">收款日期</TableHead>
                        <TableHead>客户 / 合同</TableHead>
                        <TableHead className="w-32 text-right">金额</TableHead>
                        <TableHead className="w-24">方式</TableHead>
                        <TableHead>备注</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.payments.map(p => (
                        <TableRow key={p.id}>
                          <TableCell>{p.pay_date}</TableCell>
                          <TableCell>
                            {p.customer_name}
                            <div className="text-xs text-muted-foreground font-mono">{p.contract_no}</div>
                          </TableCell>
                          <TableCell className="text-right">{fmtMoney(p.amount)}</TableCell>
                          <TableCell>{p.method || "-"}</TableCell>
                          <TableCell className="text-muted-foreground">{p.remark || "-"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Alerts({ data, onOpen }: { data: Overview; onOpen: (name: string) => void }) {
  const [, navigate] = useLocation();
  const { stale, overdueNext, receivables } = data.alerts;
  return (
    <Tabs defaultValue="stale">
      <TabsList>
        <TabsTrigger value="stale">久未跟进({stale.length})</TabsTrigger>
        <TabsTrigger value="overdue">跟进逾期({overdueNext.length})</TabsTrigger>
        <TabsTrigger value="unpaid">应收未收({receivables.length})</TabsTrigger>
      </TabsList>
      <TabsContent value="stale" className="mt-3">
        {!stale.length ? (
          <Empty text={`没有超过 ${data.staleDays} 天未跟进的商机`} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>客户</TableHead>
                <TableHead className="w-24">销售</TableHead>
                <TableHead className="w-24">阶段</TableHead>
                <TableHead className="w-28">最近跟进</TableHead>
                <TableHead className="w-24 text-right">未跟进</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stale.slice(0, 50).map(o => (
                <TableRow key={o.id} className="cursor-pointer" onClick={() => navigate(`/crm/opportunities?view=${o.id}`)}>
                  <TableCell className="font-medium">{o.name}</TableCell>
                  <TableCell>
                    <button type="button" className="text-primary hover:underline" onClick={e => (e.stopPropagation(), onOpen(o.owner))}>
                      {o.owner}
                    </button>
                  </TableCell>
                  <TableCell>{o.stage_label}</TableCell>
                  <TableCell>{o.last_follow ?? "从未跟进"}</TableCell>
                  <TableCell className="text-right text-red-600">{o.idle_days} 天</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TabsContent>
      <TabsContent value="overdue" className="mt-3">
        {!overdueNext.length ? (
          <Empty text="没有逾期未做的下次跟进" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>客户</TableHead>
                <TableHead className="w-24">销售</TableHead>
                <TableHead>约定的下一步</TableHead>
                <TableHead className="w-28">约定日期</TableHead>
                <TableHead className="w-20 text-right">逾期</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overdueNext.slice(0, 50).map(o => (
                <TableRow key={o.id} className="cursor-pointer" onClick={() => navigate(`/crm/opportunities?view=${o.id}`)}>
                  <TableCell className="font-medium">{o.name}</TableCell>
                  <TableCell>{o.owner}</TableCell>
                  <TableCell className="text-muted-foreground">{o.next_plan || "-"}</TableCell>
                  <TableCell>{o.next_date}</TableCell>
                  <TableCell className="text-right text-amber-700">{o.next_overdue_days} 天</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TabsContent>
      <TabsContent value="unpaid" className="mt-3">
        {!receivables.length ? (
          <Empty text="已签订合同都已收齐款项" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>客户 / 合同</TableHead>
                <TableHead className="w-24">销售</TableHead>
                <TableHead className="w-32 text-right">合同金额</TableHead>
                <TableHead className="w-32 text-right">已收</TableHead>
                <TableHead className="w-32 text-right">未收</TableHead>
                <TableHead className="w-32">签约</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receivables.slice(0, 50).map(c => (
                <TableRow key={c.id} className="cursor-pointer" onClick={() => navigate(`/crm/contracts?view=${c.id}`)}>
                  <TableCell>
                    <div className="font-medium">{c.customer_name}</div>
                    <div className="text-xs text-muted-foreground font-mono">{c.contract_no}</div>
                  </TableCell>
                  <TableCell>{c.owner}</TableCell>
                  <TableCell className="text-right">{fmtMoney(c.amount)}</TableCell>
                  <TableCell className="text-right">{fmtMoney(c.received)}</TableCell>
                  <TableCell className="text-right text-amber-700">{fmtMoney(c.unpaid)}</TableCell>
                  <TableCell>
                    {c.sign_date ?? "-"}
                    {c.days_since_sign != null && <div className="text-xs text-muted-foreground">{c.days_since_sign} 天前</div>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TabsContent>
    </Tabs>
  );
}

const RATING_CLASS: Record<string, string> = {
  优秀: "bg-emerald-50 text-emerald-700 border-emerald-200",
  良好: "bg-sky-50 text-sky-700 border-sky-200",
  一般: "bg-amber-50 text-amber-700 border-amber-200",
  待改进: "bg-red-50 text-red-700 border-red-200",
};

function periodText(r: Pick<ReportBrief, "period_from" | "period_to">) {
  return r.period_from || r.period_to ? `${r.period_from ?? "最早"} ~ ${r.period_to ?? "至今"}` : "全部时间";
}

function reportHtml(r: Report) {
  const a = r.content?.analysis;
  const stats = r.content?.stats;
  if (!a || !stats) return "";
  const li = (xs: string[]) => (xs.length ? `<ul>${xs.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : "<p>无</p>");
  const rows = stats.people
    .map(
      p => `<tr><td>${escapeHtml(p.name)}</td><td>${p.opps.total}(${p.opps.active}/${p.opps.won}/${p.opps.lost})</td><td>${p.follow.count}</td>
        <td>${rate(p.deal.close_rate)}</td><td>${fmtMoney(p.deal.signed_amount)}</td><td>${fmtMoney(p.pay.received)}</td><td>${fmtMoney(p.pay.receivable)}</td></tr>`
    )
    .join("");
  return `<h1>销售分析报告</h1>
<p>统计区间:${escapeHtml(periodText(r))};生成:${escapeHtml(fmtTime(r.finished_at ?? r.created_at))}(数字销售总监)</p>
<h2>整体结论</h2><p>${escapeHtml(a.summary)}</p>
<h2>团队问题</h2>${li(a.team_problems)}
<h2>销售数据</h2>
<table class="modules"><tr><th>销售</th><th>商机(在跟/成交/流失)</th><th>跟进次数</th><th>成交率</th><th>签约金额</th><th>收款</th><th>累计未收</th></tr>${rows}</table>
<h2>逐人点评</h2>
${a.people
  .map(
    p => `<h3>${escapeHtml(p.name)}  ${escapeHtml(p.rating)}${p.score != null ? ` · ${p.score}分` : ""}</h3>
<p>做得好:${escapeHtml(p.highlights || "-")}</p><p>问题:</p>${li(p.problems)}<p>建议:</p>${li(p.suggestions)}`
  )
  .join("")}`;
}

function ReportPanel({ periodBody, initialId }: { periodBody: Record<string, string>; initialId: number | null }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number | null>(initialId);
  const [polling, setPolling] = useState(false);
  const { data: list } = useQuery({
    queryKey: ["crm", "sales-director", "reports"],
    queryFn: () => crm<{ items: ReportBrief[] }>("/sales/director/reports"),
    refetchInterval: polling ? 5_000 : false,
  });
  const generating = !!list?.items.some(r => r.status === "generating");
  useEffect(() => setPolling(generating), [generating]);
  const currentId = selected ?? list?.items[0]?.id ?? null;
  const currentBrief = list?.items.find(r => r.id === currentId);
  const { data: report } = useQuery({
    queryKey: ["crm", "sales-director", "report", currentId, currentBrief?.status],
    queryFn: () => crm<Report>(`/sales/director/reports/${currentId}`),
    enabled: !!currentId && currentBrief?.status !== "generating",
  });
  useEffect(() => {
    if (initialId) setSelected(initialId);
  }, [initialId]);
  const generate = useMutation({
    mutationFn: () => crm<{ id: number }>("/sales/director/reports", { method: "POST", body: periodBody }),
    onSuccess: r => {
      toast.success("数字销售总监开始分析,约 1-2 分钟出结果");
      setSelected(r.id);
      qc.invalidateQueries({ queryKey: ["crm", "sales-director", "reports"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const a = report?.content?.analysis;
  const title = report ? `销售分析报告 ${periodText(report)}` : "";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => generate.mutate()} disabled={generate.isPending || generating}>
          {generate.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileBarChart className="h-4 w-4 mr-2" />}
          按当前区间生成分析报告
        </Button>
        {!!list?.items.length && (
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={currentId ?? ""}
            onChange={e => setSelected(Number(e.target.value))}
          >
            {list.items.map(r => (
              <option key={r.id} value={r.id}>
                {fmtTime(r.created_at)} · {periodText(r)}
                {r.status === "generating" ? "(生成中)" : r.status === "error" ? "(失败)" : ""}
              </option>
            ))}
          </select>
        )}
        {a && report && (
          <>
            <Button variant="outline" size="sm" onClick={() => printDoc(title, reportHtml(report)) || toast.error("浏览器拦截了弹出窗口,请允许后重试")}>
              <Printer className="h-4 w-4 mr-1" />
              打印
            </Button>
            <Button variant="outline" size="sm" onClick={() => exportWord(title, title, reportHtml(report))}>
              <Download className="h-4 w-4 mr-1" />
              导出 Word
            </Button>
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">每周一 09:00 自动生成上周报告并通知总经理和销售经理;手动生成会消耗平台大模型额度。</p>
      {!list?.items.length && <Empty text="还没有分析报告" />}
      {currentBrief?.status === "generating" && (
        <div className="text-sm text-muted-foreground inline-flex items-center py-4">
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          数字销售总监正在阅读跟进记录并分析,请稍候……
        </div>
      )}
      {report?.status === "error" && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">生成失败:{report.summary}</div>}
      {a && (
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <div className="font-medium mb-1">整体结论</div>
            {a.summary}
            {!!a.team_problems.length && (
              <ul className="list-disc pl-5 mt-2 space-y-0.5">
                {a.team_problems.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {a.people.map(p => (
              <div key={p.name} className="rounded-md border p-3 text-sm space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  {p.rating && (
                    <Badge variant="outline" className={cn("font-normal", RATING_CLASS[p.rating])}>
                      {p.rating}
                    </Badge>
                  )}
                  {p.score != null && <span className="ml-auto text-lg font-semibold tabular-nums">{p.score}分</span>}
                </div>
                {p.highlights && <div className="text-emerald-700">👍 {p.highlights}</div>}
                {!!p.problems.length && (
                  <div>
                    <div className="text-xs text-muted-foreground">问题</div>
                    <ul className="list-disc pl-5">
                      {p.problems.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {!!p.suggestions.length && (
                  <div>
                    <div className="text-xs text-muted-foreground">建议</div>
                    <ul className="list-disc pl-5">
                      {p.suggestions.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AskDirector() {
  const [q, setQ] = useState("");
  const [log, setLog] = useState<{ role: "me" | "bot"; text: string }[]>([]);
  const ask = useMutation({
    mutationFn: (question: string) => crm<{ reply: string }>("/sales/director/ask", { method: "POST", body: { question } }),
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
            {["本月每位销售的业绩排名怎么样?", "哪些商机很久没人跟进了?", "还有哪些合同没收齐款?", "谁的跟进记录写得最不具体?"].map(s => (
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
            数字销售总监正在查询数据……
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <Input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === "Enter" && send(q)} placeholder="向数字销售总监提问,例如:张三这个月跟进了哪些客户?" />
        <Button onClick={() => send(q)} disabled={ask.isPending || !q.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">每次提问会消耗平台大模型额度。</p>
    </div>
  );
}

export default function CrmDirector() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const { data: meta, isLoading: metaLoading } = useImplMeta();
  const allowed = hasRole(meta, "sales_manager", "gm");
  const [period, setPeriod] = useState("month");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [person, setPerson] = useState<string | null>(null);
  const [reportId, setReportId] = useState<number | null>(null);

  useEffect(() => {
    const id = Number(new URLSearchParams(search).get("report"));
    if (id) {
      setReportId(id);
      navigate("/crm/director", { replace: true });
    }
  }, [search, navigate]);

  const customReady = period !== "custom" || (!!from && !!to);
  const periodBody: Record<string, string> = period === "custom" ? { period, from, to } : { period };
  const periodQuery = qs(periodBody);
  const { data, isLoading, error } = useQuery({
    queryKey: ["crm", "sales-director", "overview", periodQuery],
    queryFn: () => crm<Overview>(`/sales/director/overview${periodQuery}`),
    enabled: allowed && customReady,
    refetchInterval: 60_000,
  });
  const t = data?.team;

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Bot className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">{data?.name ?? "数字销售总监"}</h1>
              <p className="text-muted-foreground text-sm">从销售填写的商机、跟进记录、合同和收款登记中自动统计每位销售的商机数量、跟进过程、成交率和收款情况</p>
            </div>
          </div>
        </div>

        {metaLoading ? null : !allowed ? (
          <NoAccess text="数字销售总监仅总经理和销售经理可用" />
        ) : (
          <>
            {data && !data.agentReady && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                数字销售总监尚未接通平台大模型,统计和预警可以正常使用,分析报告和提问暂不可用。请在服务器执行 <code>bash /root/kmst/deploy/deploy.sh</code> 重新部署。
              </div>
            )}
            <NotificationPanel />

            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-muted-foreground">统计区间</span>
              <FilterChips options={PERIODS} value={period} onChange={setPeriod} />
              {period === "custom" && (
                <div className="flex items-center gap-1">
                  <Input type="date" className="h-8 w-40" value={from} onChange={e => setFrom(e.target.value)} />
                  <span className="text-muted-foreground">~</span>
                  <Input type="date" className="h-8 w-40" value={to} onChange={e => setTo(e.target.value)} />
                </div>
              )}
              {data && <span className="text-xs text-muted-foreground">{data.range.label}</span>}
            </div>
            {error && <div className="text-sm text-red-600">{(error as Error).message}</div>}
            {isLoading && (
              <div className="py-10 text-center">
                <Loader2 className="h-5 w-5 animate-spin inline" />
              </div>
            )}

            {data && t && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
                  <Stat label="商机总数" value={t.opps.total} sub={`在跟 ${t.opps.active} 个`} />
                  <Stat label="区间新增商机" value={t.opps.new_in_period} />
                  <Stat label="区间跟进次数" value={t.follow.count} sub={`覆盖 ${t.follow.opportunities} 个商机`} />
                  <Stat label="成交率" value={rate(t.deal.close_rate)} sub={`赢单率 ${rate(t.deal.win_rate)}`} />
                  <Stat label="区间签约" value={wan(t.deal.signed_amount)} sub={`${t.deal.signed_count} 份合同`} tone="green" />
                  <Stat label="区间收款" value={wan(t.pay.received)} tone="green" />
                  <Stat label="累计未收" value={wan(t.pay.receivable)} sub={`回款率 ${rate(t.pay.collection_rate)}`} tone={t.pay.receivable > 0 ? "amber" : undefined} />
                  <Stat
                    label="跟进预警"
                    value={t.follow.stale + t.follow.overdue_next}
                    sub={`久未跟进 ${t.follow.stale} · 逾期 ${t.follow.overdue_next}`}
                    tone={t.follow.stale + t.follow.overdue_next > 0 ? "red" : undefined}
                  />
                </div>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">销售人员统计</CardTitle>
                    <p className="text-xs text-muted-foreground">
                      按商机负责人统计;点击姓名查看明细。成交率 = 已成交 ÷ 全部商机,赢单率 = 已成交 ÷ (已成交 + 已流失),两者为累计口径;新增、跟进、签约、收款按所选区间统计。
                    </p>
                  </CardHeader>
                  <CardContent>
                    <PeopleTable people={data.people} onOpen={setPerson} />
                  </CardContent>
                </Card>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base">风险预警</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Alerts data={data} onOpen={setPerson} />
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Bot className="h-4 w-4" />
                        问数字销售总监
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <AskDirector />
                    </CardContent>
                  </Card>
                </div>
              </>
            )}

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <FileBarChart className="h-4 w-4" />
                  销售分析报告
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ReportPanel periodBody={periodBody} initialId={reportId} />
              </CardContent>
            </Card>
          </>
        )}
      </div>
      <PersonDialog name={person} periodQuery={periodQuery} onClose={() => setPerson(null)} />
    </DashboardLayout>
  );
}
