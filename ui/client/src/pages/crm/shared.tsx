/**
 * 销售管理模块公共组件:元数据、阶段标签、表单字段、模块明细编辑、商机选择、打印/导出
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { crm, qs, type ContractModule, type CrmMeta, type Opportunity, type Paged } from "@/lib/crmApi";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

export function useCrmMeta() {
  return useQuery({
    queryKey: ["crm", "meta"],
    queryFn: () => crm<CrmMeta>("/meta"),
    staleTime: 5 * 60_000,
  });
}

const STAGE_STYLE: Record<string, string> = {
  new: "bg-slate-100 text-slate-700 border-slate-200",
  initial_visit: "bg-sky-50 text-sky-700 border-sky-200",
  requirement: "bg-indigo-50 text-indigo-700 border-indigo-200",
  proposal: "bg-violet-50 text-violet-700 border-violet-200",
  negotiation: "bg-amber-50 text-amber-700 border-amber-200",
  won: "bg-emerald-50 text-emerald-700 border-emerald-200",
  lost: "bg-zinc-100 text-zinc-500 border-zinc-200",
};

export function stageLabel(meta: CrmMeta | undefined, key: string) {
  return meta?.stages.find(s => s.key === key)?.label ?? key;
}

export function StageBadge({ stage, meta }: { stage: string; meta: CrmMeta | undefined }) {
  return (
    <Badge variant="outline" className={cn("font-normal", STAGE_STYLE[stage])}>
      {stageLabel(meta, stage)}
    </Badge>
  );
}

export const CONTRACT_STATUS: Record<string, { label: string; className: string }> = {
  draft: { label: "草稿", className: "bg-slate-100 text-slate-700 border-slate-200" },
  signed: { label: "已签订", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  void: { label: "已作废", className: "bg-zinc-100 text-zinc-500 border-zinc-200 line-through" },
};

export const HANDOVER_STATUS: Record<string, { label: string; className: string }> = {
  pending: { label: "待实施接收", className: "bg-amber-50 text-amber-700 border-amber-200" },
  received: { label: "实施已接收", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
};

export function StatusBadge({ map, status }: { map: Record<string, { label: string; className: string }>; status: string }) {
  const s = map[status] ?? { label: status, className: "" };
  return (
    <Badge variant="outline" className={cn("font-normal", s.className)}>
      {s.label}
    </Badge>
  );
}

export function PageHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="text-muted-foreground mt-1">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function Field({
  label,
  required,
  hint,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label>
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {children}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function FilterChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          className={cn(
            "px-2.5 py-1 rounded text-xs transition-colors",
            value === o.value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
          )}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined && <span className="ml-1 opacity-70">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function fmtMoney(v: number | string | null | undefined) {
  if (v === null || v === undefined || v === "") return "-";
  const n = Number(v);
  return Number.isFinite(n) ? "¥" + n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-";
}

export function fmtTime(iso: string | null | undefined) {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN", { hour12: false });
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 模块明细编辑:合同(带金额)与交接单(不带金额)共用 */
export function ModulesEditor({
  value,
  onChange,
  withAmount,
}: {
  value: ContractModule[];
  onChange: (v: ContractModule[]) => void;
  withAmount?: boolean;
}) {
  const update = (i: number, patch: Partial<ContractModule>) => onChange(value.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  return (
    <div className="space-y-2">
      {value.map((m, i) => (
        <div key={i} className="flex gap-2 items-start">
          <span className="text-xs text-muted-foreground w-5 pt-2.5 text-right">{i + 1}</span>
          <Input className="w-40 shrink-0" placeholder="模块名称" value={m.name} onChange={e => update(i, { name: e.target.value })} />
          <Input className="flex-1" placeholder="功能说明" value={m.description} onChange={e => update(i, { description: e.target.value })} />
          {withAmount && (
            <Input
              className="w-32 shrink-0"
              type="number"
              min={0}
              placeholder="金额(元)"
              value={m.amount ?? ""}
              onChange={e => update(i, { amount: e.target.value })}
            />
          )}
          <Button type="button" variant="ghost" size="icon" onClick={() => onChange(value.filter((_, idx) => idx !== i))}>
            <Trash2 className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, { name: "", description: "", ...(withAmount ? { amount: "" } : {}) }])}>
        <Plus className="h-4 w-4 mr-1" />
        添加模块
      </Button>
    </div>
  );
}

/** 商机选择:输入关键字检索,下拉选择 */
export function OpportunitySelect({
  value,
  onChange,
  excludeStages = [],
  disabled,
}: {
  value: number | null;
  onChange: (id: number, opp: Opportunity) => void;
  excludeStages?: string[];
  disabled?: boolean;
}) {
  const [keyword, setKeyword] = useState("");
  const { data } = useQuery({
    queryKey: ["crm", "opportunities", "picker", keyword],
    queryFn: () => crm<Paged<Opportunity>>(`/opportunities${qs({ keyword, pageSize: 100 })}`),
  });
  const items = (data?.items ?? []).filter(o => !excludeStages.includes(o.stage) || o.id === value);
  return (
    <div className="flex gap-2">
      <Input className="w-36 shrink-0" placeholder="搜索企业" value={keyword} onChange={e => setKeyword(e.target.value)} disabled={disabled} />
      <Select
        value={value ? String(value) : undefined}
        onValueChange={v => {
          const opp = items.find(o => o.id === Number(v));
          if (opp) onChange(opp.id, opp);
        }}
        disabled={disabled}
      >
        <SelectTrigger className="flex-1">
          <SelectValue placeholder={items.length ? "选择商机(客户)" : "没有可选的商机"} />
        </SelectTrigger>
        <SelectContent>
          {items.map(o => (
            <SelectItem key={o.id} value={String(o.id)}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export const DOC_CSS = `
  body { font-family: "SimSun", "Songti SC", serif; font-size: 14px; line-height: 1.8; color: #000; max-width: 820px; margin: 24px auto; padding: 0 24px; }
  h1 { font-size: 22px; margin: 8px 0 16px; text-align: center; }
  h2 { font-size: 17px; margin: 18px 0 8px; }
  h3 { font-size: 15px; margin: 16px 0 6px; }
  p { margin: 6px 0; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; }
  table.parties td, table.sign td { padding: 4px 6px; vertical-align: top; }
  table.modules th, table.modules td, table.grid th, table.grid td { border: 1px solid #333; padding: 6px; }
  table.modules th, table.grid th { background: #f2f2f2; }
  table.grid th { width: 18%; text-align: left; }
  .pre { white-space: pre-wrap; }
`;

function fullDoc(title: string, bodyHtml: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${DOC_CSS}</style></head><body>${bodyHtml}</body></html>`;
}

/** 在 iframe 中预览的完整文档 */
export function docSrc(title: string, bodyHtml: string) {
  return fullDoc(title, bodyHtml);
}

export function printDoc(title: string, bodyHtml: string) {
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.write(fullDoc(title, bodyHtml));
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
  return true;
}

/** 导出为 Word 可直接打开的 .doc(HTML 格式) */
export function exportWord(filename: string, title: string, bodyHtml: string) {
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${title}</title><style>${DOC_CSS}</style></head><body>${bodyHtml}</body></html>`;
  const blob = new Blob(["﻿", html], { type: "application/msword" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename.endsWith(".doc") ? filename : `${filename}.doc`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function escapeHtml(s: string | null | undefined) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
