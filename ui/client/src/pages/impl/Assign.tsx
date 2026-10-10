/**
 * 实施管理 · 项目分配(实施总监)
 * 路由: /impl/assign
 * 销售交接单 → 分配实施顾问、定实施完成时间与各阶段节点;管理全部项目与实施团队成员。
 */
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { crm } from "@/lib/crmApi";
import type { HandoverToAssign, ImplMember, ImplProject } from "@/lib/implApi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Search, Trash2, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Field, FilterChips, fmtMoney, PageHeader, today } from "../crm/shared";
import {
  DeadlineBadge,
  hasRole,
  NoAccess,
  PROJECT_STATUS,
  ProgressBar,
  splitStageDue,
  StageDueEditor,
  stageName,
  Tag,
  useImplMeta,
} from "./shared";

const ROLE_LABEL: Record<string, string> = { director: "实施总监", consultant: "实施顾问", gm: "总经理" };

function plusDays(d: string, n: number) {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function useMembers() {
  return useQuery({ queryKey: ["crm", "impl", "members"], queryFn: () => crm<{ items: ImplMember[] }>("/impl/members") });
}

type AssignTarget = { mode: "new"; handover: HandoverToAssign } | { mode: "edit"; project: ImplProject };

function AssignDialog({ target, onClose }: { target: AssignTarget | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: members } = useMembers();
  const consultants = (members?.items ?? []).filter(m => m.role === "consultant");
  const [name, setName] = useState("");
  const [consultantId, setConsultantId] = useState<number | null>(null);
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState("");
  const [due, setDue] = useState<Record<string, string>>({});
  const [remark, setRemark] = useState("");

  useEffect(() => {
    if (!target) return;
    if (target.mode === "new") {
      const h = target.handover;
      const s = today();
      const e = h.end_date && h.end_date > s ? h.end_date : plusDays(s, 60);
      setName(h.project_name);
      setConsultantId(null);
      setStart(s);
      setEnd(e);
      setDue(splitStageDue(s, e));
      setRemark("");
    } else {
      const p = target.project;
      setName(p.name);
      setConsultantId(p.consultant_id);
      setStart(p.planned_start);
      setEnd(p.planned_end);
      setDue(Object.fromEntries(p.stages.map(s => [s.stage_key, s.planned_end])));
      setRemark(p.remark ?? "");
    }
  }, [target]);

  const save = useMutation({
    mutationFn: () => {
      const body = { name, consultant_id: consultantId, planned_start: start, planned_end: end, stage_due: due, remark };
      return target?.mode === "edit"
        ? crm(`/impl/projects/${target.project.id}`, { method: "PUT", body })
        : crm("/impl/projects", { method: "POST", body: { ...body, handover_id: target?.mode === "new" ? target.handover.id : null } });
    },
    onSuccess: () => {
      toast.success(target?.mode === "edit" ? "项目已更新" : "项目已分配,已通知实施顾问");
      qc.invalidateQueries({ queryKey: ["crm"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const h = target?.mode === "new" ? target.handover : null;
  return (
    <Dialog open={!!target} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{target?.mode === "edit" ? `调整项目 ${target.project.project_no}` : "分配实施项目"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {h && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
              <div className="font-medium">
                {h.customer_name} · {h.project_name}
              </div>
              <div className="text-muted-foreground">
                交接单 {h.handover_no} · 合同 {h.contract_no} · {fmtMoney(h.amount)}
                {h.end_date ? ` · 合同服务期至 ${h.end_date}` : ""}
              </div>
              {!!h.modules.length && <div className="text-muted-foreground">模块:{h.modules.map(m => m.name).join("、")}</div>}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="项目名称" required>
              <Input value={name} onChange={e => setName(e.target.value)} />
            </Field>
            <Field label="实施顾问" required hint={!consultants.length ? "还没有实施顾问,请先在「团队成员」中添加" : undefined}>
              <Select value={consultantId ? String(consultantId) : undefined} onValueChange={v => setConsultantId(Number(v))}>
                <SelectTrigger>
                  <SelectValue placeholder="选择实施顾问" />
                </SelectTrigger>
                <SelectContent>
                  {consultants.map(c => (
                    <SelectItem key={c.user_id} value={String(c.user_id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="计划开始日期" required>
              <Input type="date" value={start} onChange={e => setStart(e.target.value)} />
            </Field>
            <Field label="要求实施完成日期" required>
              <Input type="date" value={end} onChange={e => setEnd(e.target.value)} />
            </Field>
          </div>
          <Field
            label="各阶段要求完成日期"
            required
            hint={
              <button type="button" className="text-primary hover:underline" onClick={() => start && end && setDue(splitStageDue(start, end))}>
                按开始/完成日期自动分配(15% / 30% / 30% / 25%)
              </button>
            }
          >
            <StageDueEditor value={due} onChange={setDue} />
          </Field>
          <Field label="备注 / 实施要求">
            <Textarea rows={2} value={remark} onChange={e => setRemark(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {target?.mode === "edit" ? "保存" : "分配并通知顾问"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PendingTab({ onAssign }: { onAssign: (h: HandoverToAssign) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["crm", "impl", "to-assign"],
    queryFn: () => crm<{ items: HandoverToAssign[] }>("/impl/handovers-to-assign"),
  });
  return (
    <div className="rounded-md border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-36">交接单号</TableHead>
            <TableHead>客户 / 项目</TableHead>
            <TableHead>模块</TableHead>
            <TableHead className="w-32 text-right">合同金额</TableHead>
            <TableHead className="w-28">交接日期</TableHead>
            <TableHead className="w-24" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={6} className="text-center py-10">
                <Loader2 className="h-5 w-5 animate-spin inline" />
              </TableCell>
            </TableRow>
          )}
          {!isLoading && !data?.items.length && (
            <TableRow>
              <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                没有待分配的项目。销售在「销售交接」提交交接单后会出现在这里
              </TableCell>
            </TableRow>
          )}
          {data?.items.map(h => (
            <TableRow key={h.id}>
              <TableCell className="font-mono text-xs">{h.handover_no}</TableCell>
              <TableCell>
                <div className="font-medium">{h.customer_name}</div>
                <div className="text-xs text-muted-foreground">{h.project_name}</div>
              </TableCell>
              <TableCell className="text-sm">{h.modules.map(m => m.name).join("、") || "-"}</TableCell>
              <TableCell className="text-right">{fmtMoney(h.amount)}</TableCell>
              <TableCell>{h.handover_date}</TableCell>
              <TableCell>
                <Button size="sm" onClick={() => onAssign(h)}>
                  分配
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ProjectsTab({ onEdit }: { onEdit: (p: ImplProject) => void }) {
  const [, navigate] = useLocation();
  const [status, setStatus] = useState("active");
  const [keyword, setKeyword] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["crm", "impl", "projects", "all", status, keyword],
    queryFn: () =>
      crm<{ items: ImplProject[] }>(
        `/impl/projects?scope=all${status === "overdue" ? "&overdue=1" : status !== "active" && status !== "all" ? `&status=${status}` : ""}${keyword ? `&keyword=${encodeURIComponent(keyword)}` : ""}`
      ),
  });
  const items = (data?.items ?? []).filter(p => status !== "active" || p.status !== "completed");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="项目/客户/顾问" value={keyword} onChange={e => setKeyword(e.target.value)} />
        </div>
        <FilterChips
          value={status}
          onChange={setStatus}
          options={[
            { value: "active", label: "进行中" },
            { value: "overdue", label: "超期" },
            { value: "assigned", label: "待接收" },
            { value: "completed", label: "已完成" },
            { value: "all", label: "全部" },
          ]}
        />
      </div>
      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">项目编号</TableHead>
              <TableHead>项目 / 客户</TableHead>
              <TableHead className="w-24">实施顾问</TableHead>
              <TableHead className="w-20">状态</TableHead>
              <TableHead className="w-44">进度</TableHead>
              <TableHead className="w-24">当前阶段</TableHead>
              <TableHead className="w-28">要求完成</TableHead>
              <TableHead className="w-36">期限</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin inline" />
                </TableCell>
              </TableRow>
            )}
            {!isLoading && !items.length && (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                  暂无项目
                </TableCell>
              </TableRow>
            )}
            {items.map(p => (
              <TableRow key={p.id} className="cursor-pointer" onClick={() => navigate(`/impl/projects/${p.id}`)}>
                <TableCell className="font-mono text-xs">{p.project_no}</TableCell>
                <TableCell>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.customer_name}</div>
                </TableCell>
                <TableCell>{p.consultant_name}</TableCell>
                <TableCell>
                  <Tag map={PROJECT_STATUS} value={p.status} />
                </TableCell>
                <TableCell>
                  <ProgressBar value={p.progress} danger={p.overdue_days > 0} />
                </TableCell>
                <TableCell>{p.current_stage ? stageName(p.current_stage) : "-"}</TableCell>
                <TableCell>{p.planned_end}</TableCell>
                <TableCell>
                  <DeadlineBadge p={p} />
                </TableCell>
                <TableCell onClick={e => e.stopPropagation()}>
                  {p.status !== "completed" && (
                    <Button variant="ghost" size="sm" onClick={() => onEdit(p)}>
                      调整/改派
                    </Button>
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

function MembersTab() {
  const qc = useQueryClient();
  const { data } = useMembers();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [role, setRole] = useState("consultant");
  const [userId, setUserId] = useState<number | null>(null);
  const [form, setForm] = useState({ username: "", password: "", name: "" });
  const { data: users } = useQuery({
    queryKey: ["crm", "impl", "platform-users"],
    queryFn: () => crm<{ items: { id: number; name: string; openId: string }[] }>("/impl/platform-users"),
    enabled: open,
  });

  const add = useMutation({
    mutationFn: () => {
      if (mode === "new") return crm("/impl/accounts", { method: "POST", body: { ...form, role } });
      const u = users?.items.find(x => x.id === userId);
      return crm("/impl/members", { method: "POST", body: { user_id: userId, name: u?.name, role } });
    },
    onSuccess: () => {
      toast.success(mode === "new" ? "账号已创建,对方可用此账号登录后台" : "成员已添加");
      qc.invalidateQueries({ queryKey: ["crm", "impl"] });
      setOpen(false);
      setForm({ username: "", password: "", name: "" });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => crm(`/impl/members/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("已移出实施团队(平台账号保留)");
      qc.invalidateQueries({ queryKey: ["crm", "impl"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">实施顾问只能看到分配给自己的项目;总经理接收数字总监提交的问题清单。平台管理员 admin 拥有全部角色。</p>
        <Button onClick={() => setOpen(true)}>
          <UserPlus className="h-4 w-4 mr-2" />
          添加成员
        </Button>
      </div>
      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>姓名</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>加入时间</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {!data?.items.length && (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-10 text-muted-foreground">
                  还没有成员,先添加实施顾问
                </TableCell>
              </TableRow>
            )}
            {data?.items.map(m => (
              <TableRow key={m.user_id}>
                <TableCell className="font-medium">{m.name}</TableCell>
                <TableCell>{ROLE_LABEL[m.role]}</TableCell>
                <TableCell>{new Date(m.created_at).toLocaleDateString("zh-CN")}</TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      if (window.confirm(`把 ${m.name} 移出实施团队?`)) remove.mutate(m.user_id);
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>添加实施团队成员</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <FilterChips
              value={mode}
              onChange={setMode}
              options={[
                { value: "new", label: "新建登录账号" },
                { value: "existing", label: "选择已有账号" },
              ]}
            />
            <Field label="角色" required>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(ROLE_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {mode === "new" ? (
              <>
                <Field label="姓名" required>
                  <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
                </Field>
                <Field label="登录账号" required>
                  <Input value={form.username} onChange={e => setForm({ ...form, username: e.target.value.trim() })} placeholder="字母或数字,如 zhangsan" />
                </Field>
                <Field label="初始密码" required hint="至少 6 位,把账号密码告诉对方,登录 http://服务器地址/ 即可">
                  <Input value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
                </Field>
              </>
            ) : (
              <Field label="平台账号" required>
                <Select value={userId ? String(userId) : undefined} onValueChange={v => setUserId(Number(v))}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择账号" />
                  </SelectTrigger>
                  <SelectContent>
                    {users?.items.map(u => (
                      <SelectItem key={u.id} value={String(u.id)}>
                        {u.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={() => add.mutate()} disabled={add.isPending}>
              {add.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              <Plus className="h-4 w-4 mr-1" />
              添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function ImplAssign() {
  const { data: meta, isLoading } = useImplMeta();
  const [target, setTarget] = useState<AssignTarget | null>(null);
  return (
    <DashboardLayout>
      <div className="space-y-4">
        <PageHeader title="项目分配" description="实施总监把销售交接过来的项目分配给实施顾问,明确实施完成时间与各阶段节点" />
        {isLoading ? null : !hasRole(meta, "director") ? (
          <NoAccess text="项目分配仅实施总监可用" />
        ) : (
          <Tabs defaultValue="pending">
            <TabsList>
              <TabsTrigger value="pending">待分配</TabsTrigger>
              <TabsTrigger value="projects">全部项目</TabsTrigger>
              <TabsTrigger value="members">团队成员</TabsTrigger>
            </TabsList>
            <TabsContent value="pending" className="mt-4">
              <PendingTab onAssign={h => setTarget({ mode: "new", handover: h })} />
            </TabsContent>
            <TabsContent value="projects" className="mt-4">
              <ProjectsTab onEdit={p => setTarget({ mode: "edit", project: p })} />
            </TabsContent>
            <TabsContent value="members" className="mt-4">
              <MembersTab />
            </TabsContent>
          </Tabs>
        )}
      </div>
      <AssignDialog target={target} onClose={() => setTarget(null)} />
    </DashboardLayout>
  );
}
