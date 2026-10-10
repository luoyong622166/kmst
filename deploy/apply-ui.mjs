// 把销售管理、实施管理界面装进平台后台源码(client/ + shared/),之后由平台的 rebuild-ui.sh 构建。
// 幂等:每组补丁带标记,已打过的跳过;平台界面被 update.sh --reset-ui 重置后重跑即可恢复。
//   node deploy/apply-ui.mjs [平台目录,默认 /opt/xiyejia-training]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = process.argv[2] || "/opt/xiyejia-training";
const REPO_UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
const CRM = "[kmst-crm]";
const IMPL = "[kmst-impl]";

function copyTree(src, dst) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else {
      fs.copyFileSync(s, d);
      console.log("  复制", path.relative(APP_DIR, d));
    }
  }
}

/** edits: [{ anchor, insert, where: "before" | "after" | "replace" }] */
function patch(rel, mark, edits) {
  const file = path.join(APP_DIR, rel);
  let text = fs.readFileSync(file, "utf8");
  if (text.includes(mark)) {
    console.log(`  ${mark} 已打过补丁,跳过`, rel);
    return;
  }
  const backup = `${file}.bak-kmst`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  // 平台源码是 CRLF 换行,锚点和插入内容跟随文件原有换行符
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  for (const edit of edits) {
    const anchor = edit.anchor.replace(/\n/g, eol);
    const insert = edit.insert.replace(/\n/g, eol);
    if (!text.includes(anchor)) throw new Error(`${rel} 找不到插入位置:${anchor.slice(0, 60)}(平台界面可能已升级,需要调整补丁)`);
    text = text.replace(anchor, edit.where === "before" ? insert + anchor : edit.where === "replace" ? insert : anchor + insert);
  }
  fs.writeFileSync(file, text);
  if (fs.statSync(file).size === 0) throw new Error(`${rel} 写入后为空`);
  console.log(`  ${mark} 已打补丁`, rel);
}

console.log("==> 复制页面");
copyTree(REPO_UI, APP_DIR);

console.log("==> 销售管理:路由 / 菜单 / 学员版可见性");
patch("client/src/App.tsx", CRM, [
  {
    anchor: 'import Home from "./pages/Home";\n',
    where: "after",
    insert: `// === 销售管理 ${CRM} ===
import CrmOpportunities from "./pages/crm/Opportunities";
import CrmFollowups from "./pages/crm/Followups";
import CrmContracts from "./pages/crm/Contracts";
import CrmHandovers from "./pages/crm/Handovers";
`,
  },
  {
    anchor: "      {/* === 系统管理 === */}\n",
    where: "before",
    insert: `      {/* === 销售管理 ${CRM} === */}
      <Route path="/crm/opportunities" component={CrmOpportunities} />
      <Route path="/crm/followups" component={CrmFollowups} />
      <Route path="/crm/contracts" component={CrmContracts} />
      <Route path="/crm/handovers" component={CrmHandovers} />
`,
  },
]);
patch("client/src/components/menuConfig.ts", CRM, [
  {
    anchor: '  MessageCircle,\n} from "lucide-react";',
    where: "before",
    insert: `  // ${CRM}
  Briefcase,
  Handshake,
  FileSignature,
  ClipboardCheck,
`,
  },
  {
    anchor: '      { icon: Sparkles, label: "内容生产 Agent", path: "/starter/content" },\n    ],\n  },\n',
    where: "after",
    insert: `  // === 销售管理 ${CRM}:商机 → 跟进 → 合同 → 交接(数据在独立服务 sales-crm) ===
  {
    icon: Briefcase,
    label: "销售管理",
    children: [
      { icon: Target, label: "商机管理", path: "/crm/opportunities" },
      { icon: Handshake, label: "客户跟进", path: "/crm/followups" },
      { icon: FileSignature, label: "销售合同", path: "/crm/contracts" },
      { icon: ClipboardCheck, label: "销售交接", path: "/crm/handovers" },
    ],
  },
`,
  },
]);
patch("shared/editionProfiles.ts", CRM, [
  { anchor: '  | "starter_agents"\n', where: "after", insert: `  | "sales_mgmt" // ${CRM}\n` },
  {
    anchor: "  channel_gateway: M({\n",
    where: "before",
    insert: `  // ${CRM} 销售管理(商机/跟进/合同/交接)
  sales_mgmt: M({
    key: "sales_mgmt",
    group: "business",
    label: "销售管理",
    menuPaths: ["/crm/opportunities", "/crm/followups", "/crm/contracts", "/crm/handovers"],
    menuPrefixes: ["/crm/"],
  }),
`,
  },
  {
    anchor: 'modules: ["workbench", "tenant_center", "brain_config", "starter_agents", "products", "materials"],',
    where: "replace",
    insert: 'modules: ["workbench", "tenant_center", "brain_config", "starter_agents", "products", "materials", "sales_mgmt"],',
  },
]);

console.log("==> 实施管理:路由 / 菜单 / 学员版可见性");
patch("client/src/App.tsx", IMPL, [
  {
    anchor: 'import CrmHandovers from "./pages/crm/Handovers";\n',
    where: "after",
    insert: `// === 实施管理 ${IMPL} ===
import ImplAssign from "./pages/impl/Assign";
import ImplMyProjects from "./pages/impl/MyProjects";
import ImplProjectDetail from "./pages/impl/ProjectDetail";
import ImplDirector from "./pages/impl/Director";
import ImplIssues from "./pages/impl/Issues";
`,
  },
  {
    anchor: '      <Route path="/crm/handovers" component={CrmHandovers} />\n',
    where: "after",
    insert: `      {/* === 实施管理 ${IMPL} === */}
      <Route path="/impl/assign" component={ImplAssign} />
      <Route path="/impl/my" component={ImplMyProjects} />
      <Route path="/impl/projects/:id" component={ImplProjectDetail} />
      <Route path="/impl/director" component={ImplDirector} />
      <Route path="/impl/issues" component={ImplIssues} />
`,
  },
]);
patch("client/src/components/menuConfig.ts", IMPL, [
  {
    anchor: "  ClipboardCheck,\n",
    where: "after",
    insert: `  // ${IMPL}
  Wrench,
  FolderKanban,
  ListChecks,
`,
  },
  {
    anchor: '      { icon: ClipboardCheck, label: "销售交接", path: "/crm/handovers" },\n    ],\n  },\n',
    where: "after",
    insert: `  // === 实施管理 ${IMPL}:分配 → 实施汇报 → 数字总监审核 → 问题清单 ===
  {
    icon: Wrench,
    label: "实施管理",
    children: [
      { icon: ClipboardList, label: "项目分配", path: "/impl/assign" },
      { icon: FolderKanban, label: "我的项目", path: "/impl/my" },
      { icon: Bot, label: "数字总监", path: "/impl/director" },
      { icon: ListChecks, label: "问题清单", path: "/impl/issues" },
    ],
  },
`,
  },
]);
patch("shared/editionProfiles.ts", IMPL, [
  { anchor: `  | "sales_mgmt" // ${CRM}\n`, where: "after", insert: `  | "impl_mgmt" // ${IMPL}\n` },
  {
    anchor: "  channel_gateway: M({\n",
    where: "before",
    insert: `  // ${IMPL} 实施管理(项目分配/实施汇报/数字总监/问题清单)
  impl_mgmt: M({
    key: "impl_mgmt",
    group: "business",
    label: "实施管理",
    menuPaths: ["/impl/assign", "/impl/my", "/impl/director", "/impl/issues"],
    menuPrefixes: ["/impl/"],
  }),
`,
  },
  { anchor: '"materials", "sales_mgmt"],', where: "replace", insert: '"materials", "sales_mgmt", "impl_mgmt"],' },
]);

console.log("==> 完成");
