/**
 * 销售管理 · 销售交接管理
 * 路由: /crm/handovers(?new=<合同id> 直接发起交接;?view=<交接单id> 打开交接单)
 * 已签订的销售合同移交实施部:交接单含模块信息、主要需求、主要交接的价值点、主要风险点,实施部确认接收。
 */
import DashboardLayout from "@/components/DashboardLayout";
import DataPagination from "@/components/DataPagination";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { crm, qs, type Contract, type ContractModule, type Handover, type Paged } from "@/lib/crmApi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, Edit, Loader2, Plus, Printer, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { toast } from "sonner";
import {
  docSrc,
  escapeHtml,
  exportWord,
  Field,
  FilterChips,
  fmtMoney,
  fmtTime,
  HANDOVER_STATUS,
  ModulesEditor,
  PageHeader,
  printDoc,
  StatusBadge,
  today,
} from "./shared";

type HandoverForm = {
  contract_id: number | null;
  modules: ContractModule[];
  main_requirements: string;
  value_points: string;
  risk_points: string;
  impl_owner: string;
  handover_date: string;
  remark: string;
};

function handoverHtml(h: Handover) {
  const t = (s: string | null | undefined) => `<div class="pre">${escapeHtml(s) || "-"}</div>`;
  const modules = h.modules.length
    ? `<table class="modules"><tr><th width="8%">序号</th><th width="28%">模块名称</th><th>说明</th></tr>${h.modules
        .map((m, i) => `<tr><td style="text-align:center">${i + 1}</td><td>${escapeHtml(m.name)}</td><td>${escapeHtml(m.description)}</td></tr>`)
        .join("")}</table>`
    : "<p>(无)</p>";
  return `<h1>销售交接单</h1>
<p style="text-align:right">交接单号:${escapeHtml(h.handover_no)}</p>
<h2>一、项目基本信息</h2>
<table class="grid">
  <tr><th>客户名称</th><td>${escapeHtml(h.customer_name)}</td><th>合同编号</th><td>${escapeHtml(h.contract_no)}</td></tr>
  <tr><th>项目名称</th><td>${escapeHtml(h.project_name)}</td><th>合同金额</th><td>${escapeHtml(fmtMoney(h.amount))}</td></tr>
  <tr><th>签订日期</th><td>${escapeHtml(h.sign_date) || "-"}</td><th>服务期</th><td>${escapeHtml(h.start_date) || "-"} 至 ${escapeHtml(h.end_date) || "-"}</td></tr>
  <tr><th>客户联系人</th><td>${escapeHtml(h.contact_name) || "-"} ${escapeHtml(h.contact_phone)}</td><th>销售负责人</th><td>${escapeHtml(h.sales_owner) || "-"}</td></tr>
  <tr><th>实施负责人</th><td>${escapeHtml(h.impl_owner) || "-"}</td><th>交接日期</th><td>${escapeHtml(h.handover_date)}</td></tr>
</table>
<h2>二、模块信息</h2>
${modules}
<h2>三、主要需求</h2>
${t(h.main_requirements)}
<h2>四、主要交接的价值点</h2>
${t(h.value_points)}
<h2>五、主要风险点</h2>
${t(h.risk_points)}
<h2>六、备注</h2>
${t(h.remark)}
<table class="sign" style="margin-top:32px">
  <tr><td width="50%">移交人(销售):${escapeHtml(h.created_by)}</td><td>接收人(实施部):${escapeHtml(h.received_by)}</td></tr>
  <tr><td>日期:${escapeHtml(h.handover_date)}</td><td>日期:${h.received_at ? escapeHtml(fmtTime(h.received_at)) : ""}</td></tr>
</table>`;
}

function HandoverDialog({
  open,
  onOpenChange,
  editing,
  presetContractId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: Handover | null;
  presetContractId?: number | null;
  onSaved: (h: Handover) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<HandoverForm | null>(null);
  const { data: contracts } = useQuery({
    queryKey: ["crm", "contracts", "to-handover"],
    queryFn: () => crm<Paged<Contract>>(`/contracts${qs({ status: "signed", pageSize: 100 })}`),
    enabled: open && !editing,
  });
  const candidates = (contracts?.items ?? []).filter(c => !c.handover_id);

  useEffect(() => {
    if (!open) return;
    setForm(
      editing
        ? {
            contract_id: editing.contract_id,
            modules: editing.modules,
            main_requirements: editing.main_requirements,
            value_points: editing.value_points,
            risk_points: editing.risk_points,
            impl_owner: editing.impl_owner ?? "",
            handover_date: editing.handover_date,
            remark: editing.remark ?? "",
          }
        : {
            contract_id: null,
            modules: [],
            main_requirements: "",
            value_points: "",
            risk_points: "",
            impl_owner: "",
            handover_date: today(),
            remark: "",
          }
    );
  }, [open, editing]);

  const pickContract = (c: Contract) =>
    setForm(f => (f ? { ...f, contract_id: c.id, modules: c.modules.map(m => ({ name: m.name, description: m.description })) } : f));

  // 从合同页「移交实施」跳转过来:合同列表加载后自动选中
  useEffect(() => {
    if (open && !editing && presetContractId && form && !form.contract_id) {
      const c = candidates.find(x => x.id === presetContractId);
      if (c) pickContract(c);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, presetContractId, contracts, form?.contract_id]);

  const save = useMutation({
    mutationFn: () =>
      editing ? crm<Handover>(`/handovers/${editing.id}`, { method: "PUT", body: form }) : crm<Handover>("/handovers", { method: "POST", body: form }),
    onSuccess: h => {
      toast.success(editing ? "交接单已更新" : `交接单 ${h.handover_no} 已提交实施部`);
      qc.invalidateQueries({ queryKey: ["crm"] });
      onOpenChange(false);
      onSaved(h);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!form) return null;
  const set = (patch: Partial<HandoverForm>) => setForm(f => (f ? { ...f, ...patch } : f));
  const selected = candidates.find(c => c.id === form.contract_id);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? `编辑交接单 ${editing.handover_no}` : "新建销售交接单"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {editing ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              {editing.contract_no} · {editing.customer_name} · {editing.project_name} · {fmtMoney(editing.amount)}
            </div>
          ) : (
            <Field label="移交合同" required hint={!candidates.length ? "没有待移交的合同:合同需先「确认签订」才能移交实施" : undefined}>
              <Select
                value={form.contract_id ? String(form.contract_id) : undefined}
                onValueChange={v => {
                  const c = candidates.find(x => x.id === Number(v));
                  if (c) pickContract(c);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择已签订的销售合同" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.contract_no} · {c.customer_name} · {c.project_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selected && (
                <div className="text-xs text-muted-foreground mt-1">
                  合同金额 {fmtMoney(selected.amount)} · 签订日期 {selected.sign_date || "-"}
                </div>
              )}
            </Field>
          )}
          <Field label="模块信息" hint="默认带出合同中的产品模块,可补充实施相关说明">
            <ModulesEditor value={form.modules} onChange={modules => set({ modules })} />
          </Field>
          <Field label="主要需求" required>
            <Textarea
              rows={4}
              value={form.main_requirements}
              onChange={e => set({ main_requirements: e.target.value })}
              placeholder="客户的核心业务需求、必须实现的功能、上线时间要求、对接的系统……"
            />
          </Field>
          <Field label="主要交接的价值点" required>
            <Textarea
              rows={4}
              value={form.value_points}
              onChange={e => set({ value_points: e.target.value })}
              placeholder="客户购买的核心理由、销售阶段承诺的价值、客户最看重的效果、关键决策人关注点……"
            />
          </Field>
          <Field label="主要风险点" required>
            <Textarea
              rows={4}
              value={form.risk_points}
              onChange={e => set({ risk_points: e.target.value })}
              placeholder="需求不明确之处、客户配合度、工期/预算压力、销售阶段的口头承诺、客户内部阻力……"
            />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="实施负责人">
              <Input value={form.impl_owner} onChange={e => set({ impl_owner: e.target.value })} placeholder="实施部对接人" />
            </Field>
            <Field label="交接日期" required>
              <Input type="date" value={form.handover_date} onChange={e => set({ handover_date: e.target.value })} />
            </Field>
          </div>
          <Field label="备注">
            <Textarea rows={2} value={form.remark} onChange={e => set({ remark: e.target.value })} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {editing ? "保存修改" : "提交实施部"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HandoverView({ id, onClose, onEdit }: { id: number | null; onClose: () => void; onEdit: (h: Handover) => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const { data: h } = useQuery({ queryKey: ["crm", "handover", id], queryFn: () => crm<Handover>(`/handovers/${id}`), enabled: !!id });
  const receive = useMutation({
    mutationFn: () => crm<Handover>(`/handovers/${id}/receive`, { method: "POST", body: { note } }),
    onSuccess: () => {
      toast.success("实施部已确认接收");
      setNote("");
      qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const html = h ? handoverHtml(h) : "";
  const title = h ? `销售交接单 ${h.handover_no}` : "";
  return (
    <Dialog open={!!id} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-4xl max-h-[92vh] overflow-y-auto">
        {h && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {h.handover_no}
                <StatusBadge map={HANDOVER_STATUS} status={h.status} />
              </DialogTitle>
            </DialogHeader>
            <iframe title={title} srcDoc={docSrc(title, html)} className="w-full h-[55vh] rounded border bg-white" />
            {h.status === "received" ? (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                {h.received_by} 于 {fmtTime(h.received_at)} 确认接收{h.received_note ? `:${h.received_note}` : ""}
              </div>
            ) : (
              <Field label="实施部接收意见(可选)">
                <Input value={note} onChange={e => setNote(e.target.value)} placeholder="如:已了解需求,X 月 X 日启动实施" />
              </Field>
            )}
            <DialogFooter className="flex-wrap gap-2 sm:justify-between">
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => printDoc(title, html) || toast.error("浏览器拦截了弹出窗口,请允许后重试")}>
                  <Printer className="h-4 w-4 mr-2" />
                  打印
                </Button>
                <Button variant="outline" onClick={() => exportWord(`销售交接单-${h.handover_no}-${h.customer_name}`, title, html)}>
                  <Download className="h-4 w-4 mr-2" />
                  导出 Word
                </Button>
              </div>
              {h.status === "pending" && (
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => onEdit(h)}>
                    <Edit className="h-4 w-4 mr-2" />
                    编辑
                  </Button>
                  <Button onClick={() => receive.mutate()} disabled={receive.isPending}>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    实施部确认接收
                  </Button>
                </div>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function CrmHandovers() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Handover | null>(null);
  const [presetContract, setPresetContract] = useState<number | null>(null);
  const [viewId, setViewId] = useState<number | null>(null);

  useEffect(() => {
    const p = new URLSearchParams(search);
    const newC = Number(p.get("new"));
    const view = Number(p.get("view"));
    if (newC) {
      setEditing(null);
      setPresetContract(newC);
      setDialogOpen(true);
    }
    if (view) setViewId(view);
    if (newC || view) navigate("/crm/handovers", { replace: true });
  }, [search, navigate]);

  const { data, isLoading } = useQuery({
    queryKey: ["crm", "handovers", keyword, status, page],
    queryFn: () => crm<Paged<Handover>>(`/handovers${qs({ keyword, status: status === "all" ? "" : status, page })}`),
  });

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <PageHeader
          title="销售交接管理"
          description="把已签订的销售合同移交实施部,交接模块信息、主要需求、价值点与风险点"
          action={
            <Button
              onClick={() => {
                setEditing(null);
                setPresetContract(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              新建交接单
            </Button>
          }
        />

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="交接单号/合同编号/客户"
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
              { value: "pending", label: "待实施接收" },
              { value: "received", label: "实施已接收" },
            ]}
          />
        </div>

        <div className="rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-36">交接单号</TableHead>
                <TableHead className="w-36">合同编号</TableHead>
                <TableHead>客户</TableHead>
                <TableHead>项目名称</TableHead>
                <TableHead className="w-24">实施负责人</TableHead>
                <TableHead className="w-28">交接日期</TableHead>
                <TableHead className="w-28">状态</TableHead>
                <TableHead className="w-20" />
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
                    暂无交接单。合同签订后,可在合同详情中「移交实施」
                  </TableCell>
                </TableRow>
              )}
              {data?.items.map(h => (
                <TableRow key={h.id} className="cursor-pointer" onClick={() => setViewId(h.id)}>
                  <TableCell className="font-mono text-xs">{h.handover_no}</TableCell>
                  <TableCell className="font-mono text-xs">{h.contract_no}</TableCell>
                  <TableCell className="font-medium">{h.customer_name}</TableCell>
                  <TableCell>{h.project_name}</TableCell>
                  <TableCell>{h.impl_owner || "-"}</TableCell>
                  <TableCell>{h.handover_date}</TableCell>
                  <TableCell>
                    <StatusBadge map={HANDOVER_STATUS} status={h.status} />
                  </TableCell>
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
      </div>

      <HandoverDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        presetContractId={presetContract}
        onSaved={h => setViewId(h.id)}
      />
      <HandoverView
        id={viewId}
        onClose={() => setViewId(null)}
        onEdit={h => {
          setViewId(null);
          setEditing(h);
          setDialogOpen(true);
        }}
      />
    </DashboardLayout>
  );
}
