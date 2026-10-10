/**
 * 销售管理 · 客户跟进管理
 * 路由: /crm/followups
 * 销售选择跟进阶段(初次拜访/需求分析/方案提供/商务谈判)后录入具体跟进内容;跟进推进到更后阶段时商机阶段随之前进。
 */
import DashboardLayout from "@/components/DashboardLayout";
import DataPagination from "@/components/DataPagination";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { crm, qs, type Followup, type Paged } from "@/lib/crmApi";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Field, FilterChips, OpportunitySelect, PageHeader, StageBadge, today, useCrmMeta } from "./shared";

const STAGE_GUIDE: Record<string, { desc: string; placeholder: string }> = {
  initial_visit: {
    desc: "首次接触,了解客户基本情况",
    placeholder: "拜访对象及职务、客户公司现状、业务痛点、初步合作意向、关键决策人……",
  },
  requirement: {
    desc: "深入调研,明确客户需求",
    placeholder: "客户的核心需求、需要的功能模块、现有系统情况、预算范围、期望上线时间……",
  },
  proposal: {
    desc: "提交解决方案与报价",
    placeholder: "提供的方案名称/版本、方案要点、报价金额、客户对方案的反馈……",
  },
  negotiation: {
    desc: "商务条款与价格谈判",
    placeholder: "谈判的价格、付款方式、服务条款、双方分歧点及让步情况、预计签约时间……",
  },
};

const METHODS = ["上门拜访", "电话沟通", "微信沟通", "视频会议", "客户来访", "其他"];

type FollowupForm = {
  opportunity_id: number | null;
  stage: string;
  follow_date: string;
  method: string;
  contact_name: string;
  content: string;
  next_plan: string;
  next_date: string;
};

export function FollowupDialog({
  open,
  onOpenChange,
  opportunityId,
  defaultStage,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  opportunityId?: number;
  defaultStage?: string;
}) {
  const { data: meta } = useCrmMeta();
  const qc = useQueryClient();
  const blank = (): FollowupForm => ({
    opportunity_id: opportunityId ?? null,
    stage: defaultStage && STAGE_GUIDE[defaultStage] ? defaultStage : "initial_visit",
    follow_date: today(),
    method: "上门拜访",
    contact_name: "",
    content: "",
    next_plan: "",
    next_date: "",
  });
  const [form, setForm] = useState<FollowupForm>(blank);
  useEffect(() => {
    if (open) setForm(blank());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, opportunityId, defaultStage]);
  const set = (patch: Partial<FollowupForm>) => setForm(f => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: () => crm("/followups", { method: "POST", body: form }),
    onSuccess: () => {
      toast.success("跟进记录已保存");
      qc.invalidateQueries({ queryKey: ["crm"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const guide = STAGE_GUIDE[form.stage];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>录入跟进记录</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="跟进客户" required>
            <OpportunitySelect
              value={form.opportunity_id}
              onChange={(id, opp) => set({ opportunity_id: id, contact_name: form.contact_name || opp.contact_name || "" })}
              excludeStages={["won", "lost"]}
              disabled={!!opportunityId}
            />
          </Field>
          <Field label="跟进阶段" required>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(meta?.followStages ?? []).map((s, i) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => set({ stage: s.key })}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors",
                    form.stage === s.key ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-accent"
                  )}
                >
                  <div className="text-xs text-muted-foreground">第 {i + 1} 步</div>
                  <div className="font-medium">{s.label}</div>
                  <div className="text-xs text-muted-foreground mt-1">{STAGE_GUIDE[s.key]?.desc}</div>
                </button>
              ))}
            </div>
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="跟进日期" required>
              <Input type="date" value={form.follow_date} onChange={e => set({ follow_date: e.target.value })} />
            </Field>
            <Field label="跟进方式">
              <Select value={form.method} onValueChange={v => set({ method: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METHODS.map(m => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="客户对接人">
              <Input value={form.contact_name} onChange={e => set({ contact_name: e.target.value })} placeholder="姓名/职务" />
            </Field>
          </div>
          <Field label="跟进内容" required>
            <Textarea rows={6} value={form.content} onChange={e => set({ content: e.target.value })} placeholder={guide?.placeholder} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="下一步计划" className="sm:col-span-2">
              <Input value={form.next_plan} onChange={e => set({ next_plan: e.target.value })} placeholder="如:下周提交方案并报价" />
            </Field>
            <Field label="下次跟进日期">
              <Input type="date" value={form.next_date} onChange={e => set({ next_date: e.target.value })} />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function CrmFollowups() {
  const { data: meta } = useCrmMeta();
  const qc = useQueryClient();
  const [stage, setStage] = useState("all");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["crm", "followups", stage, keyword, page],
    queryFn: () => crm<Paged<Followup>>(`/followups${qs({ stage: stage === "all" ? "" : stage, keyword, page })}`),
  });

  const remove = useMutation({
    mutationFn: (id: number) => crm(`/followups/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("已删除");
      qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <PageHeader
          title="客户跟进管理"
          description="按初次拜访 → 需求分析 → 方案提供 → 商务谈判记录每一次客户跟进"
          action={
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              录入跟进
            </Button>
          }
        />

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="搜索企业名称/跟进内容"
              value={keyword}
              onChange={e => {
                setKeyword(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <FilterChips
            value={stage}
            onChange={v => {
              setStage(v);
              setPage(1);
            }}
            options={[{ value: "all", label: "全部阶段" }, ...(meta?.followStages ?? []).map(s => ({ value: s.key, label: s.label }))]}
          />
        </div>

        <div className="rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">跟进日期</TableHead>
                <TableHead>客户</TableHead>
                <TableHead className="w-24">阶段</TableHead>
                <TableHead className="w-24">方式</TableHead>
                <TableHead>跟进内容</TableHead>
                <TableHead>下一步</TableHead>
                <TableHead className="w-20">记录人</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin inline" />
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && !data?.items.length && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                    暂无跟进记录
                  </TableCell>
                </TableRow>
              )}
              {data?.items.map(f => (
                <TableRow key={f.id}>
                  <TableCell>{f.follow_date}</TableCell>
                  <TableCell className="font-medium">{f.opportunity_name}</TableCell>
                  <TableCell>
                    <StageBadge stage={f.stage} meta={meta} />
                  </TableCell>
                  <TableCell>{f.method || "-"}</TableCell>
                  <TableCell className="max-w-md whitespace-pre-wrap text-sm">{f.content}</TableCell>
                  <TableCell className="text-sm">
                    {f.next_plan || "-"}
                    {f.next_date && <div className="text-xs text-muted-foreground">{f.next_date}</div>}
                  </TableCell>
                  <TableCell>{f.created_by}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (window.confirm("确定删除这条跟进记录?")) remove.mutate(f.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {data && data.total > data.pageSize && <DataPagination total={data.total} page={page} pageSize={data.pageSize} onChange={setPage} />}
      </div>
      <FollowupDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </DashboardLayout>
  );
}
