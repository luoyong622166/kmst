/**
 * 销售管理 · 商机管理
 * 路由: /crm/opportunities(?view=<商机id> 直接打开详情)
 * 商机 = 意向客户。录入时对接工商信息取统一社会信用代码,按信用代码 + 企业名双重查重,保证一家企业只有一条商机。
 */
import DashboardLayout from "@/components/DashboardLayout";
import DataPagination from "@/components/DataPagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { crm, qs, type CompanyInfo, type Opportunity, type Paged } from "@/lib/crmApi";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Building2, CheckCircle2, Edit, FileSignature, Loader2, MessageSquarePlus, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { toast } from "sonner";
import { FollowupDialog } from "./Followups";
import { CONTRACT_STATUS, Field, FilterChips, fmtMoney, PageHeader, StageBadge, StatusBadge, useCrmMeta } from "./shared";

type OppForm = {
  name: string;
  credit_code: string;
  legal_person: string;
  reg_status: string;
  reg_capital: string;
  establish_date: string;
  address: string;
  business_scope: string;
  industry: string;
  info_source: string;
  contact_name: string;
  contact_title: string;
  contact_phone: string;
  lead_source: string;
  owner: string;
  stage: string;
  expected_amount: string;
  expected_close: string;
  remark: string;
};

const EMPTY_FORM: OppForm = {
  name: "",
  credit_code: "",
  legal_person: "",
  reg_status: "",
  reg_capital: "",
  establish_date: "",
  address: "",
  business_scope: "",
  industry: "",
  info_source: "manual",
  contact_name: "",
  contact_title: "",
  contact_phone: "",
  lead_source: "",
  owner: "",
  stage: "new",
  expected_amount: "",
  expected_close: "",
  remark: "",
};

const LEAD_SOURCES = ["客户转介绍", "电话营销", "网络推广", "展会活动", "老客户复购", "合作伙伴", "其他"];
const PROVIDER_NAME = { tianyancha: "天眼查", qichacha: "企查查" } as const;

function toForm(o: Opportunity): OppForm {
  const f = { ...EMPTY_FORM };
  for (const k of Object.keys(EMPTY_FORM) as (keyof OppForm)[]) {
    const v = (o as any)[k];
    f[k] = v === null || v === undefined ? "" : String(v);
  }
  return f;
}

/** 工商信息查询区:按企业名检索 → 选中后带出信用代码等工商字段 */
function CompanyLookup({ onPick }: { onPick: (c: CompanyInfo) => void }) {
  const { data: meta } = useCrmMeta();
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<CompanyInfo[] | null>(null);
  const search = useMutation({
    mutationFn: () => crm<{ items: CompanyInfo[] }>(`/lookup/search${qs({ keyword })}`),
    onSuccess: d => setResults(d.items),
    onError: (e: Error) => toast.error(e.message),
  });
  const detail = useMutation({
    mutationFn: (c: CompanyInfo) => crm<CompanyInfo>(`/lookup/detail${qs({ keyword: c.creditCode || c.name })}`),
    onSuccess: d => {
      onPick(d);
      setResults(null);
      toast.success("已带出工商信息");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!meta?.lookupProvider) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
        <div>
          尚未配置工商信息接口(天眼查 / 企查查),请手动填写企业名称和统一社会信用代码。系统会按国家标准校验信用代码,并自动检查是否重复录入。
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="text-sm font-medium">从{PROVIDER_NAME[meta.lookupProvider]}查询工商信息</div>
      <div className="flex gap-2">
        <Input
          placeholder="输入企业名称关键字"
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
          onKeyDown={e => e.key === "Enter" && keyword.trim().length >= 2 && search.mutate()}
        />
        <Button type="button" onClick={() => search.mutate()} disabled={keyword.trim().length < 2 || search.isPending}>
          {search.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          <span className="ml-1">查询</span>
        </Button>
      </div>
      {results && (
        <div className="max-h-56 overflow-y-auto rounded border bg-background divide-y">
          {!results.length && <div className="p-3 text-sm text-muted-foreground">没有查到匹配的企业</div>}
          {results.map(c => (
            <button
              key={c.creditCode || c.name}
              type="button"
              disabled={!!c.existing || detail.isPending}
              onClick={() => detail.mutate(c)}
              className="w-full text-left p-2.5 hover:bg-accent disabled:opacity-60 disabled:hover:bg-transparent"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{c.name}</span>
                {c.regStatus && <span className="text-xs text-muted-foreground">{c.regStatus}</span>}
                {c.existing && (
                  <Badge variant="outline" className="text-amber-700 border-amber-300">
                    已录入{c.existing.owner ? `(${c.existing.owner})` : ""}
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {c.creditCode || "无信用代码"} · 法人 {c.legalPerson || "-"} · 成立 {c.establishDate || "-"}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function OpportunityDialog({ open, onOpenChange, editing }: { open: boolean; onOpenChange: (v: boolean) => void; editing: Opportunity | null }) {
  const { data: meta } = useCrmMeta();
  const qc = useQueryClient();
  const [form, setForm] = useState<OppForm>(EMPTY_FORM);
  const [check, setCheck] = useState<{ creditCodeValid: boolean | null; message: string | null } | null>(null);
  useEffect(() => {
    if (open) {
      setForm(editing ? toForm(editing) : { ...EMPTY_FORM, owner: meta?.user.name ?? "" });
      setCheck(null);
    }
  }, [open, editing, meta?.user.name]);
  const set = (patch: Partial<OppForm>) => setForm(f => ({ ...f, ...patch }));

  // 信用代码/企业名实时校验 + 查重
  useEffect(() => {
    if (!open || (!form.credit_code && !form.name)) {
      setCheck(null);
      return;
    }
    const t = setTimeout(() => {
      crm<{ creditCodeValid: boolean | null; message: string | null }>(
        `/opportunities/check${qs({ creditCode: form.credit_code, name: form.name, excludeId: editing?.id })}`
      )
        .then(setCheck)
        .catch(() => setCheck(null));
    }, 400);
    return () => clearTimeout(t);
  }, [open, form.credit_code, form.name, editing?.id]);

  const save = useMutation({
    mutationFn: () =>
      editing ? crm(`/opportunities/${editing.id}`, { method: "PUT", body: form }) : crm("/opportunities", { method: "POST", body: form }),
    onSuccess: () => {
      toast.success(editing ? "商机已更新" : "商机已创建");
      qc.invalidateQueries({ queryKey: ["crm"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const fromRegistry = form.info_source !== "manual";
  const codeBad = form.credit_code.length > 0 && check?.creditCodeValid === false;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑商机" : "新建商机"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <section className="space-y-3">
            <h3 className="font-semibold flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              企业工商信息
            </h3>
            <CompanyLookup
              onPick={c =>
                set({
                  name: c.name,
                  credit_code: c.creditCode,
                  legal_person: c.legalPerson,
                  reg_status: c.regStatus,
                  reg_capital: c.regCapital,
                  establish_date: c.establishDate,
                  address: c.address,
                  business_scope: c.businessScope,
                  industry: c.industry,
                  info_source: meta?.lookupProvider ?? "manual",
                })
              }
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="企业名称" required>
                <Input value={form.name} onChange={e => set({ name: e.target.value, info_source: "manual" })} placeholder="与营业执照一致的全称" />
              </Field>
              <Field
                label="统一社会信用代码"
                required
                hint={
                  codeBad ? (
                    <span className="text-destructive">信用代码校验不通过,请核对</span>
                  ) : check?.creditCodeValid ? (
                    <span className="text-emerald-600 inline-flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      信用代码有效{fromRegistry ? "(来自工商信息)" : ""}
                    </span>
                  ) : (
                    "18 位,营业执照左上角"
                  )
                }
              >
                <Input
                  value={form.credit_code}
                  onChange={e => set({ credit_code: e.target.value.toUpperCase().trim(), info_source: "manual" })}
                  maxLength={18}
                  className={cn("font-mono", codeBad && "border-destructive")}
                />
              </Field>
            </div>
            {check?.message && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                {check.message}
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Field label="法定代表人">
                <Input value={form.legal_person} onChange={e => set({ legal_person: e.target.value })} />
              </Field>
              <Field label="经营状态">
                <Input value={form.reg_status} onChange={e => set({ reg_status: e.target.value })} placeholder="存续/在业" />
              </Field>
              <Field label="注册资本">
                <Input value={form.reg_capital} onChange={e => set({ reg_capital: e.target.value })} />
              </Field>
              <Field label="成立日期">
                <Input type="date" value={form.establish_date} onChange={e => set({ establish_date: e.target.value })} />
              </Field>
              <Field label="所属行业">
                <Input value={form.industry} onChange={e => set({ industry: e.target.value })} />
              </Field>
              <Field label="注册地址" className="col-span-2 sm:col-span-3">
                <Input value={form.address} onChange={e => set({ address: e.target.value })} />
              </Field>
            </div>
            <Field label="经营范围">
              <Textarea rows={2} value={form.business_scope} onChange={e => set({ business_scope: e.target.value })} />
            </Field>
          </section>

          <section className="space-y-3">
            <h3 className="font-semibold">商机信息</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Field label="联系人">
                <Input value={form.contact_name} onChange={e => set({ contact_name: e.target.value })} />
              </Field>
              <Field label="联系人职务">
                <Input value={form.contact_title} onChange={e => set({ contact_title: e.target.value })} />
              </Field>
              <Field label="联系电话">
                <Input value={form.contact_phone} onChange={e => set({ contact_phone: e.target.value })} />
              </Field>
              <Field label="商机来源">
                <Select value={form.lead_source || undefined} onValueChange={v => set({ lead_source: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="请选择" />
                  </SelectTrigger>
                  <SelectContent>
                    {LEAD_SOURCES.map(s => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="负责销售">
                <Input value={form.owner} onChange={e => set({ owner: e.target.value })} />
              </Field>
              {editing && (
                <Field label="商机阶段">
                  <Select value={form.stage} onValueChange={v => set({ stage: v })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {meta?.stages.map(s => (
                        <SelectItem key={s.key} value={s.key}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Field label="预计金额(元)">
                <Input type="number" min={0} value={form.expected_amount} onChange={e => set({ expected_amount: e.target.value })} />
              </Field>
              <Field label="预计成交日期">
                <Input type="date" value={form.expected_close} onChange={e => set({ expected_close: e.target.value })} />
              </Field>
            </div>
            <Field label="备注">
              <Textarea rows={2} value={form.remark} onChange={e => set({ remark: e.target.value })} />
            </Field>
          </section>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || codeBad || !!check?.message}>
            {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-3 text-sm py-1">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="flex-1 break-all">{value || "-"}</span>
    </div>
  );
}

function OpportunityDetail({ id, onClose, onEdit }: { id: number | null; onClose: () => void; onEdit: (o: Opportunity) => void }) {
  const { data: meta } = useCrmMeta();
  const [, navigate] = useLocation();
  const [followOpen, setFollowOpen] = useState(false);
  const { data: opp } = useQuery({
    queryKey: ["crm", "opportunity", id],
    queryFn: () => crm<Opportunity>(`/opportunities/${id}`),
    enabled: !!id,
  });
  const nextStage = meta?.followStages.find(s => (meta.stages.findIndex(x => x.key === s.key) ?? 0) > meta.stages.findIndex(x => x.key === opp?.stage))?.key;
  return (
    <Sheet open={!!id} onOpenChange={v => !v && onClose()}>
      <SheetContent className="sm:max-w-xl w-full overflow-y-auto">
        {opp && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2 pr-6">
                {opp.name}
                <StageBadge stage={opp.stage} meta={meta} />
              </SheetTitle>
            </SheetHeader>
            <div className="px-4 pb-6 space-y-5">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setFollowOpen(true)} disabled={opp.stage === "won" || opp.stage === "lost"}>
                  <MessageSquarePlus className="h-4 w-4 mr-1" />
                  录入跟进
                </Button>
                <Button size="sm" variant="outline" onClick={() => navigate(`/crm/contracts?new=${opp.id}`)} disabled={opp.stage === "lost"}>
                  <FileSignature className="h-4 w-4 mr-1" />
                  生成合同
                </Button>
                <Button size="sm" variant="outline" onClick={() => onEdit(opp)}>
                  <Edit className="h-4 w-4 mr-1" />
                  编辑
                </Button>
              </div>

              <section>
                <h4 className="font-semibold mb-1">工商信息</h4>
                <InfoRow label="信用代码" value={<span className="font-mono">{opp.credit_code}</span>} />
                <InfoRow label="法定代表人" value={opp.legal_person} />
                <InfoRow label="经营状态" value={opp.reg_status} />
                <InfoRow label="注册资本" value={opp.reg_capital} />
                <InfoRow label="成立日期" value={opp.establish_date} />
                <InfoRow label="所属行业" value={opp.industry} />
                <InfoRow label="注册地址" value={opp.address} />
                <InfoRow
                  label="信息来源"
                  value={opp.info_source === "manual" ? "手动录入" : PROVIDER_NAME[opp.info_source as keyof typeof PROVIDER_NAME] ?? opp.info_source}
                />
              </section>

              <section>
                <h4 className="font-semibold mb-1">商机信息</h4>
                <InfoRow label="联系人" value={[opp.contact_name, opp.contact_title].filter(Boolean).join(" · ")} />
                <InfoRow label="联系电话" value={opp.contact_phone} />
                <InfoRow label="商机来源" value={opp.lead_source} />
                <InfoRow label="负责销售" value={opp.owner} />
                <InfoRow label="预计金额" value={opp.expected_amount != null ? fmtMoney(opp.expected_amount) : ""} />
                <InfoRow label="预计成交" value={opp.expected_close} />
                <InfoRow label="备注" value={opp.remark} />
              </section>

              {!!opp.contracts?.length && (
                <section>
                  <h4 className="font-semibold mb-2">销售合同</h4>
                  <div className="space-y-2">
                    {opp.contracts.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        className="w-full flex items-center justify-between rounded border p-2 text-sm hover:bg-accent"
                        onClick={() => navigate(`/crm/contracts?view=${c.id}`)}
                      >
                        <span>
                          {c.contract_no} · {c.project_name}
                        </span>
                        <span className="flex items-center gap-2">
                          {fmtMoney(c.amount)}
                          <StatusBadge map={CONTRACT_STATUS} status={c.status} />
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <section>
                <h4 className="font-semibold mb-2">跟进记录({opp.followups?.length ?? 0})</h4>
                {!opp.followups?.length && <div className="text-sm text-muted-foreground">还没有跟进记录</div>}
                <ol className="relative border-l ml-2 space-y-4">
                  {opp.followups?.map(f => (
                    <li key={f.id} className="ml-4">
                      <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-background bg-primary" />
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium">{f.follow_date}</span>
                        <StageBadge stage={f.stage} meta={meta} />
                        <span className="text-muted-foreground">
                          {f.method}
                          {f.contact_name ? ` · ${f.contact_name}` : ""} · {f.created_by}
                        </span>
                      </div>
                      <div className="text-sm mt-1 whitespace-pre-wrap">{f.content}</div>
                      {f.next_plan && (
                        <div className="text-xs text-muted-foreground mt-1">
                          下一步:{f.next_plan}
                          {f.next_date ? `(${f.next_date})` : ""}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            </div>
            <FollowupDialog open={followOpen} onOpenChange={setFollowOpen} opportunityId={opp.id} defaultStage={nextStage ?? opp.stage} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default function CrmOpportunities() {
  const { data: meta } = useCrmMeta();
  const qc = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const [stage, setStage] = useState("all");
  const [owner, setOwner] = useState("all");
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Opportunity | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const search = useSearch();
  const [, navigate] = useLocation();

  // 从数字销售总监等页面跳转过来:?view=<商机id> 直接打开详情
  useEffect(() => {
    const view = Number(new URLSearchParams(search).get("view"));
    if (view) {
      setDetailId(view);
      navigate("/crm/opportunities", { replace: true });
    }
  }, [search, navigate]);

  const { data: stats } = useQuery({
    queryKey: ["crm", "stats"],
    queryFn: () => crm<{ byStage: { stage: string; n: number }[] }>("/stats"),
  });
  const { data: owners } = useQuery({
    queryKey: ["crm", "owners"],
    queryFn: () => crm<{ items: string[] }>("/opportunities/owners"),
  });
  const { data, isLoading } = useQuery({
    queryKey: ["crm", "opportunities", keyword, stage, owner, page],
    queryFn: () =>
      crm<Paged<Opportunity>>(`/opportunities${qs({ keyword, stage: stage === "all" ? "" : stage, owner: owner === "all" ? "" : owner, page })}`),
  });

  const remove = useMutation({
    mutationFn: (id: number) => crm(`/opportunities/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("商机已删除");
      qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const countOf = (k: string) => stats?.byStage.find(s => s.stage === k)?.n ?? 0;
  const total = stats?.byStage.reduce((a, s) => a + s.n, 0) ?? 0;

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <PageHeader
          title="商机管理"
          description="录入意向客户,对接工商信息确保每家企业只有一条商机"
          action={
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              新建商机
            </Button>
          }
        />

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="企业名称/信用代码/联系人"
              value={keyword}
              onChange={e => {
                setKeyword(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <Select
            value={owner}
            onValueChange={v => {
              setOwner(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部销售</SelectItem>
              {owners?.items.map(o => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FilterChips
            value={stage}
            onChange={v => {
              setStage(v);
              setPage(1);
            }}
            options={[
              { value: "all", label: "全部", count: total },
              ...(meta?.stages ?? []).map(s => ({ value: s.key, label: s.label, count: countOf(s.key) })),
            ]}
          />
        </div>

        <div className="rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>企业名称</TableHead>
                <TableHead className="w-44">统一社会信用代码</TableHead>
                <TableHead>联系人</TableHead>
                <TableHead className="w-24">阶段</TableHead>
                <TableHead className="w-24">负责销售</TableHead>
                <TableHead className="w-32 text-right">预计金额</TableHead>
                <TableHead className="w-28">最近跟进</TableHead>
                <TableHead className="w-28" />
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
                    暂无商机,点击右上角「新建商机」录入第一个意向客户
                  </TableCell>
                </TableRow>
              )}
              {data?.items.map(o => (
                <TableRow key={o.id} className="cursor-pointer" onClick={() => setDetailId(o.id)}>
                  <TableCell className="font-medium">{o.name}</TableCell>
                  <TableCell className="font-mono text-xs">{o.credit_code}</TableCell>
                  <TableCell className="text-sm">
                    {o.contact_name || "-"}
                    {o.contact_phone && <div className="text-xs text-muted-foreground">{o.contact_phone}</div>}
                  </TableCell>
                  <TableCell>
                    <StageBadge stage={o.stage} meta={meta} />
                  </TableCell>
                  <TableCell>{o.owner || "-"}</TableCell>
                  <TableCell className="text-right">{o.expected_amount != null ? fmtMoney(o.expected_amount) : "-"}</TableCell>
                  <TableCell className="text-sm">
                    {o.last_follow_date || "-"}
                    {!!o.followup_count && <div className="text-xs text-muted-foreground">共 {o.followup_count} 次</div>}
                  </TableCell>
                  <TableCell onClick={e => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setEditing(o);
                        setDialogOpen(true);
                      }}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (window.confirm(`确定删除商机「${o.name}」?其跟进记录会一并删除。`)) remove.mutate(o.id);
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

      <OpportunityDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />
      <OpportunityDetail
        id={detailId}
        onClose={() => setDetailId(null)}
        onEdit={o => {
          setEditing(o);
          setDialogOpen(true);
        }}
      />
    </DashboardLayout>
  );
}
