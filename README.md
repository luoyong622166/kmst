# kmst · 销售管理模块

给学员平台(`/opt/xiyejia-training`)加的「销售管理」模块:**商机管理 → 客户跟进 → 销售合同 → 销售交接**。

## 功能

| 菜单 | 功能 |
|------|------|
| 商机管理 | 录入意向客户。对接天眼查/企查查取统一社会信用代码;信用代码按国标 GB 32100 校验,并按「信用代码 + 企业名」双重查重,一家企业只能有一条商机 |
| 客户跟进 | 销售选择阶段(初次拜访 / 需求分析 / 方案提供 / 商务谈判)后录入跟进内容;跟进推进到后面的阶段时,商机阶段自动前进 |
| 销售合同 | 选商机、填模块明细与金额,按公司合同模板一键生成合同(金额自动转大写);可预览、打印、导出 Word;确认签订后商机自动标为「已成交」。模板和我方信息在后台可改 |
| 销售交接 | 已签订合同移交实施部,交接单含模块信息、主要需求、主要交接的价值点、主要风险点;实施部在系统里确认接收 |

## 架构

平台规定不能改它的数据库表,界面也只能调它已有的接口,所以销售管理是一个**独立服务**:

```
浏览器 ──80──> nginx ─┬─ /sales-api/ ──> sales-crm (127.0.0.1:3100, Node 24 + 内置 SQLite)
                      └─ 其他        ──> 平台 (127.0.0.1:3000)
```

- 登录沿用后台账号:sales-crm 拿浏览器的 `app_session_id` Cookie 去平台 `auth.me` 核验身份。
- 数据库:`/var/lib/sales-crm/crm.db`,每天 02:30 备份到 `/var/backups/sales-crm/`(保留 30 份)。
- 界面:`ui/` 下的页面由 `deploy/apply-ui.mjs` 装进平台的 `client/`,再用平台的 `rebuild-ui.sh` 构建。

## 目录

```
sales-crm/            后端服务(零依赖)
  server.mjs          入口:HTTP + 登录校验
  lib/api.mjs         业务接口
  lib/db.mjs          表结构
  lib/contract.mjs    合同模板与渲染
  lib/lookup.mjs      天眼查/企查查
  lib/util.mjs        信用代码校验、金额大写
  backup.mjs          数据库备份
ui/client/src/        后台页面(React)
  pages/crm/*.tsx
  lib/crmApi.ts
deploy/
  deploy.sh           一键部署
  apply-ui.mjs        把页面/菜单/路由装进平台界面源码
  nginx-xiyejia.conf  nginx 配置
```

## 部署 / 更新

```bash
cd /root/kmst && git pull && bash deploy/deploy.sh
bash deploy/deploy.sh --skip-ui     # 只改了后端时用,不重建界面
```

平台升级或执行过 `update.sh --reset-ui` 后,界面会恢复官方版,重跑 `bash deploy/deploy.sh` 即可把销售管理装回去。

## 配置工商信息接口

编辑 `/etc/sales-crm.env`,填天眼查或企查查的密钥,然后 `pm2 restart sales-crm`:

```
TIANYANCHA_TOKEN=你的天眼查token
# 或
QICHACHA_KEY=你的企查查key
QICHACHA_SECRET=你的企查查secretKey
```

没配置时,新建商机需手动填写信用代码(仍会校验格式并查重)。

## 运维

```bash
pm2 logs sales-crm --lines 100 --nostream     # 日志
pm2 restart sales-crm                         # 重启
node /opt/sales-crm/backup.mjs                # 手动备份
```
