/**
 * 销售管理 · 销售合同管理
 * 路由: /crm/contracts(?new=<商机id> 直接发起生成合同;?view=<合同id> 打开合同)
 * 项目成交后,按公司合同模板生成销售合同:草稿 → 确认签订(商机自动标为已成交)→ 移交实施。
 */
import DashboardLayout from "@/components/DashboardLayout";
import DataPagination from "@/components/DataPagination";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  crm,
  qs,
  type CompanySettings,
  type Contract,
  type ContractModule,
  type ContractTemplate,
  type Paged,
} from "@/lib/crmApi";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, Edit, Eye, FileText, Loader2, Plus, Printer, Search, Send, Trash2, Wallet, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { toast } from "sonner";
import {
  CONTRACT_STATUS,
  docSrc,
  exportWord,
  Field,
  FilterChips,
  fmtMoney,
  fmtTime,
  HANDOVER_STATUS,
  ModulesEditor,
  OpportunitySelect,
  PageHeader,
  printDoc,
  StatusBadge,
  today,
  useCrmMeta,
} from "./shared";

const DEFAULT_PAYMENT = "合同签订后 5 个工作日内,甲方支付合同总额的 50% 作为预付款;项目验收合格后 5 个工作日内,甲方支付剩余 50%。";

type ContractForm = {
  opportunity_id: number | null;
  template_id: number | null;
  project_name: string;
  amount: string;
  sign_date: string;
  start_date: string;
  end_date: string;
  payment_terms: string;
  modules: ContractModule[];
  extra_terms: string;
};

function useTemplates() {
  return useQuery({ queryKey: ["crm", "templates"], queryFn: () => crm<{ items: ContractTemplate[] }>("/templates") });
}

function DocFrame({ title, html, className }: { title: string; html: string; className?: string }) {
  return <iframe title={title} srcDoc={docSrc(title, html)} className={cn("w-full rounded border bg-white", className)} />;
}

function ContractDialog({
  open,
  onOpenChange,
  editing,
  presetOpportunityId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: Contract | null;
  presetOpportunityId?: number | null;
  onSaved: (c: Contract) => void;
}) {
  const qc = useQueryClient();
  const { data: templates } = useTemplates();
  const [form, setForm] = useState<ContractForm>(() => blankForm());
  const [preview, setPreview] = useState<string | null>(null);

  function blankForm(): ContractForm {
    return {
      opportunity_id: presetOpportunityId ?? null,
      template_id: null,
      project_name: "",
      amount: "",
      sign_date: today(),
      start_date: "",
      end_date: "",
      payment_terms: DEFAULT_PAYMENT,
      modules: [{ name: "", description: "", amount: "" }],
      extra_terms: "",
    };
  }

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setForm(
      editing
        ? {
            opportunity_id: editing.opportunity_id,
            template_id: editing.template_id,
            project_name: editing.project_name,
            amount: String(editing.amount),
            sign_date: editing.sign_date ?? "",
            start_date: editing.start_date ?? "",
            end_date: editing.end_date ?? "",
            payment_terms: editing.payment_terms ?? "",
            modules: editing.modules,
            extra_terms: editing.extra_terms ?? "",
          }
        : blankForm()
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, presetOpportunityId]);

  useEffect(() => {
    if (open && !form.template_id && templates?.items.length) {
      setForm(f => ({ ...f, template_id: (templates.items.find(t => t.is_default) ?? templates.items[0]).id }));
    }
  }, [open, form.template_id, templates]);

  const set = (patch: Partial<ContractForm>) => setForm(f => ({ ...f, ...patch }));
  const moduleSum = form.modules.reduce((a, m) => a + (Number(m.amount) || 0), 0);

  const doPreview = useMutation({
    mutationFn: () => crm<{ content: string }>("/contracts/preview", { method: "POST", body: form }),
    onSuccess: d => setPreview(d.content),
    onError: (e: Error) => toast.error(e.message),
  });
  const save = useMutation({
    mutationFn: () =>
      editing ? crm<Contract>(`/contracts/${editing.id}`, { method: "PUT", body: form }) : crm<Contract>("/contracts", { method: "POST", body: form }),
    onSuccess: c => {
      toast.success(editing ? "合同已更新" : `合同 ${c.contract_no} 已生成`);
      qc.invalidateQueries({ queryKey: ["crm"] });
      onOpenChange(false);
      onSaved(c);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? `编辑合同 ${editing.contract_no}` : "生成销售合同"}</DialogTitle>
        </DialogHeader>
        {preview ? (
          <DocFrame title="合同预览" html={preview} className="h-[65vh]" />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="客户(商机)" required>
                <OpportunitySelect
                  value={form.opportunity_id}
                  onChange={(id, opp) => set({ opportunity_id: id, project_name: form.project_name || `${opp.name}项目` })}
                  excludeStages={["lost"]}
                  disabled={!!editing}
                />
              </Field>
              <Field label="合同模板" required>
                <Select value={form.template_id ? String(form.template_id) : undefined} onValueChange={v => set({ template_id: Number(v) })}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择模板" />
                  </SelectTrigger>
                  <SelectContent>
                    {templates?.items.map(t => (
                      <SelectItem key={t.id} value={String(t.id)}>
                        {t.name}
                        {t.is_default ? "(默认)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="项目名称" required>
                <Input value={form.project_name} onChange={e => set({ project_name: e.target.value })} />
              </Field>
              <Field
                label="合同金额(元,含税)"
                required
                hint={
                  moduleSum > 0 && Number(form.amount) !== moduleSum ? (
                    <button type="button" className="text-primary hover:underline" onClick={() => set({ amount: String(moduleSum) })}>
                      按模块合计填入 {fmtMoney(moduleSum)}
                    </button>
                  ) : undefined
                }
              >
                <Input type="number" min={0} value={form.amount} onChange={e => set({ amount: e.target.value })} />
              </Field>
              <Field label="签订日期">
                <Input type="date" value={form.sign_date} onChange={e => set({ sign_date: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="服务开始日期">
                  <Input type="date" value={form.start_date} onChange={e => set({ start_date: e.target.value })} />
                </Field>
                <Field label="服务结束日期">
                  <Input type="date" value={form.end_date} onChange={e => set({ end_date: e.target.value })} />
                </Field>
              </div>
            </div>
            <Field label="产品模块明细" required>
              <ModulesEditor value={form.modules} onChange={modules => set({ modules })} withAmount />
            </Field>
            <Field label="付款方式">
              <Textarea rows={2} value={form.payment_terms} onChange={e => set({ payment_terms: e.target.value })} />
            </Field>
            <Field label="补充条款">
              <Textarea rows={3} value={form.extra_terms} onChange={e => set({ extra_terms: e.target.value })} placeholder="没有可留空" />
            </Field>
          </div>
        )}
        <DialogFooter className="gap-2">
          {preview ? (
            <Button variant="outline" onClick={() => setPreview(null)}>
              返回修改
            </Button>
          ) : (
            <Button variant="outline" onClick={() => doPreview.mutate()} disabled={doPreview.isPending}>
              {doPreview.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Eye className="h-4 w-4 mr-2" />}
              预览合同
            </Button>
          )}
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {editing ? "保存修改" : "生成合同(草稿)"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PAY_METHODS = ["银行转账", "承兑汇票", "支票", "现金", "其他"];

/** 收款登记:已签订合同按实际到账逐笔登记,数字销售总监据此统计回款 */
function PaymentsPanel({ c }: { c: Contract }) {
  const qc = useQueryClient();
  const blank = () => ({ amount: "", pay_date: today(), method: "银行转账", remark: "" });
  const [form, setForm] = useState(blank);
  const received = c.received ?? 0;
  const unpaid = Math.round((c.amount - received) * 100) / 100;
  const refresh = () => qc.invalidateQueries({ queryKey: ["crm"] });
  const add = useMutation({
    mutationFn: () => crm(`/contracts/${c.id}/payments`, { method: "POST", body: form }),
    onSuccess: () => {
      toast.success("收款已登记");
      setForm(blank());
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (pid: number) => crm(`/payments/${pid}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("收款记录已删除");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="rounded-md border p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span className="font-medium flex items-center gap-1">
          <Wallet className="h-4 w-4" />
          收款情况
        </span>
        <span>已收 {fmtMoney(received)}</span>
        <span className={cn(unpaid > 0 ? "text-amber-700" : "text-emerald-700")}>{unpaid > 0 ? `未收 ${fmtMoney(unpaid)}` : "已全部收款"}</span>
        {c.payment_terms && <span className="text-muted-foreground text-xs basis-full">付款方式:{c.payment_terms}</span>}
      </div>
      {!!c.payments?.length && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">收款日期</TableHead>
              <TableHead className="w-32 text-right">金额</TableHead>
              <TableHead className="w-24">方式</TableHead>
              <TableHead>备注</TableHead>
              <TableHead className="w-24">登记人</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {c.payments.map(p => (
              <TableRow key={p.id}>
                <TableCell>{p.pay_date}</TableCell>
                <TableCell className="text-right">{fmtMoney(p.amount)}</TableCell>
                <TableCell>{p.method || "-"}</TableCell>
                <TableCell className="text-muted-foreground">{p.remark || "-"}</TableCell>
                <TableCell>{p.created_by}</TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      if (window.confirm(`删除 ${p.pay_date} 的这笔收款 ${fmtMoney(p.amount)}?`)) remove.mutate(p.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {unpaid > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="收款金额(元)" className="w-36">
            <Input type="number" min={0} value={form.amount} placeholder={String(unpaid)} onChange={e => setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label="收款日期" className="w-40">
            <Input type="date" value={form.pay_date} onChange={e => setForm({ ...form, pay_date: e.target.value })} />
          </Field>
          <Field label="方式" className="w-32">
            <Select value={form.method} onValueChange={v => setForm({ ...form, method: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAY_METHODS.map(m => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="备注" className="flex-1 min-w-40">
            <Input value={form.remark} placeholder="如:首付款 50%" onChange={e => setForm({ ...form, remark: e.target.value })} />
          </Field>
          <Button onClick={() => add.mutate()} disabled={add.isPending || !form.amount}>
            {add.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
            登记收款
          </Button>
        </div>
      )}
    </div>
  );
}

function ContractView({ id, onClose, onEdit }: { id: number | null; onClose: () => void; onEdit: (c: Contract) => void }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { data: c } = useQuery({ queryKey: ["crm", "contract", id], queryFn: () => crm<Contract>(`/contracts/${id}`), enabled: !!id });
  const act = useMutation({
    mutationFn: (action: "sign" | "void") => crm<Contract>(`/contracts/${id}/${action}`, { method: "POST", body: {} }),
    onSuccess: (_, action) => {
      toast.success(action === "sign" ? "合同已确认签订,商机已标记为成交" : "合同已作废");
      qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const title = c ? `${c.contract_no} ${c.project_name}` : "";
  return (
    <Dialog open={!!id} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-4xl max-h-[92vh] overflow-y-auto">
        {c && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {c.contract_no}
                <StatusBadge map={CONTRACT_STATUS} status={c.status} />
                {c.handover && <StatusBadge map={HANDOVER_STATUS} status={c.handover.status} />}
              </DialogTitle>
            </DialogHeader>
            <div className="text-sm text-muted-foreground flex flex-wrap gap-x-6 gap-y-1">
              <span>客户:{c.opportunity?.name}</span>
              <span>金额:{fmtMoney(c.amount)}</span>
              <span>签订日期:{c.sign_date || "-"}</span>
              <span>
                创建:{c.created_by} {fmtTime(c.created_at)}
              </span>
            </div>
            {c.status === "signed" && <PaymentsPanel c={c} />}
            <DocFrame title={title} html={c.content} className="h-[60vh]" />
            <DialogFooter className="flex-wrap gap-2 sm:justify-between">
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => printDoc(title, c.content) || toast.error("浏览器拦截了弹出窗口,请允许后重试")}>
                  <Printer className="h-4 w-4 mr-2" />
                  打印
                </Button>
                <Button variant="outline" onClick={() => exportWord(`销售合同-${c.contract_no}-${c.opportunity?.name ?? ""}`, title, c.content)}>
                  <Download className="h-4 w-4 mr-2" />
                  导出 Word
                </Button>
              </div>
              <div className="flex gap-2">
                {c.status === "draft" && (
                  <>
                    <Button variant="outline" onClick={() => onEdit(c)}>
                      <Edit className="h-4 w-4 mr-2" />
                      编辑
                    </Button>
                    <Button
                      onClick={() => {
                        if (window.confirm("确认合同已与客户签订?签订后合同不可再修改,商机将标记为「已成交」。")) act.mutate("sign");
                      }}
                      disabled={act.isPending}
                    >
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                      确认签订
                    </Button>
                  </>
                )}
                {c.status !== "void" && !c.handover && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (window.confirm("确定作废这份合同?")) act.mutate("void");
                    }}
                    disabled={act.isPending}
                  >
                    <XCircle className="h-4 w-4 mr-2" />
                    作废
                  </Button>
                )}
                {c.status === "signed" && !c.handover && (
                  <Button onClick={() => navigate(`/crm/handovers?new=${c.id}`)}>
                    <Send className="h-4 w-4 mr-2" />
                    移交实施
                  </Button>
                )}
                {c.handover && (
                  <Button variant="outline" onClick={() => navigate(`/crm/handovers?view=${c.handover!.id}`)}>
                    查看交接单 {c.handover.handover_no}
                  </Button>
                )}
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ContractList() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Contract | null>(null);
  const [presetOpp, setPresetOpp] = useState<number | null>(null);
  const [viewId, setViewId] = useState<number | null>(null);

  // 从商机详情「生成合同」/ 其他页面跳转过来
  useEffect(() => {
    const p = new URLSearchParams(search);
    const newOpp = Number(p.get("new"));
    const view = Number(p.get("view"));
    if (newOpp) {
      setEditing(null);
      setPresetOpp(newOpp);
      setDialogOpen(true);
    }
    if (view) setViewId(view);
    if (newOpp || view) navigate("/crm/contracts", { replace: true });
  }, [search, navigate]);

  const { data, isLoading } = useQuery({
    queryKey: ["crm", "contracts", keyword, status, page],
    queryFn: () => crm<Paged<Contract>>(`/contracts${qs({ keyword, status: status === "all" ? "" : status, page })}`),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="合同编号/项目/客户"
              value={keyword}
              onChange={e => {
                setKeyword(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <FilterChips
            value={status}
            onChange={v => {
              setStatus(v);
              setPage(1);
            }}
            options={[
              { value: "all", label: "全部" },
              { value: "draft", label: "草稿" },
              { value: "signed", label: "已签订" },
              { value: "void", label: "已作废" },
            ]}
          />
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setPresetOpp(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-2" />
          生成合同
        </Button>
      </div>

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-36">合同编号</TableHead>
              <TableHead>客户</TableHead>
              <TableHead>项目名称</TableHead>
              <TableHead className="w-32 text-right">合同金额</TableHead>
              <TableHead className="w-32 text-right">已收款</TableHead>
              <TableHead className="w-28">签订日期</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="w-28">交接</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin inline" />
                </TableCell>
              </TableRow>
            )}
            {!isLoading && !data?.items.length && (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                  暂无合同。项目成交后,可在此或商机详情中「生成合同」
                </TableCell>
              </TableRow>
            )}
            {data?.items.map(c => (
              <TableRow key={c.id} className="cursor-pointer" onClick={() => setViewId(c.id)}>
                <TableCell className="font-mono text-xs">{c.contract_no}</TableCell>
                <TableCell className="font-medium">{c.customer_name}</TableCell>
                <TableCell>{c.project_name}</TableCell>
                <TableCell className="text-right">{fmtMoney(c.amount)}</TableCell>
                <TableCell className={cn("text-right", c.status === "signed" && (c.received ?? 0) < c.amount && "text-amber-700")}>
                  {c.status === "signed" ? fmtMoney(c.received ?? 0) : "-"}
                </TableCell>
                <TableCell>{c.sign_date || "-"}</TableCell>
                <TableCell>
                  <StatusBadge map={CONTRACT_STATUS} status={c.status} />
                </TableCell>
                <TableCell>{c.handover_status ? <StatusBadge map={HANDOVER_STATUS} status={c.handover_status} /> : "-"}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm">
                    查看
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {data && data.total > data.pageSize && <DataPagination total={data.total} page={page} pageSize={data.pageSize} onChange={setPage} />}

      <ContractDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        presetOpportunityId={presetOpp}
        onSaved={c => setViewId(c.id)}
      />
      <ContractView
        id={viewId}
        onClose={() => setViewId(null)}
        onEdit={c => {
          setViewId(null);
          setEditing(c);
          setDialogOpen(true);
        }}
      />
    </div>
  );
}

function TemplatesTab() {
  const { data: meta } = useCrmMeta();
  const qc = useQueryClient();
  const { data } = useTemplates();
  const [selectedId, setSelectedId] = useState<number | "new" | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const current = data?.items.find(t => t.id === selectedId);
  useEffect(() => {
    if (selectedId === null && data?.items.length) setSelectedId(data.items[0].id);
  }, [data, selectedId]);
  useEffect(() => {
    if (selectedId === "new") {
      setName("新合同模板");
      setBody(data?.items.find(t => t.is_default)?.body ?? "");
      setIsDefault(false);
    } else if (current) {
      setName(current.name);
      setBody(current.body);
      setIsDefault(!!current.is_default);
    }
  }, [selectedId, current, data]);

  const save = useMutation({
    mutationFn: () =>
      selectedId === "new"
        ? crm<ContractTemplate>("/templates", { method: "POST", body: { name, body } })
        : crm<ContractTemplate>(`/templates/${selectedId}`, { method: "PUT", body: { name, body, is_default: isDefault } }),
    onSuccess: t => {
      toast.success("模板已保存,之后生成的合同会使用新模板(已生成的合同不受影响)");
      qc.invalidateQueries({ queryKey: ["crm", "templates"] });
      setSelectedId(t.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => crm(`/templates/${selectedId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("模板已删除");
      qc.invalidateQueries({ queryKey: ["crm", "templates"] });
      setSelectedId(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const insert = (key: string) => {
    const el = bodyRef.current;
    const token = `{{${key}}}`;
    if (!el) return setBody(b => b + token);
    const { selectionStart: s, selectionEnd: e } = el;
    setBody(b => b.slice(0, s) + token + b.slice(e));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = s + token.length;
    });
  };

  const previewHtml = body.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, '<mark style="background:#fff3bf">{{$1}}</mark>');

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4">
      <div className="space-y-2">
        {data?.items.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSelectedId(t.id)}
            className={cn("w-full text-left rounded-md border p-3 text-sm", selectedId === t.id ? "border-primary bg-primary/5" : "hover:bg-accent")}
          >
            <div className="font-medium flex items-center gap-1">
              <FileText className="h-4 w-4" />
              {t.name}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {t.is_default ? "默认模板 · " : ""}
              {fmtTime(t.updated_at)}
            </div>
          </button>
        ))}
        <Button variant="outline" className="w-full" onClick={() => setSelectedId("new")}>
          <Plus className="h-4 w-4 mr-2" />
          新建模板
        </Button>
      </div>

      {selectedId !== null && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="模板名称" className="w-64">
              <Input value={name} onChange={e => setName(e.target.value)} />
            </Field>
            {selectedId !== "new" && (
              <label className="flex items-center gap-2 text-sm pb-2">
                <Checkbox checked={isDefault} onCheckedChange={v => setIsDefault(!!v)} />
                设为默认模板
              </label>
            )}
            <div className="flex gap-2 ml-auto">
              <Button variant="outline" onClick={() => setShowPreview(v => !v)}>
                <Eye className="h-4 w-4 mr-2" />
                {showPreview ? "编辑正文" : "预览版式"}
              </Button>
              {selectedId !== "new" && !current?.is_default && (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (window.confirm("确定删除这个模板?")) remove.mutate();
                  }}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  删除
                </Button>
              )}
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                保存模板
              </Button>
            </div>
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="text-sm font-medium mb-2">可用字段(点击插入到光标处,生成合同时自动替换)</div>
            <div className="flex flex-wrap gap-1.5">
              {meta?.placeholders.map(p => (
                <button
                  key={p.key}
                  type="button"
                  title={p.desc}
                  onClick={() => insert(p.key)}
                  className="rounded border bg-background px-2 py-0.5 text-xs font-mono hover:bg-accent"
                >
                  {`{{${p.key}}}`}
                </button>
              ))}
            </div>
          </div>
          {showPreview ? (
            <DocFrame title="模板预览" html={previewHtml} className="h-[60vh]" />
          ) : (
            <Textarea ref={bodyRef} value={body} onChange={e => setBody(e.target.value)} className="h-[60vh] font-mono text-xs" spellCheck={false} />
          )}
          <p className="text-xs text-muted-foreground">
            模板正文为 HTML 格式:&lt;h3&gt; 为条款标题,&lt;p&gt; 为段落。可以把公司 Word 合同的条款文字粘贴进来,需要自动填写的地方换成上面的字段。
          </p>
        </div>
      )}
    </div>
  );
}

function CompanyTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["crm", "company"], queryFn: () => crm<CompanySettings>("/settings/company") });
  const [form, setForm] = useState<CompanySettings | null>(null);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);
  const save = useMutation({
    mutationFn: () => crm<CompanySettings>("/settings/company", { method: "PUT", body: form }),
    onSuccess: () => {
      toast.success("我方信息已保存");
      qc.invalidateQueries({ queryKey: ["crm", "company"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!form) return null;
  const set = (patch: Partial<CompanySettings>) => setForm(f => (f ? { ...f, ...patch } : f));
  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-muted-foreground">合同中的乙方(我方)信息,生成合同时自动填入。</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="公司名称" className="sm:col-span-2">
          <Input value={form.name} onChange={e => set({ name: e.target.value })} />
        </Field>
        <Field label="统一社会信用代码">
          <Input value={form.credit_code} onChange={e => set({ credit_code: e.target.value.toUpperCase() })} className="font-mono" />
        </Field>
        <Field label="联系人">
          <Input value={form.contact} onChange={e => set({ contact: e.target.value })} />
        </Field>
        <Field label="联系电话">
          <Input value={form.phone} onChange={e => set({ phone: e.target.value })} />
        </Field>
        <Field label="地址">
          <Input value={form.address} onChange={e => set({ address: e.target.value })} />
        </Field>
        <Field label="开户银行">
          <Input value={form.bank_name} onChange={e => set({ bank_name: e.target.value })} />
        </Field>
        <Field label="银行账号">
          <Input value={form.bank_account} onChange={e => set({ bank_account: e.target.value })} className="font-mono" />
        </Field>
      </div>
      <Button onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        保存
      </Button>
    </div>
  );
}

export default function CrmContracts() {
  return (
    <DashboardLayout>
      <div className="space-y-4">
        <PageHeader title="销售合同管理" description="项目成交后,按公司合同模板一键生成销售合同,签订后移交实施部" />
        <Tabs defaultValue="list">
          <TabsList>
            <TabsTrigger value="list">合同列表</TabsTrigger>
            <TabsTrigger value="templates">合同模板</TabsTrigger>
            <TabsTrigger value="company">我方信息</TabsTrigger>
          </TabsList>
          <TabsContent value="list" className="mt-4">
            <ContractList />
          </TabsContent>
          <TabsContent value="templates" className="mt-4">
            <TemplatesTab />
          </TabsContent>
          <TabsContent value="company" className="mt-4">
            <CompanyTab />
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
