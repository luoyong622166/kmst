// 后台主题色:平台原版品牌红 → 蓝色。按深浅一一对应替换 client/src 下的颜色值(主题变量 + 少量写死的页面)。
// 幂等:替换过的文件再跑不会变化;平台界面重置后由 deploy.sh 重新应用。
//   node deploy/apply-theme.mjs [平台目录,默认 /opt/xiyejia-training]
import fs from "node:fs";
import path from "node:path";

const APP_DIR = process.argv[2] || "/opt/xiyejia-training";
const SRC = path.join(APP_DIR, "client", "src");

// [原红色, 蓝色] —— 从浅到深保持同样的层次
const COLOR_MAP = [
  [/#C0392B/gi, "#4096FF"], // 亮色 / 暗色模式主色
  [/#A52A2A/gi, "#1677FF"], // 品牌主色
  [/#8B1A1A/gi, "#0958D9"], // 深一档
  [/#7A1518/gi, "#003EB3"], // 最深(登录页渐变)
  [/rgba\(\s*165\s*,\s*42\s*,\s*42\s*,/gi, "rgba(22, 119, 255,"], // 主色半透明
  [/rgba\(\s*192\s*,\s*57\s*,\s*43\s*,/gi, "rgba(64, 150, 255,"], // 暗色模式半透明
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

let changed = 0;
for (const file of walk(SRC)) {
  const before = fs.readFileSync(file, "utf8");
  let after = before;
  for (const [re, to] of COLOR_MAP) after = after.replace(re, to);
  if (after !== before) {
    fs.writeFileSync(file, after);
    changed++;
    console.log("  换色", path.relative(APP_DIR, file));
  }
}
console.log(changed ? `==> 主题色已改为蓝色(${changed} 个文件)` : "==> 主题色已是蓝色,无需修改");
