// 把销售管理界面装进平台后台源码(client/ + shared/),之后由平台的 rebuild-ui.sh 构建。
// 幂等:已打过补丁的文件会跳过;平台界面被 update.sh --reset-ui 重置后重跑即可恢复。
//   node deploy/apply-ui.mjs [平台目录,默认 /opt/xiyejia-training]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = process.argv[2] || "/opt/xiyejia-training";
const REPO_UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
const MARK = "[kmst-crm]";

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

function patch(rel, edits) {
  const file = path.join(APP_DIR, rel);
  let text = fs.readFileSync(file, "utf8");
  if (text.includes(MARK)) {
    console.log("  已打过补丁,跳过", rel);
    return;
  }
  const backup = `${file}.bak-kmst`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  // 平台源码是 CRLF 换行,锚点和插入内容跟随文件原有换行符
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  for (const edit of edits) {
    const anchor = edit.anchor.replace(/\n/g, eol);
    const insert = edit.insert.replace(/\n/g, eol);
    const where = edit.where;
    if (!text.includes(anchor)) throw new Error(`${rel} 找不到插入位置:${anchor.slice(0, 60)}(平台界面可能已升级,需要调整补丁)`);
    text = text.replace(anchor, where === "before" ? insert + anchor : anchor + insert);
  }
  fs.writeFileSync(file, text);
  if (fs.statSync(file).size === 0) throw new Error(`${rel} 写入后为空`);
  console.log("  已打补丁", rel);
}

console.log("==> 复制销售管理页面");
copyTree(REPO_UI, APP_DIR);

console.log("==> 注册路由 / 菜单 / 学员版可见性");
patch("client/src/App.tsx", [
  {
    anchor: 'import Home from "./pages/Home";\n',
    where: "after",
    insert: `// === 销售管理 ${MARK} ===
import CrmOpportunities from "./pages/crm/Opportunities";
import CrmFollowups from "./pages/crm/Followups";
import CrmContracts from "./pages/crm/Contracts";
import CrmHandovers from "./pages/crm/Handovers";
`,
  },
  {
    anchor: "      {/* === 系统管理 === */}\n",
    where: "before",
    insert: `      {/* === 销售管理 ${MARK} === */}
      <Route path="/crm/opportunities" component={CrmOpportunities} />
      <Route path="/crm/followups" component={CrmFollowups} />
      <Route path="/crm/contracts" component={CrmContracts} />
      <Route path="/crm/handovers" component={CrmHandovers} />
`,
  },
]);

patch("client/src/components/menuConfig.ts", [
  {
    anchor: '  MessageCircle,\n} from "lucide-react";',
    where: "before",
    insert: `  // ${MARK}
  Briefcase,
  Handshake,
  FileSignature,
  ClipboardCheck,
`,
  },
  {
    anchor: '      { icon: Sparkles, label: "内容生产 Agent", path: "/starter/content" },\n    ],\n  },\n',
    where: "after",
    insert: `  // === 销售管理 ${MARK}:商机 → 跟进 → 合同 → 交接(数据在独立服务 sales-crm) ===
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

patch("shared/editionProfiles.ts", [
  { anchor: '  | "starter_agents"\n', where: "after", insert: `  | "sales_mgmt" // ${MARK}\n` },
  {
    anchor: "  channel_gateway: M({\n",
    where: "before",
    insert: `  // ${MARK} 销售管理(商机/跟进/合同/交接)
  sales_mgmt: M({
    key: "sales_mgmt",
    group: "business",
    label: "销售管理",
    menuPaths: ["/crm/opportunities", "/crm/followups", "/crm/contracts", "/crm/handovers"],
    menuPrefixes: ["/crm/"],
  }),
`,
  },
]);

// 学员版 profile 加入 sales_mgmt 模块(单独处理:替换而非插入)
{
  const file = path.join(APP_DIR, "shared/editionProfiles.ts");
  const text = fs.readFileSync(file, "utf8");
  const from = 'modules: ["workbench", "tenant_center", "brain_config", "starter_agents", "products", "materials"],';
  const to = 'modules: ["workbench", "tenant_center", "brain_config", "starter_agents", "products", "materials", "sales_mgmt"],';
  if (text.includes(MARK) && text.includes(from)) {
    fs.writeFileSync(file, text.replace(from, to));
    console.log("  学员版已加入销售管理模块");
  } else if (!text.includes(to)) {
    throw new Error("shared/editionProfiles.ts 找不到学员版模块清单(平台界面可能已升级,需要调整补丁)");
  }
}

console.log("==> 完成");
